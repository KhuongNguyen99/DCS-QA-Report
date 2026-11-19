/** Return the catalog devices assigned to one terminal, or all devices. */
export function groupDevices(devices, terminal = null) {
  if (terminal == null) return devices;
  const selected = String(terminal).trim().toUpperCase();
  return devices.filter((device) => device.terminal === selected);
}

/** Search scheduled devices for manual selection; never create a new device. */
export function findManualDevices(text, devices) {
  const compact = (value) =>
    String(value)
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[‐‑‒–—―−﹣－\s-]/g, "");
  const query = compact(text);
  if (!query) return devices;
  const recognized = new Set(
    matchDeviceLabels(text, devices).map((match) => match.deviceId),
  );
  return devices.filter(
    (device) =>
      compact(device.name).includes(query) || recognized.has(device.id),
  );
}

/** Stable keys shared by device and terminal QC records. */
export function recordKey(kind, id) {
  if (kind === "device") return `device:${id}`;
  if (kind === "terminal") return `terminal:${String(id).trim().toUpperCase()}`;
  if (kind === "equipment") return `equipment:${id}`;
  throw new RangeError(`Unknown record kind: ${kind}`);
}

/** Shared inspection catalog; field-device OCR remains limited to devices. */
export function inspectionTargets(schedule) {
  return [
    ...(schedule.equipment || []).map((item) => ({
      ...item, key: recordKey("equipment", item.id), kind: "equipment",
      terminal: null, cables: [],
    })),
    ...schedule.groups.flatMap((group) => [
      {
        id: group.id, key: recordKey("terminal", group.id), kind: "terminal",
        name: `Terminal ${group.id}`, terminal: group.id, cables: [], color: group.color,
      },
      ...groupDevices(schedule.devices, group.id).map((device) => ({
        ...device, key: recordKey("device", device.id), kind: "device",
        color: group.color, device,
      })),
    ]),
  ];
}

// A leading O/0 or one trailing letter/# is tolerated as OCR noise, but never
// promoted to an exact match. The numeric run is deliberately unbounded so a
// five-digit ID is rejected instead of being truncated to a four-digit tag.
const TAG =
  /(^|[^A-Z0-9])([O0]?)(TH|V|PD|DP)[\s-]*([0-9OIL]{4,})(?:\s*#[ \t]*([0-9IL]+)|[\s-]*(Y))?([A-Z#]?)(?=$|[^A-Z0-9])/g;
// Find a tag stem inside a larger OCR token. These matches are always possible,
// because surrounding letters may belong to an unrelated word or label.
const EMBEDDED_TAG =
  /(TH|V|PD|DP)[\s-]*([0-9OIL]{4})(?![0-9])(?:[ \t]*#[ \t]*([0-9IL]+)|[\s-]*(Y))?/g;

function catalogKey(name) {
  const canonical = /^([A-Z]+)-?(\d{4})(#\d+|-Y)?$/.exec(name.toUpperCase());
  if (!canonical) throw new Error(`Invalid catalog device name: ${name}`);
  return `${canonical[1]}${canonical[2]}${canonical[3] ?? ""}`;
}

/**
 * Find schedule device tags in OCR or pasted text.
 *
 * Exact means a full, unambiguous tag with only case/spacing/hyphen changes.
 * OCR substitutions, stray adjacent characters, and bare numbered families
 * are possible matches that require human review.
 */
export function matchDeviceLabels(text, devices, terminal = null) {
  if (!text) return [];
  const catalog = groupDevices(devices, terminal);
  const byKey = new Map(
    catalog.map((device) => [catalogKey(device.name), device]),
  );
  const matches = new Map();
  const original = String(text).normalize("NFKC");
  // OCR and copied labels often use typographic dashes. Keep offsets stable so
  // matchedText still reflects the source while parsing every dash as a hyphen.
  const source = original.replace(/[‐‑‒–—―−﹣－]/g, "-");
  const scanner = new RegExp(TAG.source, "gi");

  function addMatch(stem, suffix, matchedText, confidence) {
    let candidates;
    if (suffix) {
      const device = byKey.get(stem + suffix);
      candidates = device ? [device] : [];
    } else {
      const device = byKey.get(stem);
      candidates = device
        ? [device]
        : catalog.filter((item) =>
            catalogKey(item.name).startsWith(`${stem}#`),
          );
      if (!device) confidence = "possible";
    }
    for (const device of candidates) {
      const prior = matches.get(device.id);
      if (
        !prior ||
        (prior.confidence === "possible" && confidence === "exact")
      ) {
        matches.set(device.id, {
          deviceId: device.id,
          matchedText,
          confidence,
        });
      }
    }
  }

  for (const found of source.matchAll(scanner)) {
    const [
      ,
      boundary,
      leadingNoise,
      prefix,
      rawNumber,
      rawIndex,
      ySuffix,
      trailingNoise,
    ] = found;
    if (rawNumber.length !== 4 || (rawIndex && rawIndex.length !== 1)) continue;
    const upperNumber = rawNumber.toUpperCase();
    const number = upperNumber.replaceAll("O", "0").replaceAll(/[IL]/g, "1");
    const upperIndex = rawIndex?.toUpperCase();
    const index = upperIndex?.replaceAll(/[IL]/g, "1");
    const stem = `${prefix.toUpperCase()}${number}`;
    const suffix = rawIndex ? `#${index}` : ySuffix ? "-Y" : "";
    // A failed suffix parse must not turn an extended tag into an exact bare tag.
    if (!suffix && /^[-#]/.test(source.slice(found.index + found[0].length)))
      continue;
    const hasOcrNoise = Boolean(
      leadingNoise ||
      trailingNoise ||
      /[OIL]/.test(upperNumber + (upperIndex ?? "")),
    );
    const matchedText = original.slice(
      found.index + boundary.length,
      found.index + found[0].length,
    );
    addMatch(stem, suffix, matchedText, hasOcrNoise ? "possible" : "exact");
  }

  for (const found of source.matchAll(new RegExp(EMBEDDED_TAG.source, "gi"))) {
    const [, prefix, rawNumber, rawIndex, ySuffix] = found;
    if (rawIndex?.length > 1) continue;
    const matchEnd = found.index + found[0].length;
    // A numeric continuation or unrecognized explicit suffix cannot turn into
    // a match for the shorter bare device.
    if (
      /^[0-9]/.test(source.slice(matchEnd)) ||
      (!rawIndex && !ySuffix && /^[-#]/.test(source.slice(matchEnd)))
    )
      continue;
    let start = found.index;
    let end = matchEnd;
    while (start > 0 && /[A-Z]/i.test(source[start - 1])) start -= 1;
    while (end < source.length && /[A-Z]/i.test(source[end])) end += 1;
    if (start === found.index && end === matchEnd) continue;
    if (/^[0-9]/.test(source.slice(end))) continue;
    const number = rawNumber
      .toUpperCase()
      .replaceAll("O", "0")
      .replaceAll(/[IL]/g, "1");
    const index = rawIndex?.toUpperCase().replaceAll(/[IL]/g, "1");
    const suffix = rawIndex ? `#${index}` : ySuffix ? "-Y" : "";
    addMatch(
      `${prefix.toUpperCase()}${number}`,
      suffix,
      original.slice(start, end),
      "possible",
    );
  }

  return [...matches.values()];
}
