import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import {
  parsePronetaFiles, parsePronetaCsv, parsePronetaTimestamp,
  groupPronetaDeviceName, normalizePronetaStatus, inferPronetaStationName,
} from '../src/proneta-parser.js';

// All fixtures below are synthetic. No original test files, hardware serials,
// MAC addresses, or private measurements are copied into the repository.
const DOMParser = new JSDOM('').window.DOMParser;
const options = { DOMParser, softwareName: 'Siemens PRONETA Basic', softwareVersion: '3.9' };
const file = (name, text) => ({ name, text });
const literal = (value) => `="${String(value).replaceAll('"', '""')}"`;
const csv = (values) => values.map(literal).join(',');
const result = (station, modules, serial = '') => [
  csv([`Test Results of Station ${station} (MAC Address: ; Serial Number: ${serial})`, '', '', '', '', '']),
  csv(['Channel', 'Symbolic Name', 'Address', 'Status Wiring', 'Comment', 'Identification Number']),
  ...modules.flatMap(({ slot, name, channels }) => [
    csv([`${slot} - ${name}`, '', '', '', '', '']),
    ...channels.map(([channel, symbol, status = 'OK', comment = '']) => csv([`Channel ${channel}`, symbol, '', status, comment, ''])),
  ]),
].join('\r\n');
const log = (rows) => ['Slot,Module,Description,Time Stamp', ...rows.map(([slot, module, description, time]) => `${slot},${module},${description},${time}`)].join('\r\n');
const event = (symbol, channel, before, after, kind = 'Analog input') => `${kind} ${symbol} (${channel}) was changed from ${before} to ${after}.`;
const xmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const parameter = ({ name = 'Measurement range', value = '770', defaultValue = '515', group = 'Channel 0', enumId = 'MeasurementType', visible = true } = {}) => `
  <ModuleParameter><DataType>Unsigned16</DataType><Description>${xmlEscape(name)}</Description>
  ${value === null ? '' : `<Value>${xmlEscape(value)}</Value>`}<DefaultValue>${xmlEscape(defaultValue)}</DefaultValue>
  <Group>${xmlEscape(group)}</Group><ValueItemTarget>${xmlEscape(enumId)}</ValueItemTarget>
  <Visible>${visible}</Visible><Help>Use the selected range.</Help></ModuleParameter>`;
const parameterModule = ({ slot = 2, name = 'AI 2xI', parameters = [parameter()], duplicate = true, serial = '', category = 'Analog' } = {}) => {
  const records = `<ConfigurationRecords><Records><ConfigurationRecord><Index>128</Index><Parameters>${parameters.join('')}</Parameters></ConfigurationRecord></Records></ConfigurationRecords>`;
  return `<Module><ModuleIndex>${slot}</ModuleIndex><ModuleName>${xmlEscape(name)}</ModuleName><OrderNumber></OrderNumber>
  <SerialNumber>${xmlEscape(serial)}</SerialNumber><Category>${category}</Category>${records}
  ${duplicate ? `<Submodules><Submodule>${records}</Submodule></Submodules>` : ''}</Module>`;
};
const mpr = (modules) => `<?xml version="1.0" encoding="utf-8"?><SerializableCollectionOfIModule>${modules.join('')}</SerializableCollectionOfIModule>`;
const allChannels = (run) => [...run.devices.flatMap((device) => device.channels), ...run.unassignedChannels];
const allPoints = (run) => allChannels(run).flatMap((channel) => channel.series).flatMap((series) => series.points);

test('Excel literals, ordinary quoted CSV, escaped quotes, and multiline comments retain source rows', () => {
  const rows = parsePronetaCsv('="Channel",="Comment"\r\n="Channel 0",="comma, quote ""yes""\nsecond line"\r\n"Channel 1","plain, quoted"');
  assert.deepEqual(rows.map((row) => row.sourceRow), [1, 2, 4]);
  assert.equal(rows[1].cells[1], 'comma, quote "yes"\nsecond line');
  assert.deepEqual(rows[2].cells, ['Channel 1', 'plain, quoted']);
  assert.throws(() => parsePronetaCsv('a,"unclosed'), /Unclosed CSV quote/);
  assert.throws(() => parsePronetaCsv('"closed"garbage,x'), /Unexpected character/);
});

