/**
 * PRONETA Basic import. A test result is an operator-entered result; an I/O log
 * is a list of changes, not sampled telemetry and never evidence of a pass.
 * No source files are uploaded or executable spreadsheet expressions evaluated.
 */
export const PRONETA_LIMITS = Object.freeze({
  files: 20,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 30 * 1024 * 1024,
  payloadBytes: 4 * 1024 * 1024,
  stations: 64,
  modules: 256,
  devices: 250,
  channels: 500,
  events: 10000,
  parametersPerChannel: 200,
});

export class PronetaImportError extends Error {
  constructor(message, code = 'INVALID_SOURCE', details = {}) {
    super(message);
    this.name = 'PronetaImportError';
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (message, code, details) => { throw new PronetaImportError(message, code, details); };
const clean = (value) => String(value ?? '').trim();
const normalizeSymbol = (value) => clean(value).replace(/\s+/g, '').toUpperCase();
const stationKey = (value) => clean(value).toLowerCase().replace(/[\s_]+/g, '-');
const isUnassigned = (value) => /^(?:n\s*[/\.]?\s*a\.?|not applicable|-)$/i.test(clean(value)) || !clean(value);
const positionKey = (slot, channel) => `${slot}:${channel}`;
const finiteInteger = (value, label, max = 65535) => {
  const text = clean(value);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > max) fail(`Invalid ${label}: ${text}.`);
  return Number(text);
};

function warningCollector() {
  const warnings = [];
  const seen = new Set();
  let omitted = 0;
  return {
    add(message) {
      if (seen.has(message)) return;
      seen.add(message);
      if (warnings.length < 100) warnings.push(message);
      else omitted += 1;
    },
    finish() {
      return omitted ? [...warnings, `${omitted} additional import warnings; review the retained source rows and invalid observations.`] : warnings;
    },
  };
}

/** The suffix is a station hint, not proof that two files belong together. */
export function inferPronetaStationName(name) {
  return clean(name).replace(/^.*[\\/]/, '').replace(/\.(?:csv|mpr|xml)$/i, '')
    .replace(/[-_\s]+(?:log|parameters?)$/i, '').trim();
}

/** Recognize content rather than trusting a file extension. */
export function identifyPronetaSource(name, input) {
  if (typeof name === 'object' && name !== null) {
    input = name.text;
    name = name.name;
  }
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const first = text.slice(0, 8192);
  let kind;
  if (/^\s*(?:<\?xml[^>]*>\s*)?<SerializableCollectionOfIModule(?:\s|>)/i.test(first)) kind = 'parameters';
  else if (/Test Results of Station\s+/i.test(first)) kind = 'results';
  else if (/^\s*(?:="|"|)?Slot(?:"|)?\s*[,;\t]/im.test(first) && /Time Stamp/i.test(first)) kind = 'log';
  else fail(`${name || 'File'} is not a supported PRONETA test-result CSV, I/O log CSV, or parameter .mpr file.`);
  return { name: clean(name), kind, stationHint: inferPronetaStationName(name) };
}

/**
 * CSV with standard quoting and PRONETA's Excel literal cells (="text").
 * Physical source line numbers survive quoted multiline fields.
 */
export function parsePronetaCsv(input, delimiter = ',') {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let cells = [], cell = '', quoted = false, closed = false;
  let line = 1, rowLine = 1;
  const pushCell = () => {
    if (cell.length > 100000) fail(`CSV field at line ${rowLine} exceeds 100,000 characters.`, 'LIMIT_EXCEEDED');
    // Also accept a conventional quoted CSV cell containing an Excel literal.
    if (/^="[\s\S]*"$/.test(cell)) cell = cell.slice(2, -1).replace(/""/g, '"');
    cells.push(cell);
    if (cells.length > 64) fail(`Too many CSV columns at line ${rowLine}.`, 'LIMIT_EXCEEDED');
    cell = ''; closed = false;
  };
  const pushRow = () => {
    pushCell();
    if (cells.some((value) => clean(value))) rows.push({ cells, sourceRow: rowLine });
    cells = [];
    if (rows.length > 20000) fail('A CSV contains more than 20,000 rows.', 'LIMIT_EXCEEDED');
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        cell += '\n'; line += 1;
      } else cell += char;
      continue;
    }
    if (char === delimiter) { pushCell(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRow(); line += 1; rowLine = line;
      continue;
    }
    if (!cell && !closed && (char === '"' || (char === '=' && text[i + 1] === '"'))) {
      if (char === '=') i += 1;
      quoted = true;
      continue;
    }
    if (closed) {
      if (/\s/.test(char)) continue;
      fail(`Unexpected character after a quoted CSV field at line ${line}.`);
    }
    cell += char;
  }
  if (quoted) fail(`Unclosed CSV quote beginning at line ${rowLine}.`);
  if (cells.length || cell || closed) pushRow();
  return rows;
}

function csvRows(text) {
  const header = text.split(/\r?\n/).slice(0, 4).find((line) => /(?:Slot|Symbolic Name)/i.test(line)) || '';
  const delimiter = /(?:Slot|Channel)(?:"|)?\s*;/i.test(header) ? ';' : /\t/.test(header) ? '\t' : ',';
  return parsePronetaCsv(text, delimiter);
}

/**
 * Naive timestamps are coordinates on the source's wall clock, represented with
 * UTC components to avoid the browser's timezone/DST changing their spacing.
 * The result explicitly distinguishes these from timestamps with a real offset.
 */
export function parsePronetaTimestamp(input, { dateFormat = 'auto' } = {}) {
  const text = clean(input);
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  let year, month, day, hour, minute, second, millis, zone;
  if (match) [, year, month, day, hour, minute, second, millis, zone] = match;
  else {
    match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
    if (!match) return null;
    let first, next;
    [, first, next, year, hour, minute, second, millis, zone] = match;
    if (dateFormat === 'dmy' || (dateFormat === 'auto' && Number(first) > 12)) [day, month] = [first, next];
    else if (dateFormat === 'mdy' || (dateFormat === 'auto' && Number(next) > 12)) [month, day] = [first, next];
    else return null; // Ambiguous dates need a deliberate date-format selection.
  }
  [year, month, day, hour, minute, second] = [year, month, day, hour, minute, second].map(Number);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  let timeMs = Date.UTC(year, month - 1, day, hour, minute, second, Number((millis || '').padEnd(3, '0')));
  const date = new Date(timeMs);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.replace(':', '').slice(1);
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes)) return null;
    timeMs -= (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000;
  }
  return { time: text, timeMs, basis: zone ? 'absolute' : 'source-local' };
}

export function normalizePronetaStatus(input) {
  const value = clean(input).toLowerCase();
  if (/^(?:ok|pass|passed)$/.test(value)) return 'Passed';
  if (/^(?:error|fail|failed)$/.test(value)) return 'Failed';
  if (/^(?:n\s*\.?\s*[/.]?\s*a\s*\.?|not applicable)$/.test(value)) return 'Not applicable';
  return 'Not tested';
}

export function groupPronetaDeviceName(symbolicName, moduleName = '') {
  const symbol = normalizeSymbol(symbolicName);
  const match = symbol.match(/^((?:V|TH|PD|DP)-\d{4}(?:#\d+|-Y)?)(?:[-_](FB|POS)|-(OPEN|CLOSE)(?:[-_](FB))?)?$/);
  let role = /(?:^|[-\s])(?:DQ|AQ)\b/i.test(moduleName) ? 'Command' : 'Input';
  if (/^TH-/.test(symbol)) role = 'RTD';
  if (/^(?:PD|DP)-/.test(symbol)) role = 'Transducer';
  if (match?.[2] === 'POS') role = 'Positioner';
  else if (match?.[2] === 'FB') role = 'Feedback';
  else if (match?.[3]) role = `${match[3] === 'OPEN' ? 'Open' : 'Close'} ${match[4] ? 'feedback' : 'command'}`;
  return { name: match ? match[1] : symbol, role };
}

function aggregateStatus(statuses) {
  if (statuses.includes('Failed')) return 'Failed';
  const applicable = statuses.filter((status) => status !== 'Not applicable');
  return applicable.length && applicable.every((status) => status === 'Passed') ? 'Passed' : 'Not tested';
}

async function readSource(file, index) {
  const name = clean(file?.name);
  if (!name || name.length > 255) fail('Every selected file needs a filename of at most 255 characters.');
  if (Number(file.size) > PRONETA_LIMITS.fileBytes) fail(`${name} exceeds the 10 MiB file limit.`, 'LIMIT_EXCEEDED');
  let bytes;
  if (typeof file.arrayBuffer === 'function') bytes = new Uint8Array(await file.arrayBuffer());
  else {
    const text = typeof file.text === 'function' ? await file.text() : file.text;
    if (typeof text !== 'string') fail(`${name} cannot be read.`);
    bytes = new TextEncoder().encode(text);
  }
  if (!bytes.byteLength || bytes.byteLength > PRONETA_LIMITS.fileBytes) fail(`${name} is empty or exceeds the 10 MiB file limit.`, 'LIMIT_EXCEEDED');
  let text;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { fail(`${name} is not valid UTF-8 or BOM-marked UTF-16 text. Re-export it using a Unicode encoding.`); }
  if (!globalThis.crypto?.subtle) fail('Secure file hashing is unavailable. Open this application using HTTPS or localhost.');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
  const identity = identifyPronetaSource(name, text);
  return { ...identity, id: `source-${index + 1}`, size: bytes.byteLength, sha256, text, index, stationId: '' };
}

function parseResultSource(source, warn) {
  const rows = csvRows(source.text);
  const stationHeader = rows.find((row) => /^Test Results of Station\s+/i.test(row.cells[0]));
  const header = stationHeader?.cells[0].match(/^Test Results of Station\s+(.+?)\s*\(\s*MAC Address:\s*([^;)]*);\s*Serial Number:\s*([^)]*)\)\s*$/i);
  if (!header) fail(`${source.name}: the test-result station header is missing or unsupported.`);
  const tableIndex = rows.findIndex((row) => clean(row.cells[0]).toLowerCase() === 'channel' && row.cells.some((cell) => /symbolic name/i.test(cell)));
  if (tableIndex < 0) fail(`${source.name}: the result table header is missing.`);
  const columns = rows[tableIndex].cells.map((cell) => clean(cell).toLowerCase());
  const symbolIndex = columns.indexOf('symbolic name'), statusIndex = columns.findIndex((cell) => /^status(?:\s|$)/.test(cell));
  const commentIndex = columns.indexOf('comment'), addressIndex = columns.indexOf('address');
  if (statusIndex < 0) fail(`${source.name}: the result status column is missing.`);
  const modules = [];
  let module = null;
  for (const row of rows.slice(tableIndex + 1)) {
    const label = clean(row.cells[0]);
    const moduleMatch = label.match(/^(\d+)\s*-\s*(.+)$/);
    if (moduleMatch) {
      const details = moduleMatch[2].match(/^(.*)\s*\(\s*([^();]+);\s*Serial Number:\s*(.*?)\s*\)\s*$/i);
      module = {
        slot: finiteInteger(moduleMatch[1], 'module slot'),
        name: clean(details?.[1] || moduleMatch[2]),
        orderNumber: clean(details?.[2]), serialNumber: clean(details?.[3]),
        rows: [],
      };
      modules.push(module);
      continue;
    }
    const channel = label.match(/^Channel\s+(\d+)$/i);
    if (!channel || !module) {
      fail(`${source.name}, line ${row.sourceRow}: unexpected result row ${JSON.stringify(label)}. No results were silently discarded.`);
    }
    const rawStatus = clean(row.cells[statusIndex]);
    const status = normalizePronetaStatus(rawStatus);
    if (status === 'Not tested' && rawStatus && !/^(?:not tested|untested)$/i.test(rawStatus)) warn(`${source.name}, line ${row.sourceRow}: unrecognized result “${rawStatus}”; retained as Not tested.`);
    module.rows.push({
      sourceChannel: finiteInteger(channel[1], 'result channel', 1023),
      symbolicName: row.cells[symbolIndex] ?? '', rawStatus, status,
      comment: commentIndex >= 0 ? row.cells[commentIndex] || '' : '',
      address: addressIndex >= 0 ? row.cells[addressIndex] || '' : '',
      sourceId: source.id, sourceRow: row.sourceRow,
    });
  }
  for (const item of modules) {
    // PRONETA AI/AQ tables are one-based, while DQ tables and logs are zero-based.
    // Restrict this rule to recognizable Siemens analog module names.
    const knownAnalog = /^(?:Ex-)?A[IQ]\s+\d+x/i.test(item.name);
    const knownDigital = /^(?:Ex-)?D[IQ]\s+\d+x/i.test(item.name);
    const offset = knownAnalog && !item.rows.some((row) => row.sourceChannel === 0) ? 1 : 0;
    if (item.rows.length && !knownAnalog && !knownDigital) warn(`${source.name}, slot ${item.slot}: unknown channel numbering for “${item.name}”; result channel numbers were retained without an offset.`);
    for (const row of item.rows) row.channel = row.sourceChannel - offset;
  }
  return { name: clean(header[1]), macAddress: clean(header[2]), serialNumber: clean(header[3]), modules };
}

const children = (node, name) => Array.from(node?.children || []).filter((child) => child.localName === name);
const child = (node, name) => children(node, name)[0];
const childText = (node, name) => clean(child(node, name)?.textContent);

function parseParameterSource(source, Parser, warn) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source.text)) fail(`${source.name}: XML document types and entities are not allowed.`);
  if (!Parser) fail('An XML parser is unavailable in this browser.');
  const document = new Parser().parseFromString(source.text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || document.documentElement?.localName !== 'SerializableCollectionOfIModule') fail(`${source.name}: invalid or unsupported PRONETA parameter XML.`);
  if (document.getElementsByTagName('*').length > 250000) fail(`${source.name}: XML contains too many elements.`, 'LIMIT_EXCEEDED');
  const modules = [];
  for (const element of children(document.documentElement, 'Module')) {
    const module = {
      slot: finiteInteger(childText(element, 'ModuleIndex'), 'parameter module slot'),
      name: childText(element, 'ModuleName'), orderNumber: childText(element, 'OrderNumber'),
      serialNumber: childText(element, 'SerialNumber'), category: childText(element, 'Category'),
      parameters: [], channelParameters: new Map(),
    };
    const records = child(child(element, 'ConfigurationRecords'), 'Records');
    // Submodules repeat the same records: deliberately read the direct records only.
    for (const record of children(records, 'ConfigurationRecord')) {
      const recordIndex = childText(record, 'Index');
      for (const parameter of children(child(record, 'Parameters'), 'ModuleParameter')) {
        const group = childText(parameter, 'Group');
        const channelMatch = group.match(/^Channel\s+(\d+)$/i);
        const selected = child(parameter, 'Value');
        const rawValue = clean(selected?.textContent);
        const description = childText(parameter, 'Description') || childText(parameter, 'TextId') || 'Unnamed parameter';
        const entry = {
          name: description.replace(/^Channel\s+\d+\s*/i, ''), value: selected ? rawValue : '(not recorded)', rawValue,
          unit: description.match(/\[([^\]]+)\]\s*$/)?.[1] || '', group,
          scope: channelMatch ? 'channel' : 'module', recordIndex,
          dataType: childText(parameter, 'DataType'), help: childText(parameter, 'Help'),
          enumId: childText(parameter, 'ValueItemTarget'),
          visible: childText(parameter, 'Visible').toLowerCase() !== 'false',
          sourceId: source.id,
        };
        if (!selected) warn(`${source.name}, slot ${module.slot}, ${description}: no selected Value is recorded; DefaultValue was not substituted.`);
        if (entry.help.length > 32000 || entry.rawValue.length > 4096 || entry.name.length > 512) fail(`${source.name}: an oversized parameter field exceeds the supported bounds.`, 'LIMIT_EXCEEDED');
        if (channelMatch) {
          const channelNumber = finiteInteger(channelMatch[1], 'parameter channel', 1023);
          if (!module.channelParameters.has(channelNumber)) module.channelParameters.set(channelNumber, []);
          module.channelParameters.get(channelNumber).push(entry);
        } else module.parameters.push(entry);
      }
    }
    modules.push(module);
    if (modules.length > PRONETA_LIMITS.modules) fail('Too many modules in a parameter file.', 'LIMIT_EXCEEDED');
  }
  if (!modules.length) fail(`${source.name}: no parameter modules were found.`);
  return { modules, serialNumber: modules.find((module) => module.category === 'InterfaceModule')?.serialNumber || '' };
}

