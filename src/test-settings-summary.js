import { pronetaSelectionLabel } from "./proneta-selection-labels.js";

const switchValues = new Map([
  ["1", true], ["true", true], ["enabled", true], ["on", true], ["yes", true],
  ["0", false], ["false", false], ["disabled", false], ["off", false], ["no", false],
]);
const diagnosticLabels = new Map([
  ["no supply voltage l+", "Supply voltage"],
  ["missing supply voltage l+", "Supply voltage"],
  ["short circuit to ground", "Short to ground"],
  ["short circuit to l+", "Short to L+"],
  ["hart", "HART"],
]);
// Siemens ET 200SP equipment manuals A5E51323262, A5E34941201 and A5E50743776.
const diagnosticPurposes = [
  ["Wire break", "Detects broken wiring or a disconnected device."],
  ["Short to ground", "Detects a short from the field wiring to ground."],
  ["Short to L+", "Detects a short to the positive DC supply."],
  ["Short circuit", "Flags an unintended low-resistance path in the field wiring."],
  ["Supply voltage", "Flags missing or low DC power at the module."],
  ["Overflow", "Flags a reading above the module's measurable range."],
  ["Underflow", "Flags a reading below the module's measurable range."],
  ["HART", "Flags device or communication faults in HART mode."],
  ["Undervoltage", "Flags a supply voltage below the module's minimum."],
  ["Reference junction", "Flags a fault in the thermocouple's reference temperature measurement."],
];
const functionOrder = ["Valve commands", "Valve feedback", "Positioner feedback", "Pressure inputs", "Temperature inputs"];
const diagnosticName = name => /^\s*(?:group )?diagnostics?:\s*(\S.*?)\s*$/i.exec(name)?.[1];
const measurementField = name => /^\s*(?:type\/range of measurement|measurement range)\s*$/i.test(name);
const temperatureUnitField = name => /^\s*temperature unit\s*$/i.test(name);

function selectedValue(parameter, module) {
  const recorded = parameter.value ?? parameter.rawValue;
  const value = String(pronetaSelectionLabel(module?.orderNumber, parameter.enumId, recorded) ?? recorded ?? "").trim();
  return value && parameter.unit && !value.includes(parameter.unit) ? `${value} ${parameter.unit}` : value;
}

function switchSetting(parameter, module) {
  const value = selectedValue(parameter, module);
  if (/^[01]$/.test(value) && parameter.dataType && !/^(?:bit|bool|boolean)$/i.test(parameter.dataType)) return value;
  return switchValues.get(value.toLowerCase()) ?? (value || null);
}

function diagnosticSettings(parameters, module) {
  const diagnostics = new Map();
  for (const parameter of parameters) {
    const name = diagnosticName(parameter.name);
    if (!name) continue;
    const key = name.toLowerCase().replaceAll("-", " ");
    diagnostics.set(diagnosticLabels.get(key) ?? `${key[0].toUpperCase()}${key.slice(1)}`,
      switchSetting(parameter, module));
  }
  return diagnostics;
}

function moduleFunction(channels, module) {
  const roles = channels.map(channel => channel.role || "");
  const valve = channels.every(channel => /^V\s*-/i.test(channel.symbolicName));
  if (roles.every(role => /positioner/i.test(role))) return "Positioner feedback";
  if (valve && roles.every(role => /feedback$/i.test(role))) return "Valve feedback";
  if (roles.every(role => /rtd|temperature|thermocouple/i.test(role))) return "Temperature inputs";
  if (channels.every(channel => /^(?:PD|DP)-/i.test(channel.symbolicName))) return "Pressure inputs";
  if (valve && roles.every(role => /command$/i.test(role))) return "Valve commands";
  if (/\bDQ\b/i.test(module?.name || "")) return "Digital outputs";
  if (/\bDI\b/i.test(module?.name || "")) return "Digital inputs";
  if (/\bAI\b/i.test(module?.name || "")) return "Analog inputs";
  return module?.name || "I/O channels";
}

function signalSetting(parameters, module) {
  const range = parameters.find(parameter => measurementField(parameter.name));
  const selected = range && selectedValue(range, module);
  if (/^input deactivated$/i.test(selected)) return selected;
  const unit = parameters.find(parameter => temperatureUnitField(parameter.name));
  const temperatureUnit = unit && selectedValue(unit, module);
  if (selected || temperatureUnit) return [selected, temperatureUnit].filter(Boolean).join(", ");
  const voltage = /\bDQ\s+\d+\s*x\s*(\d+(?:\.\d+)?)\s*V\s*DC\b/i.exec(module?.name || "")?.[1];
  return voltage ? `${voltage} V DC digital output` : "";
}