test('one run links station/slot/channel, preserves explicit results and selected parameters, and shares one clock', async () => {
  const files = [
    file('SKID-A.csv', result('skid-a', [
      { slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y', 'OK', 'Checked, then released.'], [1, 'N/A', 'N. a.']] },
      { slot: 2, name: 'AI 2xI', channels: [[1, 'V-1001-Y-POS'], [2, 'TH-1002']] },
      { slot: 3, name: 'AI 2xU', channels: [[1, 'V-1001-Y_FB', '']] },
    ])),
    file('SKID-B.csv', result('skid-b', [
      { slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1003-OPEN', 'Error']] },
      { slot: 2, name: 'Ex-AI 2xI HART; QI', channels: [[1, 'PD-1004']] },
    ])),
    file('SKID-A-PARAMETERS.mpr', mpr([parameterModule({ parameters: [
      parameter({ name: 'Potential group', value: '1', defaultValue: '0', group: '', enumId: 'BaseUnit' }),
      parameter({ name: 'Channel 0 Measurement range', value: '770', defaultValue: '515' }),
    ] })])),
    file('SKID-B-PARAMETERS.mpr', mpr([parameterModule({ name: 'Ex-AI 2xI HART, QI', parameters: [parameter({ value: '771', defaultValue: '775' })] })])),
    file('SKID-A-log.csv', log([
      [2, 'AI 2xI', event('V-1001-Y-POS', 0, '8 mA', '9 mA'), '2026-01-20 12:00:10'],
      [2, 'AI 2xI', event('V-1001-Y-POS', 0, '7 mA', '8 mA'), '2026-01-20 12:00:10'],
      [2, 'AI 2xI', event('V-1001-Y-POS', 0, '4 mA', '7 mA'), '2026-01-20 12:00:00'],
    ])),
    file('SKID-B-LOG.csv', log([
      [2, 'Ex-AI 2xI HART, QI', event('PD-1004', 0, '4 mA', '6 mA'), '2026-01-20 12:00:40'],
      [1, 'DQ 2x24VDC', event('V-1003-OPEN', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:30'],
    ])),
  ];
  const run = await parsePronetaFiles(files, { ...options, name: 'Synthetic skid run', timeZone: 'Plant local clock' });
  assert.equal(run.name, 'Synthetic skid run');
  assert.deepEqual(run.software, { name: 'Siemens PRONETA Basic', version: '3.9' });
  assert.equal(run.devices.length, 4);
  assert.equal(run.devices.flatMap((device) => device.channels).length, 6);
  assert.equal(run.unassignedChannels.length, 1);
  assert.equal(run.unassignedChannels[0].status, 'Not applicable');
  assert.equal(run.unparsedEvents.length, 0);
  const valve = run.devices.find((device) => device.name === 'V-1001-Y');
  assert.equal(valve.status, 'Not tested', 'the missing feedback result prevents an overall pass');
  assert.equal(run.devices.find((device) => device.name === 'V-1003').status, 'Failed', 'an output change cannot overwrite an explicit failure');
  assert.equal(run.devices.find((device) => device.name === 'TH-1002').status, 'Passed', 'an explicit result does not need a graph to be preserved');
  const positioner = valve.channels.find((channel) => channel.role === 'Positioner');
  assert.equal(positioner.channel, 0);
  assert.equal(positioner.sourceChannel, 1);
  assert.equal(positioner.parameters[0].rawValue, '770');
  assert.equal(positioner.parameters[0].value, '770');
  assert.equal(positioner.parameters.length, 1, 'submodule copies are not imported again');
  assert.equal(positioner.series[0].unit, 'mA', 'no uncalibrated conversion to percentage');
  assert.deepEqual(positioner.series[0].points.map((point) => point.value), [7, 8, 9]);
  assert.deepEqual(positioner.series[0].points.map((point) => point.sourceRow), [4, 3, 2]);
  assert.equal(run.stations[0].modules.find((module) => module.slot === 2).parameters.length, 1);
  assert.equal(valve.channels[0].comment, 'Checked, then released.');
  assert.equal(allPoints(run).length, 5, 'only after-values at actual event times are graph observations');
  assert.equal(run.clock.startMs, Date.UTC(2026, 0, 20, 12, 0, 0));
  assert.equal(run.clock.endMs, Date.UTC(2026, 0, 20, 12, 0, 40));
  assert.equal(run.clock.basis, 'source-local');
  assert.equal(run.clock.timeZone, 'Plant local clock');
  assert.ok(run.warnings.some((warning) => /repaired 1 CSV rows/.test(warning)));
  assert.ok(run.warnings.some((warning) => /numeric enum codes/.test(warning)));
  assert.ok(run.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256)));
});

test('grouping preserves mechanical suffixes and distinct feedback and positioner roles', () => {
  assert.deepEqual(groupPronetaDeviceName('V -1001-CLOSE_FB'), { name: 'V-1001', role: 'Close feedback' });
  assert.deepEqual(groupPronetaDeviceName('V-1001-OPEN'), { name: 'V-1001', role: 'Open command' });
  assert.deepEqual(groupPronetaDeviceName('V-1001-Y_FB'), { name: 'V-1001-Y', role: 'Feedback' });
  assert.deepEqual(groupPronetaDeviceName('V-1001-Y-POS'), { name: 'V-1001-Y', role: 'Positioner' });
  assert.equal(groupPronetaDeviceName('V-1001#2-POS').name, 'V-1001#2');
  assert.notEqual(groupPronetaDeviceName('DP-1001').name, groupPronetaDeviceName('PD-1001').name);
  assert.equal(groupPronetaDeviceName('CUSTOM-POS').name, 'CUSTOM-POS', 'unknown naming conventions are not guessed');
});

test('statuses retain N. a. and unknown values without inferring pass', () => {
  for (const value of ['OK', 'Passed', 'pass']) assert.equal(normalizePronetaStatus(value), 'Passed');
  for (const value of ['Error', 'Failed', 'fail']) assert.equal(normalizePronetaStatus(value), 'Failed');
  for (const value of ['N. a.', 'N/A', 'N.a.', 'Not applicable']) assert.equal(normalizePronetaStatus(value), 'Not applicable');
  for (const value of ['', 'unknown', 'looks okay', '1', 'Good']) assert.equal(normalizePronetaStatus(value), 'Not tested');
});

test('raw invalid readings and exact duplicates survive import without fabricated zeros', async () => {
  const changed = event('TH-1001', 0, '20 °C', 'NaN °C');
  const run = await parsePronetaFiles([file('S-log.csv', log([
    [2, 'AI 2xRTD', changed, '2026-01-20 12:00:03'],
    [2, 'AI 2xRTD', changed, '2026-01-20 12:00:03'],
    [2, 'AI 2xRTD', event('TH-1001', 0, '18 °C', '19 °C'), '2026-01-20 12:00:02'],
    [2, 'AI 2xRTD', event('TH-1001', 0, '17 °C', '18 °C'), '2026-01-20 12:00:01'],
  ]))], options);
  const points = allPoints(run);
  assert.equal(points.length, 4);
  assert.equal(points[2].value, null);
  assert.equal(points[2].valid, false);
  assert.equal(points[2].rawValue, 'NaN °C');
  assert.equal(points[2].previousValue, 20);
  assert.equal(points[3].rawValue, 'NaN °C');
  assert.equal(run.devices[0].status, 'Not tested');
  assert.ok(run.warnings.some((warning) => /duplicate I\/O event/.test(warning)));
  assert.ok(run.warnings.some((warning) => /invalid current/.test(warning)));
});

test('invalid numeric tokens and nonbinary digital readings are not partially parsed', async () => {
  const run = await parsePronetaFiles([file('S-log.csv', log([
    [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '0', '2', 'Digital output'), '2026-01-20 12:00:00'],
    [2, 'AI 2xI', event('PD-1002', 0, '4 mA', '12garbage'), '2026-01-20 12:00:01'],
    [2, 'AI 2xI', event('PD-1002', 0, '4 mA', '1e309 mA'), '2026-01-20 12:00:02'],
  ]))], options);
  assert.ok(allPoints(run).every((point) => point.valid === false && point.value === null));
  assert.deepEqual(new Set(allPoints(run).map((point) => point.rawValue)), new Set(['2', '12garbage', '1e309 mA']));
});

test('unknown descriptions and invalid timestamps are retained for review; valid unknown events extend the common clock', async () => {
  const run = await parsePronetaFiles([file('S-log.csv', log([
    [1, 'DQ 2x24VDC', 'Device diagnostic appeared: test only', '2026-01-20 12:01:00'],
    [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:00'],
    [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '1', '0', 'Digital output'), '01/02/2026 12:00:10'],
  ]))], options);
  assert.equal(run.unparsedEvents.length, 2);
  assert.match(run.unparsedEvents[0].description, /diagnostic/);
  assert.equal(run.unparsedEvents[1].time, '01/02/2026 12:00:10');
  assert.equal(run.clock.end, '2026-01-20 12:01:00');
  assert.equal(allPoints(run).length, 1);
});

test('date parsing is strict, timezone-independent, and requires a choice for ambiguous dates', () => {
  assert.equal(parsePronetaTimestamp('2026-02-30 12:00:00'), null);
  assert.equal(parsePronetaTimestamp('2026-01-20 24:00:00'), null);
  assert.equal(parsePronetaTimestamp('2026-01-20 12:00:00+14:01'), null);
  assert.equal(parsePronetaTimestamp('01/02/2026 12:00:00'), null);
  assert.equal(parsePronetaTimestamp('01/02/2026 12:00:00', { dateFormat: 'dmy' }).timeMs, Date.UTC(2026, 1, 1, 12));
  assert.equal(parsePronetaTimestamp('01/02/2026 12:00:00', { dateFormat: 'mdy' }).timeMs, Date.UTC(2026, 0, 2, 12));
  assert.equal(parsePronetaTimestamp('2026-01-20T12:00:00.125+02:00').timeMs, Date.UTC(2026, 0, 20, 10, 0, 0, 125));
  assert.equal(parsePronetaTimestamp('2026-01-20T12:00:00Z').basis, 'absolute');
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const ny = parsePronetaTimestamp('2026-11-01 01:30:00');
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    assert.deepEqual(parsePronetaTimestamp('2026-11-01 01:30:00'), ny);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('explicit-offset and unspecified-clock logs cannot be silently merged', async () => {
  await assert.rejects(parsePronetaFiles([file('S-log.csv', log([
    [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:00'],
    [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '1', '0', 'Digital output'), '2026-01-20T12:00:01Z'],
  ]))], options), { code: 'CLOCK_MISMATCH' });
});

test('filename suffixes are case-insensitive, unmatched sources require explicit station assignment', async () => {
  assert.equal(inferPronetaStationName('SKID-A-LoG.csv'), 'SKID-A');
  assert.equal(inferPronetaStationName('SKID-A-PARAMETERS.mpr'), 'SKID-A');
  const files = [
    file('S.csv', result('s', [{ slot: 2, name: 'AI 2xI', channels: [[1, 'PD-1001']] }])),
    file('unrelated.csv', log([[2, 'AI 2xI', event('PD-1001', 0, '4 mA', '5 mA'), '2026-01-20 12:00:00']])),
  ];
  await assert.rejects(parsePronetaFiles(files, options), (error) => error.code === 'STATION_ASSIGNMENT_REQUIRED' && error.files[0] === 'unrelated.csv');
  const run = await parsePronetaFiles(files, { ...options, stationAssignments: { 'unrelated.csv': 'station-s' } });
  assert.equal(allPoints(run).length, 1);
  assert.equal(run.sources[1].stationId, run.sources[0].stationId);
  assert.ok(run.warnings.some((warning) => /explicitly assigned/.test(warning)));
});

test('parameter hardware identity can resolve an unrelated filename without a guess', async () => {
  const run = await parsePronetaFiles([
    file('S.csv', result('s', [{ slot: 2, name: 'AI 2xI', channels: [[1, 'PD-1001']] }], 'SYNTHETIC-IDENTITY')),
    file('settings.mpr', mpr([
      parameterModule({ slot: 0, name: 'IM test', serial: 'SYNTHETIC-IDENTITY', category: 'InterfaceModule', parameters: [] }),
      parameterModule(),
    ])),
  ], options);
  assert.equal(run.stations.length, 1);
  assert.equal(run.devices[0].channels[0].parameters[0].rawValue, '770');
});

test('name/channel mismatches remain orphan events and unknown module indexing is never shifted', async () => {
  const run = await parsePronetaFiles([
    file('S.csv', result('s', [
      { slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y']] },
      { slot: 2, name: 'Unrecognized analog module', channels: [[1, 'PD-1002']] },
      { slot: 3, name: 'AI 2xI', channels: [[1, 'N/A', 'N. a.']] },
    ])),
    file('S-log.csv', log([
      [1, 'DQ 2x24VDC', event('V-9999-Y', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:00'],
      [2, 'Unrecognized analog module', event('PD-1002', 0, '4 mA', '5 mA'), '2026-01-20 12:00:01'],
      [3, 'AI 2xI', event('PD-1003', 0, '4 mA', '5 mA'), '2026-01-20 12:00:02'],
    ])),
  ], options);
  assert.equal(run.unparsedEvents.length, 3);
  assert.equal(allPoints(run).length, 0);
  assert.equal(run.devices.find((device) => device.name === 'PD-1002').channels[0].channel, 1);
  assert.ok(run.warnings.some((warning) => /unknown channel numbering/.test(warning)));
});

test('known analog modules with an explicit Channel 0 remain zero-based', async () => {
  const run = await parsePronetaFiles([
    file('S.csv', result('s', [{ slot: 2, name: 'AI 2xI', channels: [[0, 'PD-1001'], [1, 'PD-1002']] }])),
    file('S-log.csv', log([[2, 'AI 2xI', event('PD-1002', 1, '4 mA', '5 mA'), '2026-01-20 12:00:00']])),
  ], options);
  assert.equal(run.unparsedEvents.length, 0);
  assert.equal(run.devices.find((device) => device.name === 'PD-1002').channels[0].channel, 1);
});

test('results-only and parameters-only reports retain content with null graph spans', async () => {
  const results = await parsePronetaFiles([file('S.csv', result('s', [{ slot: 2, name: 'AI 2xI', channels: [[1, 'PD-1001', 'strange status', 'Review required']] }]))], { ...options, softwareVersion: '' });
  assert.equal(results.software.version, '', 'a preview may precede manual version entry');
  assert.equal(results.devices[0].status, 'Not tested');
  assert.equal(results.devices[0].channels[0].rawStatus, 'strange status');
  assert.deepEqual([results.clock.start, results.clock.end, results.clock.startMs, results.clock.endMs], [null, null, null, null]);
  const parameters = await parsePronetaFiles([file('S-PARAMETERS.mpr', mpr([parameterModule({ parameters: [
    parameter({ value: null, defaultValue: '999' }),
    parameter({ name: 'Hidden but selected', group: 'Channel 1', value: '123', visible: false }),
  ] })]))], options);
  assert.equal(parameters.devices.length, 0);
  assert.equal(parameters.unassignedChannels.length, 2);
  assert.equal(parameters.unassignedChannels[0].parameters[0].value, '(not recorded)');
  assert.equal(parameters.unassignedChannels[0].parameters[0].rawValue, '');
  assert.equal(parameters.unassignedChannels[1].parameters[0].visible, false);
  assert.equal(parameters.unassignedChannels[1].parameters[0].rawValue, '123');
  assert.ok(parameters.warnings.some((warning) => /DefaultValue was not substituted/.test(warning)));
});

test('different units remain separate series with original previous and current units', async () => {
  const run = await parsePronetaFiles([file('S-log.csv', log([
    [2, 'AI 2xI', event('PD-1001', 0, '4 mA', '5 mA'), '2026-01-20 12:00:00'],
    [2, 'AI 2xI', event('PD-1001', 0, '5 mA', '1 V'), '2026-01-20 12:00:01'],
  ]))], options);
  assert.deepEqual(run.devices[0].channels[0].series.map((series) => series.unit), ['mA', 'V']);
  assert.equal(run.devices[0].channels[0].series[1].points[0].previousUnit, 'mA');
  assert.ok(run.warnings.some((warning) => /changes units/.test(warning)));
});

test('byte-identical source files are hashed exactly and imported once while retaining both filenames', async () => {
  const text = '\uFEFF' + result('s', [{ slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y']] }]);
  const bytes = new TextEncoder().encode(text);
  const run = await parsePronetaFiles([
    { name: 'S.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer },
    file('S-copy.csv', text),
  ], options);
  assert.equal(run.devices[0].channels[0].resultRows.length, 1);
  assert.equal(run.sources.length, 2);
  assert.equal(run.sources[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(run.sources[1].duplicateOf, run.sources[0].id);
  assert.equal(run.sources[1].stationId, run.sources[0].stationId);
});

test('BOM-marked UTF-16 sources decode without changing exact-byte provenance', async () => {
  const text = result('s', [{ slot: 2, name: 'AI 2xRTD', channels: [[1, 'TH-1001', 'OK', 'Temperature °C']] }]);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const run = await parsePronetaFiles([{ name: 'S.csv', arrayBuffer: async () => bytes }], options);
  assert.equal(run.devices[0].channels[0].comment, 'Temperature °C');
  assert.equal(run.sources[0].sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('identical logs from distinct stations preserve both stations and their observations', async () => {
  const text = log([[1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:00']]);
  for (const stationAssignments of [{}, { 'S-A-log.csv': 'Station alpha', 'S-B-log.csv': 'Station beta' }]) {
    const run = await parsePronetaFiles([file('S-A-log.csv', text), file('S-B-log.csv', text)], { ...options, stationAssignments });
    assert.equal(run.stations.length, 2);
    assert.equal(allPoints(run).length, 2);
    assert.notEqual(run.sources[0].stationId, run.sources[1].stationId);
    assert.ok(run.sources.every((source) => !source.duplicateOf));
    assert.equal(new Set(run.devices[0].channels.map((channel) => channel.stationId)).size, 2);
  }
  const sameStation = await parsePronetaFiles([file('S-A-log.csv', text), file('S-B-log.csv', text)], {
    ...options, stationAssignments: { 'S-A-log.csv': 'Same station', 'S-B-log.csv': 'Same station' },
  });
  assert.equal(sameStation.stations.length, 1);
  assert.equal(allPoints(sameStation).length, 1);
  assert.equal(sameStation.sources[1].duplicateOf, sameStation.sources[0].id);
});

test('conflicting recorded applicability cannot turn an ambiguous channel into a pass', async () => {
  const run = await parsePronetaFiles([
    file('S.csv', result('s', [{ slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y', 'OK']] }])),
    file('S-again.csv', result('s', [{ slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y', 'N. a.']] }])),
  ], options);
  assert.equal(run.devices[0].status, 'Not tested');
  assert.equal(run.devices[0].channels[0].resultRows.length, 2);
  assert.match(run.devices[0].channels[0].rawStatus, /OK.*N\. a\./);
});

test('module names containing parentheses do not corrupt order numbers', async () => {
  const run = await parsePronetaFiles([
    file('S.csv', result('s', [{ slot: 16, name: 'Server module V1.2 (0 bytes) ( TEST-ORDER; Serial Number: SYNTHETIC-SERVER )', channels: [] }])),
    file('S-PARAMETERS.mpr', mpr([parameterModule({ slot: 16, name: 'Server module V1.2 (0 bytes)', serial: 'SYNTHETIC-SERVER', parameters: [] }).replace('<OrderNumber></OrderNumber>', '<OrderNumber>TEST-ORDER</OrderNumber>')])),
  ], options);
  assert.equal(run.stations[0].modules[0].name, 'Server module V1.2 (0 bytes)');
  assert.equal(run.stations[0].modules[0].orderNumber, 'TEST-ORDER');
});

test('conflicting exports cannot silently assign a different symbol to an existing physical channel', async () => {
  await assert.rejects(parsePronetaFiles([
    file('S.csv', result('s', [{ slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1001-Y']] }])),
    file('S-again.csv', result('s', [{ slot: 1, name: 'DQ 2x24VDC', channels: [[0, 'V-1002-Y']] }])),
  ], options), { code: 'SOURCE_CONFLICT' });
});

test('DTD/entities, malformed XML, and unsupported CSV are rejected without external resolution', async () => {
  await assert.rejects(parsePronetaFiles([file('S.mpr', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY x SYSTEM "https://example.invalid/secret">]><SerializableCollectionOfIModule>&x;</SerializableCollectionOfIModule>')], options));
  await assert.rejects(parsePronetaFiles([file('S.mpr', '<SerializableCollectionOfIModule><Module></SerializableCollectionOfIModule>')], options), /invalid or unsupported/);
  await assert.rejects(parsePronetaFiles([file('S.csv', 'symbol,value\nexample,1')], options), /not a supported/);
  await assert.rejects(parsePronetaFiles([{ name: 'S.csv', arrayBuffer: async () => new Uint8Array([0xff, 0xff, 0xff]) }], options), /not valid UTF-8/);
});

test('file and event count limits fail explicitly', async () => {
  await assert.rejects(parsePronetaFiles([], options), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(parsePronetaFiles(Array(21).fill(file('S.csv', '')), options), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(parsePronetaFiles([{ name: 'S.csv', size: 10 * 1024 * 1024 + 1, text: 'x' }], options), { code: 'LIMIT_EXCEEDED' });
  const rows = Array.from({ length: 10001 }, () => [1, 'DQ 2x24VDC', event('V-1001-Y', 'a.0', '0', '1', 'Digital output'), '2026-01-20 12:00:00']);
  await assert.rejects(parsePronetaFiles([file('S-log.csv', log(rows))], options), { code: 'LIMIT_EXCEEDED' });
});