function parseReading(raw, digital) {
  const text = clean(raw);
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s+([^\d\s].*?))?$/i);
  const value = match ? Number(match[1]) : null;
  const unit = clean(match?.[2] || text.match(/\s+(mA|A|mV|V|°C|°F|K|Ohm|Ω|%|bar|Pa|kPa|MPa)$/i)?.[1]);
  const valid = value !== null && Number.isFinite(value) && (!digital || ((value === 0 || value === 1) && !unit));
  return { value: valid ? value : null, unit, valid, rawValue: text };
}

function parseLogSource(source, options, warn) {
  const rows = csvRows(source.text);
  const headerIndex = rows.findIndex((row) => clean(row.cells[0]).toLowerCase() === 'slot' && row.cells.some((cell) => clean(cell).toLowerCase() === 'time stamp'));
  if (headerIndex < 0) fail(`${source.name}: I/O log header is missing.`);
  const records = [];
  let repaired = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.cells.length < 4) fail(`${source.name}, line ${row.sourceRow}: incomplete I/O log row.`);
    const descriptionIndex = row.cells.findIndex((cell, index) => index >= 2 && /^(?:Analog|Digital)\s+(?:input|output)\b/i.test(clean(cell)));
    const index = descriptionIndex < 0 ? 2 : descriptionIndex;
    const module = row.cells.slice(1, index).join(',').trim();
    const description = row.cells.slice(index, -1).join(',').trim();
    const rawTime = clean(row.cells.at(-1));
    const timestamp = parsePronetaTimestamp(rawTime, options);
    if (row.cells.length !== 4) repaired += 1;
    const slot = /^\d+$/.test(clean(row.cells[0])) ? finiteInteger(row.cells[0], 'log slot') : null;
    const record = { sourceId: source.id, sourceRow: row.sourceRow, slot, module, description, time: rawTime, timestamp };
    if (!timestamp) record.reason = 'Invalid or ambiguous timestamp; re-export timestamps as YYYY-MM-DD HH:mm:ss or correct the source.';
    else if (slot === null) record.reason = 'Invalid module slot.';
    const match = description.match(/^(Analog|Digital)\s+(input|output)\s+(.+?)\s+\(([^)]+)\)\s+was changed from\s+(.+?)\s+to\s+(.+?)\.?$/i);
    if (!match) record.reason ||= 'Unrecognized event description.';
    else {
      const channelMatch = match[4].match(/^(?:[a-z]\.)?(\d+)$/i);
      if (!channelMatch) record.reason ||= 'Unrecognized physical channel number.';
      else {
        record.channel = finiteInteger(channelMatch[1], 'log channel', 1023);
        record.symbolicName = match[3];
        record.kind = match[1].toLowerCase();
        record.direction = match[2].toLowerCase();
        record.previous = parseReading(match[5], record.kind === 'digital');
        record.reading = parseReading(match[6], record.kind === 'digital');
      }
    }
    records.push(record);
    if (records.length > PRONETA_LIMITS.events) fail('The import exceeds 10,000 I/O events.', 'LIMIT_EXCEEDED');
  }
  if (repaired) warn(`${source.name}: repaired ${repaired} CSV rows with unquoted commas by locating the event description and final timestamp; the full module name and description were retained.`);
  const timed = records.filter((record) => record.timestamp);
  let ascending = 0, descending = 0;
  for (let index = 1; index < timed.length; index += 1) {
    const difference = timed[index].timestamp.timeMs - timed[index - 1].timestamp.timeMs;
    if (difference > 0) ascending += 1;
    else if (difference < 0) descending += 1;
  }
  const reverse = descending > ascending || (!ascending && !descending && timed.length > 1);
  if (ascending && descending) warn(`${source.name}: source timestamps are not monotonic; events were sorted chronologically, retaining same-time observations.`);
  if (!ascending && !descending && timed.length > 1) warn(`${source.name}: all event timestamps are equal; second-resolution timestamps cannot establish their actual order. The PRONETA export row order was reversed and all observations retained.`);
  for (const record of records) record.order = reverse ? -record.sourceRow : record.sourceRow;
  return records;
}