function settingGroups(items, valueFor) {
  const groups = new Map();
  for (const item of items) {
    const value = valueFor(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return [...groups].sort(([, left], [, right]) => right.length - left.length);
}

function moduleLocations(modules) {
  return settingGroups(modules, module => module.station).sort(([left], [right]) => left.localeCompare(right)).map(([station, entries]) => {
    const slots = entries.map(module => module.slot).sort((left, right) => Number(left) - Number(right));
    return `${station} ${slots.length === 1 ? "slot" : "slots"} ${slots.join(", ")}`;
  }).join("\n");
}

function settingLocations(entries) {
  return settingGroups(entries, entry => entry.module).map(([module, affected]) => {
    const location = `${module.station} slot ${module.slot}`;
    if (affected.length === module.entries.length) return location;
    return affected.map(({ channel }) => [location, channel.channel == null ? "" : `Channel ${channel.channel}`,
      channel.symbolicName].filter(Boolean).join(" | ")).join("\n");
  }).join("\n");
}

export function summarizeTestSettings(run) {
  const stations = new Map((run.stations || []).map(station => [station.id, station]));
  const channels = [...run.devices.flatMap(device => device.channels), ...(run.unassignedChannels || [])];
  const modules = new Map();
  for (const channel of channels) {
    const key = JSON.stringify([channel.stationId, channel.slot]);
    if (!modules.has(key)) modules.set(key, []);
    modules.get(key).push(channel);
  }
  const families = new Map();
  for (const [key, members] of modules) {
    const { stationId, slot } = members[0];
    const station = stations.get(stationId);
    const module = station?.modules?.find(item => item.slot === slot);
    const parameters = module?.parameters || [];
    const shared = diagnosticSettings(parameters, module);
    const stationLabel = station?.name || stationId || "Unknown station";
    const location = { station: stationLabel.replace(/^rio-[a-z]$/i, name => name.toUpperCase()), slot: slot ?? "unspecified" };
    location.entries = members.map(channel => {
      const settings = channel.parameters || [];
      const signal = signalSetting(settings, module);
      const activation = settings.find(parameter => /^activated$/i.test(parameter.name));
      const disabled = /^input deactivated$/i.test(signal) || (activation && switchSetting(activation, module) === false);
      return { module: location, channel, signal, disabled, diagnostics: new Map([...shared, ...diagnosticSettings(settings, module)]) };
    });
    if (!shared.size && !members.some(channel => (channel.parameters || []).some(parameter =>
      measurementField(parameter.name) || temperatureUnitField(parameter.name) || diagnosticName(parameter.name)))) continue;
    const purpose = moduleFunction(members, module);
    const familyKey = JSON.stringify([purpose, module?.orderNumber?.replace(/\s+/g, "").toUpperCase() || module?.name || key]);
    const capacity = Number(/\b(?:AI|AQ|DI|DQ)\s+(\d+)\s*x/i.exec(module?.name || "")?.[1]);
    location.capacity = capacity >= location.entries.length ? capacity : null;
    if (!families.has(familyKey)) families.set(familyKey, { purpose, modules: [] });
    families.get(familyKey).modules.push(location);
  }

  const rows = [], differences = [];
  const listedDiagnostics = new Set();
  const rank = purpose => functionOrder.includes(purpose) ? functionOrder.indexOf(purpose) : functionOrder.length;
  const ordered = [...families.values()].sort((left, right) => rank(left.purpose) - rank(right.purpose));
  for (const { purpose, modules: locations } of ordered) {
    const assigned = locations.flatMap(module => module.entries);
    const entries = assigned.filter(entry => !entry.disabled);
    const disabled = assigned.filter(entry => entry.disabled);
    if (disabled.length) differences.push([settingLocations(disabled), "Channel activation", "Off"]);
    const capacity = locations.every(module => module.capacity !== null)
      ? locations.reduce((total, module) => total + module.capacity, 0) : null;
    const signals = settingGroups(entries, entry => entry.signal);
    const primary = signals.find(([signal]) => signal);
    const signal = primary ? `${primary[0]}${signals.length === 1 ? "" : `\n${primary[1].length} of ${entries.length} channels`}` : "—";
    for (const [value, affected] of signals) {
      if (primary && value !== primary[0]) differences.push([settingLocations(affected), "Signal range", value || "Not recorded"]);
    }
    const commonDiagnostics = [];
    for (const name of new Set(entries.flatMap(entry => [...entry.diagnostics.keys()]))) {
      if (entries.every(entry => entry.diagnostics.get(name) === true)) {
        commonDiagnostics.push(name);
        listedDiagnostics.add(name);
      } else {
        const values = settingGroups(entries, entry => entry.diagnostics.get(name) ?? null);
        if (values.length === 1 && typeof values[0][0] !== "string") continue;
        listedDiagnostics.add(name);
        for (const [value, affected] of values) {
          if (value === true && values.every(([other]) => typeof other === "boolean")) continue;
          const selected = value === true ? "On" : value === false ? "Off" : value || "Not recorded";
          const compare = value === false && values.length === 2 && values.some(([other]) => other === true)
            ? " (on for the other channels in this group)" : "";
          differences.push([settingLocations(affected), name === "HART" ? "HART diagnostics setting" : `${name} monitoring`, selected + compare]);
        }
      }
    }
    rows.push([purpose, moduleLocations(locations), capacity ? `${entries.length} of ${capacity}` : String(entries.length),
      signal, commonDiagnostics.join(", ") || "—"]);
  }
  const guide = diagnosticPurposes.filter(([name]) => listedDiagnostics.has(name));
  return { rows, differences, guide };
}