/** Import supported files into one immutable-on-approval report payload. */
export async function parsePronetaFiles(files, options = {}) {
  const selected = Array.from(files || []);
  if (!selected.length || selected.length > PRONETA_LIMITS.files) fail('Select between 1 and 20 PRONETA files.', 'LIMIT_EXCEEDED');
  if (selected.reduce((sum, file) => sum + (Number(file.size) || 0), 0) > PRONETA_LIMITS.totalBytes) fail('Selected files exceed the 30 MiB combined limit.', 'LIMIT_EXCEEDED');
  const collector = warningCollector(), warn = (message) => collector.add(message);
  // Read sequentially so a large batch never holds multiple XML byte buffers.
  const sources = [];
  let totalBytes = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const source = await readSource(selected[index], index);
    totalBytes += source.size;
    if (totalBytes > PRONETA_LIMITS.totalBytes) fail('Selected files exceed the 30 MiB combined limit.', 'LIMIT_EXCEEDED');
    sources.push(source);
  }
  const activeSources = sources;
  const stations = [], stationMap = new Map(), channels = [], channelMap = new Map();
  const stationModules = new Map();
  const assignments = options.stationAssignments || {};
  const importedSources = new Map();
  const isDuplicateSource = (source) => {
    // Two stations can produce exactly the same sequence of changes. A content
    // hash alone is therefore insufficient: resolve the station first.
    const key = `${source.kind}|${source.stationId}|${source.sha256}`;
    const duplicate = importedSources.get(key);
    if (!duplicate) { importedSources.set(key, source); return false; }
    source.duplicateOf = duplicate.id;
    warn(`${source.name} is byte-for-byte identical to ${duplicate.name} for the same station; its provenance was retained but its data was imported only once.`);
    return true;
  };
  const getStation = (name, metadata = {}) => {
    const key = stationKey(name);
    if (!key) fail('A source is missing its station name.');
    let station = stationMap.get(key) || stations.find((item) => item.id === name);
    if (!station) {
      station = { id: `station-${key}`, name: clean(name), macAddress: '', serialNumber: '', start: null, end: null, modules: [] };
      stationMap.set(key, station); stations.push(station); stationModules.set(station.id, new Map());
    }
    for (const field of ['macAddress', 'serialNumber']) {
      if (metadata[field] && station[field] && station[field] !== metadata[field]) fail(`Conflicting ${field} for station ${station.name}. Assign the sources to distinct stations.`, 'SOURCE_CONFLICT');
      if (metadata[field]) station[field] = metadata[field];
    }
    return station;
  };
  const getModule = (station, data) => {
    const modules = stationModules.get(station.id);
    let module = modules.get(data.slot);
    if (!module) {
      module = { slot: data.slot, name: data.name || '', orderNumber: data.orderNumber || '', serialNumber: data.serialNumber || '', parameters: [] };
      modules.set(data.slot, module); station.modules.push(module);
    } else {
      for (const field of ['orderNumber', 'serialNumber']) {
        if (module[field] && data[field] && module[field] !== data[field]) fail(`${station.name}, slot ${data.slot}: conflicting module ${field}. Do not combine different hardware configurations.`, 'SOURCE_CONFLICT');
        if (data[field]) module[field] = data[field];
      }
      if (!module.name) module.name = data.name || '';
    }
    return module;
  };
  const getChannel = (station, module, number, symbol = '', origin = 'parameters') => {
    const key = `${station.id}:${positionKey(module.slot, number)}`;
    let channel = channelMap.get(key);
    if (!channel) {
      channel = {
        id: `${station.id}:slot-${module.slot}:channel-${number}`, stationId: station.id,
        slot: module.slot, channel: number, sourceChannel: number, sourceChannelOrigin: origin,
        symbolicName: symbol, role: groupPronetaDeviceName(symbol, module.name).role,
        status: 'Not tested', rawStatus: '', comment: '', parameters: [], series: [], resultRows: [],
      };
      channelMap.set(key, channel); channels.push(channel);
    }
    return channel;
  };
  const resultSources = activeSources.filter((source) => source.kind === 'results');
  for (const source of resultSources) {
    const parsed = parseResultSource(source, warn);
    const override = clean(assignments[source.id] ?? assignments[source.name]);
    if (override && stationKey(override.replace(/^station-/, '')) !== stationKey(parsed.name)) fail(`${source.name}: the selected station conflicts with its recorded station ${parsed.name}.`, 'SOURCE_CONFLICT');
    const station = getStation(parsed.name, parsed);
    source.stationId = station.id;
    // Both header name and filename may identify the same station, but never
    // silently steal another station's alias.
    const alias = stationKey(source.stationHint);
    if (!stationMap.has(alias)) stationMap.set(alias, station);
    if (isDuplicateSource(source)) continue;
    for (const data of parsed.modules) {
      const module = getModule(station, data);
      for (const row of data.rows) {
        const channel = getChannel(station, module, row.channel, row.symbolicName, 'results');
        if (channel.resultRows.length && normalizeSymbol(channel.symbolicName) !== normalizeSymbol(row.symbolicName)) fail(`${source.name}, line ${row.sourceRow}: conflicting symbolic names at ${station.name}, slot ${module.slot}, channel ${row.channel}.`, 'SOURCE_CONFLICT');
        if (channel.resultRows.length) warn(`${source.name}, line ${row.sourceRow}: repeated result for ${station.name}, slot ${module.slot}, channel ${row.channel}; all result rows were retained.`);
        channel.sourceChannel = row.sourceChannel;
        channel.sourceChannelOrigin = 'results';
        channel.resultRows.push(row);
        channel.rawStatus = [...new Set(channel.resultRows.map((item) => item.rawStatus))].join(' / ');
        channel.comment = [...new Set(channel.resultRows.map((item) => item.comment).filter(Boolean))].join('\n');
        const statuses = channel.resultRows.map((item) => item.status);
        channel.status = new Set(statuses).size > 1
          ? (statuses.includes('Failed') ? 'Failed' : 'Not tested')
          : statuses[0];
        if (new Set(statuses).size > 1) warn(`${station.name}, slot ${module.slot}, channel ${row.channel}: conflicting recorded results; retained all rows and used the conservative aggregate ${channel.status}.`);
      }
    }
  }
  const assignStation = (source, serialNumber = '') => {
    const assignment = clean(assignments[source.id] ?? assignments[source.name]);
    const assigned = assignment && (stationMap.get(stationKey(assignment)) || stations.find((station) => station.id === assignment));
    if (assignment && !assigned && resultSources.length) fail(`${source.name}: the station assignment “${assignment}” does not match a result station.`, 'STATION_ASSIGNMENT_REQUIRED', { files: [source.name], stations: stations.map(({ id, name }) => ({ id, name })) });
    const serialMatches = serialNumber ? stations.filter((station) => station.serialNumber === serialNumber) : [];
    let station = assigned || (assignment ? getStation(assignment) : null) || stationMap.get(stationKey(source.stationHint)) || (serialMatches.length === 1 ? serialMatches[0] : null);
    if (!station && resultSources.length) fail(`Choose the station for ${source.name}; its filename and hardware identity do not identify a result station.`, 'STATION_ASSIGNMENT_REQUIRED', { files: [source.name], stations: stations.map(({ id, name }) => ({ id, name })) });
    if (!station) station = getStation(source.stationHint);
    if (serialNumber && station.serialNumber && serialNumber !== station.serialNumber) fail(`${source.name}: parameter station serial number conflicts with ${station.name}.`, 'SOURCE_CONFLICT');
    if (serialNumber && !station.serialNumber) station.serialNumber = serialNumber;
    source.stationId = station.id;
    if (assignment) warn(`${source.name}: explicitly assigned to station ${station.name}; review this source-to-station mapping before approval.`);
    return station;
  };
  const addParameters = (target, entries, context) => {
    for (const entry of entries) {
      const existing = target.find((item) => item.recordIndex === entry.recordIndex && item.name === entry.name && item.group === entry.group);
      if (existing) warn(`${context}, ${entry.name}: repeated parameter selection${existing.rawValue !== entry.rawValue ? ' with conflicting values' : ''}; both source selections were retained.`);
      target.push(entry);
    }
    if (target.length > PRONETA_LIMITS.parametersPerChannel) fail(`${context}: more than 200 selected parameters exceed the import limit.`, 'LIMIT_EXCEEDED');
  };
  for (const source of activeSources.filter((item) => item.kind === 'parameters')) {
    const parsed = parseParameterSource(source, options.DOMParser || globalThis.DOMParser, warn);
    if (parsed.modules.some((module) => [...module.parameters, ...Array.from(module.channelParameters.values()).flat()].some((parameter) => parameter.enumId && /^[+-]?\d+(?:\.\d+)?$/.test(parameter.rawValue)))) {
      warn('Parameter files contain selected numeric enum codes without embedded value-label mappings. The selected codes and GSD enum references are retained exactly; mode, range, and other labels were not guessed.');
    }
    const station = assignStation(source, parsed.serialNumber);
    if (isDuplicateSource(source)) continue;
    for (const data of parsed.modules) {
      const module = getModule(station, data);
      addParameters(module.parameters, data.parameters, `${station.name}, slot ${module.slot}`);
      for (const [number, parameters] of data.channelParameters) {
        const channel = getChannel(station, module, number);
        addParameters(channel.parameters, parameters, `${station.name}, slot ${module.slot}, channel ${number}`);
      }
    }
  }
  const allTimed = [], unparsedEvents = [];
  let eventCount = 0;
  const signatures = new Set();
  const stationTimes = new Map();
  for (const source of activeSources.filter((item) => item.kind === 'log')) {
    const station = assignStation(source);
    if (isDuplicateSource(source)) continue;
    const records = parseLogSource(source, options, warn);
    eventCount += records.length;
    if (eventCount > PRONETA_LIMITS.events) fail('The import exceeds 10,000 I/O events.', 'LIMIT_EXCEEDED');
    for (const record of records) {
      if (record.timestamp) {
        allTimed.push(record.timestamp);
        if (!stationTimes.has(station.id)) stationTimes.set(station.id, []);
        stationTimes.get(station.id).push(record.timestamp);
      }
      const retainUnparsed = (reason) => {
        unparsedEvents.push({ sourceId: source.id, sourceRow: record.sourceRow, stationId: station.id, slot: record.slot, module: record.module, description: record.description, time: record.time, reason });
        warn(`${source.name}, line ${record.sourceRow}: ${reason} The original event was retained for review.`);
      };
      if (record.reason) { retainUnparsed(record.reason); continue; }
      const module = getModule(station, { slot: record.slot, name: record.module });
      const physical = channelMap.get(`${station.id}:${positionKey(record.slot, record.channel)}`);
      const symbolMatches = channels.filter((channel) => channel.stationId === station.id && channel.slot === record.slot && normalizeSymbol(channel.symbolicName) === normalizeSymbol(record.symbolicName));
      if ((physical && !isUnassigned(physical.symbolicName) && normalizeSymbol(physical.symbolicName) !== normalizeSymbol(record.symbolicName)) || (physical?.resultRows.length && isUnassigned(physical.symbolicName)) || (symbolMatches.length && !symbolMatches.some((channel) => channel.channel === record.channel))) {
        retainUnparsed(`Symbolic name/channel mismatch for ${record.symbolicName} at slot ${record.slot}, channel ${record.channel}; no channel assignment was guessed.`);
        continue;
      }
      const channel = getChannel(station, module, record.channel, record.symbolicName, 'log');
      if (isUnassigned(channel.symbolicName)) {
        channel.symbolicName = record.symbolicName;
        channel.role = groupPronetaDeviceName(record.symbolicName, module.name).role;
      }
      const unit = record.reading.unit || record.previous.unit;
      if (record.reading.unit && record.previous.unit && record.reading.unit !== record.previous.unit) warn(`${source.name}, line ${record.sourceRow}: the event changes units from ${record.previous.unit} to ${record.reading.unit}; previous and current units were retained without conversion.`);
      let series = channel.series.find((item) => item.kind === record.kind && item.unit === unit);
      if (!series) {
        if (channel.series.length) warn(`${station.name}, slot ${record.slot}, channel ${record.channel}: multiple units or signal types were kept in separate series.`);
        series = { id: `${channel.id}:series-${channel.series.length + 1}`, name: clean(channel.symbolicName) || `Channel ${channel.channel}`, unit, kind: record.kind, points: [] };
        channel.series.push(series);
      }
      const signature = `${station.id}|${record.slot}|${record.channel}|${record.time}|${record.description}`;
      if (signatures.has(signature)) warn(`${source.name}, line ${record.sourceRow}: duplicate I/O event retained; no observations were removed.`);
      signatures.add(signature);
      if (!record.reading.valid || !record.previous.valid) warn(`${source.name}, line ${record.sourceRow}: invalid ${!record.reading.valid ? 'current' : 'previous'} reading retained as raw text; no numeric value was invented.`);
      series.points.push({
        time: record.time, timeMs: record.timestamp.timeMs,
        value: record.reading.value, previousValue: record.previous.value,
        rawValue: record.reading.rawValue, previousRawValue: record.previous.rawValue,
        valid: record.reading.valid, previousValid: record.previous.valid,
        previousUnit: record.previous.unit, sourceId: source.id, sourceRow: record.sourceRow,
        _sourceIndex: source.index, _order: record.order,
      });
    }
  }
  const bases = new Set(allTimed.map((timestamp) => timestamp.basis));
  if (bases.size > 1) fail('The selected logs mix timestamps with explicit timezones and unspecified source clocks. Normalize the source clocks before combining them.', 'CLOCK_MISMATCH');
  const byTime = (a, b) => a.timeMs - b.timeMs;
  allTimed.sort(byTime);
  for (const station of stations) {
    const times = (stationTimes.get(station.id) || []).sort(byTime);
    station.start = times[0]?.time || null;
    station.end = times.at(-1)?.time || null;
    station.modules.sort((a, b) => a.slot - b.slot);
  }
  const devices = [], deviceMap = new Map(), unassignedChannels = [];
  channels.sort((a, b) => a.stationId.localeCompare(b.stationId) || a.slot - b.slot || a.channel - b.channel);
  for (const channel of channels) {
    for (const series of channel.series) {
      series.points.sort((a, b) => a.timeMs - b.timeMs || a._sourceIndex - b._sourceIndex || a._order - b._order);
      for (const point of series.points) { delete point._sourceIndex; delete point._order; }
    }
    if (isUnassigned(channel.symbolicName)) { unassignedChannels.push(channel); continue; }
    const { name } = groupPronetaDeviceName(channel.symbolicName);
    let device = deviceMap.get(name);
    if (!device) { device = { id: `device-${name}`, name, status: 'Not tested', channels: [] }; deviceMap.set(name, device); devices.push(device); }
    device.channels.push(channel);
  }
  for (const device of devices) device.status = aggregateStatus(device.channels.map((channel) => channel.status));
  devices.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!resultSources.length) warn('No test-result CSV was imported. I/O changes and parameter selections do not establish Passed or Failed results.');
  if (!allTimed.length) warn('No valid dated I/O events were imported; this report has no shared graph time span.');
  const basis = allTimed[0]?.basis || 'source-local';
  const clock = {
    basis, timeZone: clean(options.timeZone) || (basis === 'absolute' ? 'Explicit source offsets' : 'Source clock (unspecified)'),
    start: allTimed[0]?.time || null, end: allTimed.at(-1)?.time || null,
    startMs: allTimed[0]?.timeMs ?? null, endMs: allTimed.at(-1)?.timeMs ?? null,
  };
  if (basis === 'source-local' && allTimed.length) warn('Log timestamps have no timezone offset. Graphs share the recorded source clock; no timezone conversion or clock synchronization is inferred.');
  const run = {
    schemaVersion: 1, name: clean(options.name) || 'PRONETA I/O test',
    software: { name: clean(options.softwareName) || 'Siemens PRONETA Basic', version: clean(options.softwareVersion) },
    clock,
    sources: sources.map(({ id, name, kind, stationId, size, sha256, duplicateOf }) => ({ id, name, kind, stationId, size, sha256, ...(duplicateOf ? { duplicateOf } : {}) })),
    stations, devices, unassignedChannels, warnings: collector.finish(), unparsedEvents,
  };
  if (stations.length > PRONETA_LIMITS.stations || stations.reduce((sum, station) => sum + station.modules.length, 0) > PRONETA_LIMITS.modules || devices.length > PRONETA_LIMITS.devices || channels.length > PRONETA_LIMITS.channels) fail('This import exceeds the supported station, module, device, or channel count. Split independent runs into separate reports.', 'LIMIT_EXCEEDED');
  if (new TextEncoder().encode(JSON.stringify(run)).byteLength > PRONETA_LIMITS.payloadBytes) fail('The parsed report exceeds 4 MiB. Split independent runs into separate reports.', 'LIMIT_EXCEEDED');
  return run;
}
