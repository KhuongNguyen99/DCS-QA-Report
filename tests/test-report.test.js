import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createTestReportPdf } from "../src/test-report.js";
import { deviceGraphEntries } from "../src/test-graph-order.js";

const fonts = {
  "NotoSans-Regular.ttf": await readFile(new URL("../public/assets/NotoSans-Regular.ttf", import.meta.url)),
  "NotoSans-Bold.ttf": await readFile(new URL("../public/assets/NotoSans-Bold.ttf", import.meta.url)),
};
const logo = await readFile(new URL("../public/assets/jeevy-logo-black.png", import.meta.url));
const assetResponse = name => name === "jeevy-logo-black.png"
  ? new Response(logo, { headers: { "content-type": "image/png" } })
  : fonts[name] ? new Response(fonts[name]) : null;
const startMs = Date.UTC(2026, 10, 19, 19, 17);
const CLOCK = { basis: "source-local", timeZone: "Source clock (unspecified)", startMs, endMs: startMs + 392_000 };
const setupPng = {
  wide: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAIAAAA/Y+msAAAAGElEQVR4nGN8tkqEARWwJF4oRRNiYsAAAJeCA1IJTjslAAAAAElFTkSuQmCC", "base64"),
  portrait: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAAGCAIAAACJh7NbAAAAHUlEQVR4nGN8tkqEgYGBgYGBJfFCKYTFxAAD+FkAsQ4DWAfKzuIAAAAASUVORK5CYII=", "base64"),
};
const setupPhoto = (id, overrides = {}) => ({
  id, walkdownId: "skid-1", testRunId: "run-1", path: `inspector-1/${id}.png`,
  name: `${id}.png`, width: 6, height: 3, caption: `Saved caption for ${id}`,
  createdAt: "2026-11-19T12:00:00Z", createdBy: "inspector-1", ...overrides,
});

function photoPlacements(stream) {
  return [...stream.matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\s*\/I\d+ Do/g)]
    .map(([, width, height, x, y]) => ({ width: +width, height: +height, x: +x, y: +y }));
}

async function withSetupImages(callback, photoResponse = () => new Response(setupPng.wide, { headers: { "content-type": "image/png" } })) {
  const original = globalThis.fetch;
  const fetched = [], accessed = [];
  globalThis.fetch = async (url, options) => {
    fetched.push({ url: String(url), options });
    return assetResponse(String(url).split("/").pop()) || photoResponse(String(url), options);
  };
  const backend = { walkdownId: "skid-1", getPhotoUrl: async (photo) => {
    accessed.push(structuredClone(photo));
    return `/private/${photo.path}`;
  } };
  try { return await callback({ backend, fetched, accessed }); }
  finally { globalThis.fetch = original; }
}

function runFixture(id = "run-1") {
  const point = (offset, value, extra = {}) => ({
    time: `2026-11-19 19:17:${String(offset / 1000).padStart(2, "0")}`,
    timeMs: startMs + offset, value, previousValue: 0, rawValue: String(value), previousRawValue: "0",
    valid: true, sourceId: "source-log", sourceRow: 3, ...extra,
  });
  return {
    id, schemaVersion: 1, walkdownId: "skid-1", runVersion: 1, name: `Run ${id}`,
    software: { name: "Siemens PRONETA Basic", version: "Version entered by tester" }, clock: { ...CLOCK },
    sources: [
      { id: "source-results", name: "synthetic-results.csv", kind: "results", stationId: "station-1", size: 1000, sha256: "ab".repeat(32) },
      { id: "source-log", name: "synthetic-log.csv", kind: "log", stationId: "station-1", size: 2000, sha256: "cd".repeat(32) },
    ],
    stations: [{ id: "station-1", name: "Station Example", serialNumber: "SYNTHETIC", macAddress: "00:00:00:00:00:00",
      modules: [{ slot: 3, name: "Analog example", orderNumber: "EXAMPLE-001", serialNumber: "MOD-SYNTHETIC",
        parameters: [{ name: "Diagnostics: No supply voltage L+", value: "Enabled", rawValue: "1", group: "Module", recordIndex: 128 }] }] }],
    devices: [{ id: "device-1", name: "RTD-EXAMPLE", status: "Failed", channels: [{
      id: "channel-1", stationId: "station-1", slot: 3, channel: 0, sourceChannel: "Channel 1", symbolicName: "RTD-EXAMPLE", role: "Analog input",
      status: "Failed", rawStatus: "Error", comment: "Investigate the wiring before retest.",
      parameters: [
        { name: "Measurement range", value: "0", rawValue: "0", enumId: "RangeEnum", group: "Measurement", recordIndex: 128 },
        { name: "Temperature unit", value: "Celsius", rawValue: "0", enumId: "UnitsEnum", group: "Measurement", recordIndex: 128 },
      ],
      series: [{ id: "series-1", name: "Temperature", kind: "analog", unit: "°C", points: [
        point(0, 19.7), point(2000, null, { valid: false, rawValue: "7FFFH", previousValue: 19.7, previousRawValue: "19.7" }),
        point(3000, 19.9, { previousValue: null, previousRawValue: "7FFFH" }),
      ] }],
    }] }, { id: "device-2", name: "VALVE-EXAMPLE", status: "Passed", channels: [{
      id: "channel-2", stationId: "station-1", slot: 1, channel: 1, sourceChannel: "Channel 1", symbolicName: "VALVE-EXAMPLE", role: "Digital output",
      status: "Passed", rawStatus: "OK", comment: "", parameters: [],
      series: [{ id: "series-2", name: "Output state", kind: "digital", unit: "", points: [
        point(300_000, 1, { time: "2026-11-19 19:22:00" }), point(392_000, 0, { time: "2026-11-19 19:23:32" }),
      ] }],
    }] }],
    unassignedChannels: [{ id: "unused", stationId: "station-1", slot: 3, channel: 2, sourceChannel: "Channel 3", symbolicName: "N/A",
      status: "Not applicable", rawStatus: "N.a.", parameters: [{ name: "Unused-channel setting", value: "Disabled", rawValue: "0" }], series: [] }],
    warnings: ["Synthetic warning retained for review."],
    unparsedEvents: [{ sourceId: "source-log", sourceRow: 12, stationId: "station-1", slot: 3,
      time: "2026-11-19 19:17:10", description: "Unrecognized synthetic event", reason: "Unsupported event description" }],
  };
}

function closedState() {
  return { project: { status: "closed", revision: 2, walkdownId: "skid-1", skidName: "Skid Example",
    closedAt: "2026-11-20T11:30:00Z", closedByName: "Inspector Example" }, testRuns: [runFixture()] };
}

function graphOrderDevice(prefix, count = 8) {
  const types = [
    ["command", "digital", "", [0, 1]], ["feedback_FB", "analog", "V", [0.3, 0.1]],
    ["current", "analog", "mA", [4, 20]], ["voltage", "analog", "V", [2, 3]],
    ["temperature", "analog", "°C", [21, 25]], ["state", "digital", "", [1, 0]],
    ["pressure", "analog", "mA", [5, 15]], ["position", "analog", "mA", [6, 18]],
  ];
  const channels = [];
  for (let index = 0; index < count; index += 1) {
    const [suffix, kind, unit, values] = types[index];
    const channelIndex = Math.floor(index / 2);
    if (!channels[channelIndex]) channels[channelIndex] = {
      id: `${prefix}-channel-${channelIndex}`, symbolicName: `${prefix} input bank ${channelIndex + 1}`,
      stationId: "station-1", slot: channelIndex + 1, channel: channelIndex,
      sourceChannel: `Channel ${channelIndex + 1}`, role: "Input", status: "Passed", parameters: [], series: [],
    };
    const points = values.map((value, pointIndex) => ({
      timeMs: startMs + index * 10_000 + pointIndex * 2000 + 1000,
      time: `${prefix} recorded time ${index}:${pointIndex}`, value, previousValue: 0,
      rawValue: String(value), valid: true, sourceId: "source-log", sourceRow: index * 3 + pointIndex + 10,
    }));
    if (index === 1 || index === 6) points.splice(1, 0, {
      timeMs: startMs + index * 10_000 + 2000, time: `${prefix} invalid time ${index}`,
      value: null, rawValue: `${prefix} INVALID-${index}`, valid: false, sourceId: "source-log", sourceRow: index + 40,
    });
    channels[channelIndex].series.push({ id: `${prefix}-graph-${index}`, name: `${prefix} ${suffix}`, kind, unit, points });
  }
  return { id: `${prefix}-device`, name: `${prefix} device`, status: "Passed", channels };
}

async function pdfContent(blob) {
  const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  const objects = new Map([...raw.matchAll(/(?:^|\n)(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj/g)].map(([, id, body]) => [id, body]));
  const streamFor = (body) => {
    const marker = body?.match(/stream\r?\n/);
    const length = Number(body?.match(/\/Length\s+(\d+)/)?.[1]);
    if (!marker || !Number.isSafeInteger(length)) return "";
    const stream = body.slice(marker.index + marker[0].length, marker.index + marker[0].length + length);
    try { return inflateSync(Buffer.from(stream, "latin1")).toString("latin1"); }
    catch { return stream; }
  };
  const fonts = new Map();
  const resources = [...objects.values()].find((body) => /\/Font\s*<</.test(body));
  for (const [, font, id] of resources.matchAll(/\/F(\d+)\s+(\d+) 0 R/g)) {
    const unicodeId = objects.get(id)?.match(/\/ToUnicode\s+(\d+) 0 R/)?.[1];
    if (!unicodeId) continue;
    fonts.set(font, new Map([...streamFor(objects.get(unicodeId)).matchAll(/<([0-9a-fA-F]{4})><([0-9a-fA-F]{4})>/g)]
      .map(([, glyph, code]) => [glyph.toUpperCase(), String.fromCharCode(parseInt(code, 16))])));
  }
  const streams = [...objects.values()].filter((body) => /\/Type\s*\/Page\b/.test(body))
    .map((body) => streamFor(objects.get(body.match(/\/Contents\s+(\d+) 0 R/)?.[1])));
  const blocks = streams.map((stream) => [...stream.matchAll(/BT\r?\n([\s\S]*?)\r?\nET/g)].map(([, block]) => {
    const hex = block.match(/<([0-9a-fA-F]+)>\s*Tj/)?.[1];
    const font = block.match(/\/F(\d+)\s+[\d.]+\s+Tf/)?.[1];
    const text = hex ? [...hex.matchAll(/.{4}/g)].map(([glyph]) => fonts.get(font)?.get(glyph.toUpperCase()) || "").join("")
      : block.match(/\((.*?)\)\s*Tj/)?.[1] || "";
    const xy = block.match(/([\d.+-]+) ([\d.+-]+) Td/);
    const color = block.match(/^([\d.]+) ([\d.]+) ([\d.]+) rg\r?$/m)?.slice(1).map(Number);
    return { text, color, x: xy ? Number(xy[1]) : null, y: xy ? 612 - Number(xy[2]) : null };
  }));
  const pages = blocks.map((page) => page.map((block) => block.text).join("\n"));
  return { raw, text: pages.join("\n"), pages, streams, blocks };
}

// Read the actual PDF line operators, including their stroke color and dash
// state, so the regression checks the exported vectors rather than a mock.
function pdfLines(stream) {
  let color = [], dash = [], cursor = null, path = [];
  const result = [];
  for (const line of stream.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const operator = tokens.at(-1);
    if (operator === "RG" && tokens.length === 4) color = tokens.slice(0, 3).map(Number);
    else if (operator === "d") {
      const pattern = line.match(/\[([^\]]*)\]/)?.[1].trim();
      dash = pattern ? pattern.split(/\s+/).map(Number) : [];
    } else if (operator === "m" && tokens.length === 3) cursor = { x: Number(tokens[0]), y: Number(tokens[1]) };
    else if (operator === "l" && tokens.length === 3 && cursor) {
      const next = { x: Number(tokens[0]), y: Number(tokens[1]) };
      path.push({ from: cursor, to: next }); cursor = next;
    } else if (operator === "S") {
      result.push(...path.map(segment => ({ ...segment, color: [...color], dash: [...dash] })));
      path = []; cursor = null;
    } else if (["f", "F", "f*", "n"].includes(operator)) { path = []; cursor = null; }
  }
  return result;
}

function readPlot(result, title) {
  const page = result.blocks.findIndex(blocks => blocks.some(block => block.text === title));
  assert.ok(page >= 0, `Missing graph ${title}`);
  const heading = result.blocks[page].find(block => block.text === title);
  const lines = pdfLines(result.streams[page]);
  const hasColor = (line, rgb) => line.color.length === 3
    && line.color.every((value, index) => Math.abs(value - rgb[index] / 255) < 0.005);
  const grid = lines.filter(line => hasColor(line, [213, 222, 229])
    && line.from.y === line.to.y && Math.abs(line.from.x - heading.x - 49) < 0.01
    && 612 - line.from.y > heading.y && 612 - line.from.y < heading.y + 105);
  assert.ok(grid.length >= 2, `Missing plot grid for ${title}`);
  const left = grid[0].from.x;
  const right = grid[0].to.x;
  const bottom = Math.min(...grid.map(line => line.from.y));
  const top = Math.max(...grid.map(line => line.from.y));
  const inside = point => point.x >= left - 0.01 && point.x <= right + 0.01
    && point.y >= bottom - 0.01 && point.y <= top + 0.01;
  const timeTicks = result.blocks[page].filter(block => /^\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(block.text)
    && Math.abs(block.y - (612 - bottom + 15)) < 0.01
    && block.x >= left - 30 && block.x <= right + 0.01).sort((a, b) => a.x - b.x).map(block => block.text);
  return { page, left, right, width: right - left, height: top - bottom, timeTicks,
    traces: lines.filter(line => hasColor(line, [24, 108, 161]) && inside(line.from) && inside(line.to)) };
}

async function withFonts(callback) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const name = String(url).split("/").pop();
    requested.push(name);
    const response = assetResponse(name);
    assert.ok(response, `Unexpected asset request: ${url}`);
    return response;
  };
  try { return await callback(requested); }
  finally { globalThis.fetch = original; }
}

test("test PDF rejects drafts, incomplete approval data, wrong skid, and missing saved runs before fetching assets", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Invalid state must be rejected before fetching fonts");
  try {
    let state = closedState();
    state.project.status = "draft";
    await assert.rejects(createTestReportPdf({ state }), /Approve and close/);
    state = closedState(); state.project.closedAt = "2026-11-20 11:30";
    await assert.rejects(createTestReportPdf({ state }), /approval date/);
    state = closedState(); delete state.testRuns;
    await assert.rejects(createTestReportPdf({ state }), /test runs are missing/);
    state = closedState(); state.testRuns[0].walkdownId = "different-skid";
    await assert.rejects(createTestReportPdf({ state }), /another skid/);
    state = closedState(); state.testRuns[0].software.version = "";
    await assert.rejects(createTestReportPdf({ state }), /software name or version/);
    await assert.rejects(createTestReportPdf({ state: closedState(), runId: "missing-run" }), /No saved test run/);
    state = closedState(); state.testRuns[0].clock.endMs = startMs + 1000;
    await assert.rejects(createTestReportPdf({ state }), /outside the shared/);
  } finally { globalThis.fetch = original; }
});

test("approved test PDF preserves evidence and run context while fitting each device's time axis", async () => {
  await withFonts(async (requested) => {
    const state = closedState();
    state.project.checkedByName = "Nguyễn Văn An";
    state.project.closedByTitle = "Project Manager";
    const run = state.testRuns[0];
    const channel = run.devices[0].channels[0];
    run.devices.push({ ...run.devices[0], id: "na-device", name: "N.A.", comment: "Skipped device comment" });
    run.devices[0].channels.push({
      ...channel, id: "na-channel", status: "Not applicable", rawStatus: "N.a.",
      parameters: [{ name: "Skipped channel setting", value: "1" }],
    });
    const savedState = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.deepEqual(state, savedState, "The export leaves approved evidence intact");
    assert.doesNotMatch(result.text, /Overall test run comment|Device comment/, "legacy runs do not invent engineer comments");
    assert.deepEqual(requested.sort(), ["NotoSans-Bold.ttf", "NotoSans-Regular.ttf", "jeevy-logo-black.png"]);
    assert.match(result.pages[0], /450k skid x7 - DCS\nTest Result - Skid Example\nRevision 2/);
    assert.match(result.pages[0], /November 20, 2026/);
    assert.match(result.pages[1], /Configured settings/);
    assert.match(result.pages[0], /Software: Siemens PRONETA Basic \| Version: Version entered by tester/);
    assert.match(result.pages[0], /Run time span: 2026-11-19 19:17:00 to 2026-11-19 19:23:32/);
    assert.match(result.pages[0], /Clock: Source clock \(unspecified\)/);
    assert.match(result.pages[0], /Checked by: Nguyễn Văn An\nSigned off by: Inspector Example, Project Manager/);
    assert.doesNotMatch(result.text, /Approved by:/);
    assert.doesNotMatch(result.pages.slice(1).join("\n"), /Software:|Run time span:|Clock:|Checked by:|Signed off by:/);
    assert.doesNotMatch(result.text, /Stations and module parameters|Set parameters/);
    assert.equal(photoPlacements(result.streams[0]).length, 1, "the QC cover logo is on the first page");
    for (const text of ["I/O test report", "Skid Example", "Revision 2", "Inspector Example", "2026-11-20 11:30:00 UTC",
      "Siemens PRONETA Basic", "Version entered by tester", "RTD-EXAMPLE", "VALVE-EXAMPLE", "Test Result: Failed (source: Error)",
      "Test Result: Passed", "Celsius", "7FFFH", "synthetic-log.csv, row 3",
      "Supply voltage"])
      assert.ok(result.text.includes(text), `Missing report text: ${text}`);
    assert.doesNotMatch(result.text, /Sources and import\s+notes|SHA-256|Synthetic warning retained for review|Unrecognized synthetic event/);
    assert.doesNotMatch(result.text, /N\/A|Not applicable|Unused-channel setting|Unassigned channels|Skipped device comment|Skipped channel setting|Recorded wiring result/i);
    assert.ok(result.streams.slice(1).every(stream => photoPlacements(stream).length === 0), "charts remain vector shapes");
    assert.match(result.raw, /D:20261120113000\+00'00'/, "PDF metadata uses approval time, not export time");
    assert.doesNotMatch(result.text, /\(source: OK\)/i);
    const cells = result.blocks.flat();
    for (const [label, rgb] of [["Passed", [31, 105, 57]], ["Failed", [170, 49, 43]]]) {
      const matching = cells.filter(({ text }) => text === label || text.startsWith("Test Result: " + label));
      assert.ok(matching.length >= 2, "the result appears in the summary and on its device page");
      assert.ok(matching.every(({ color }) => color?.every((value, index) => Math.abs(value - rgb[index] / 255) < 0.005)));
    }
    const graphPages = result.pages.filter(page => /\n(?:Temperature|Output state)\n/.test(page));
    assert.equal(graphPages.length, 2);
    assert.match(graphPages[0], /\n\u00b0C\n/);
    assert.match(graphPages[1], /\nState\n/);
    assert.match(graphPages[0], /Figure 1\. Measured temperature for the analog input\. Station Example \| Slot 3 \| Channel 1/);
    for (const page of graphPages) {
      assert.doesNotMatch(page, /Test run:.*Software:|observed change\(s\)|Graph span:|Shared run span:|connect recorded changes/);
    }
    assert.ok(graphPages.some(page => page.includes("19:17:04")), "the short temperature series has a fitted axis");
    assert.ok(graphPages.some(page => page.includes("19:21:56")), "the late digital series starts near its observations");
    result.pages.forEach((page, index) => {
      assert.ok(page.includes(`Page ${index + 1} of ${result.pages.length}`));
      assert.ok(page.includes("Revision 2 | Skid: Skid Example"));
    });
  });
});

test("figure captions expand instrument tags and preserve channel locations", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const sample = run.devices[0].channels[0];
    run.stations[0].name = "rio-a";
    run.devices = [
      { tag: "DP-3500#1", unit: "mA" },
      { tag: "PD-3500#1", unit: "mA" },
      { tag: "TH-3510", unit: "\u00b0C" },
      { tag: "V-3511-POS", unit: "mA" },
    ].map(({ tag, unit }) => ({
      id: tag, name: tag, status: "Passed",
      channels: [{
        ...sample, id: tag, slot: 11, sourceChannel: "Channel 2", symbolicName: tag,
        status: "Passed", rawStatus: "OK", parameters: [],
        series: [{ ...sample.series[0], name: tag, unit }],
      }],
    }));
    const result = await pdfContent(await createTestReportPdf({ state }));
    const text = result.text.replace(/\s+/g, " ");
    assert.match(text, /Figure 1\. Measured current of differential pressure transducer\. rio-a \| Slot 11 \| Channel 2/);
    assert.match(text, /Figure 2\. Measured current of pressure transducer\. rio-a \| Slot 11 \| Channel 2/);
    assert.match(text, /Figure 3\. Measured temperature for thermocouple tag TH-3510\. rio-a \| Slot 11 \| Channel 2/);
    assert.match(text, /Figure 4\. Measured current of positioner\. rio-a \| Slot 11 \| Channel 2/);
  });
});

test("long cover details fit on the first page above the footer", async () => {
  await withFonts(async () => {
    const state = closedState();
    state.project.skidName = "W".repeat(120);
    state.project.checkedByName = "W".repeat(120);
    state.project.closedByName = "W".repeat(120);
    state.project.closedByTitle = "W".repeat(120);
    const run = state.testRuns[0];
    run.software.name = "W".repeat(120);
    run.software.version = "W".repeat(80);
    run.clock.timeZone = "W".repeat(120);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.match(result.pages[0], /Software:/);
    assert.match(result.pages[0], /Version:/);
    assert.match(result.pages[0], /Run time span:/);
    assert.match(result.pages[0], /Clock:/);
    const cover = result.pages[0].replace(/\s+/g, "");
    assert.ok(cover.includes(`Checkedby:${"W".repeat(120)}`));
    assert.ok(cover.includes(`Signedoffby:${"W".repeat(120)},${"W".repeat(120)}`));
    const footerStart = result.blocks[0].findIndex(({ text }) => text.startsWith("Approved date:"));
    assert.ok(result.blocks[0].slice(0, footerStart).every(({ y }) => y <= 548));
    assert.doesNotMatch(result.pages.slice(1).join("\n"), /Checked by:|Signed off by:/);
    assert.doesNotMatch(result.pages.slice(1).join("\n"), /Test run details \(continued\)/);
  });
});

test("selected run exports the loaded archived revision and excludes other runs", async () => {
  await withFonts(async () => {
    const state = closedState();
    state.project.revision = 1;
    const archived = runFixture("archived");
    archived.name = "Archived run";
    archived.software.version = "Saved version 1";
    archived.comment = "Archived overall review comment";
    archived.devices[0].comment = "Archived device review comment";
    const newer = runFixture("newer");
    newer.name = "Unselected new run";
    newer.software.version = "Version that must not appear";
    newer.comment = "Unselected overall review comment";
    newer.devices[0].comment = "Unselected device review comment";
    state.testRuns = [archived, newer];
    const result = await pdfContent(await createTestReportPdf({ state, runId: "archived" }));
    assert.match(result.text, /Revision 1/);
    assert.match(result.text, /Saved version 1/);
    assert.match(result.text, /Archived overall review comment/);
    assert.match(result.text, /Archived device review comment/);
    assert.match(result.pages[0], /Checked by: Not recorded\nSigned off by: Inspector Example/);
    assert.equal(Object.hasOwn(state.project, "checkedByName"), false);
    assert.doesNotMatch(result.text, /Unselected new run|Version that must not appear|Unselected overall review comment|Unselected device review comment/);
    const all = await pdfContent(await createTestReportPdf({ state }));
    assert.match(all.pages[0], /Archived run/);
    assert.match(all.pages[0], /Unselected new run/);
    assert.match(all.pages[0], /Version that must not appear/);
    assert.match(all.pages[0], /Run time span/);
    assert.match(all.pages[0], /Checked by: Not recorded\nSigned off by: Inspector Example/);
    assert.match(all.text, /Archived overall review comment/);
    assert.match(all.text, /Archived device review comment/);
    assert.match(all.text, /Unselected overall review comment/);
    assert.match(all.text, /Unselected device review comment/);
    assert.equal(all.text.match(/Overall test run comment/g)?.length, 2, "each run keeps its own overall comment");
  });
});

test("export captures the approved payload before asynchronous font loading", async () => {
  const original = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    await gate;
    return assetResponse(String(url).split("/").pop());
  };
  try {
    const state = closedState();
    state.project.checkedByName = "Saved Checker";
    state.project.closedByName = "Saved Signatory";
    state.project.closedByTitle = "Saved Title";
    state.testRuns[0].comment = "Approved overall review comment";
    state.testRuns[0].devices[0].comment = "Approved device review comment";
    const excluded = state.testRuns[0].devices[0].channels[0].series[0].points[1];
    excluded.rawValue = "EXCLUDED-AT-EXPORT";
    excluded.excluded = true;
    const pending = createTestReportPdf({ state });
    state.project.revision = 99;
    state.project.skidName = "Mutated skid";
    state.project.checkedByName = "Mutated Checker";
    state.project.closedByName = "Mutated Signatory";
    state.project.closedByTitle = "Mutated Title";
    state.testRuns[0].devices[0].name = "Mutated device";
    state.testRuns[0].software.version = "Mutated software";
    state.testRuns[0].comment = "Mutated overall comment";
    state.testRuns[0].devices[0].comment = "Mutated device comment";
    excluded.excluded = false;
    release();
    const result = await pdfContent(await pending);
    assert.match(result.text, /Revision 2/);
    assert.match(result.text, /RTD-EXAMPLE/);
    assert.match(result.text, /Approved overall review comment/);
    assert.match(result.text, /Approved device review comment/);
    assert.match(result.pages[0], /Checked by: Saved Checker\nSigned off by: Saved Signatory, Saved Title/);
    assert.doesNotMatch(result.text, /Removed events|EXCLUDED-AT-EXPORT|Mutated|Revision 99/);
  } finally { globalThis.fetch = original; }
});

test("long summarized settings paginate completely above the footer", async () => {
  await withFonts(async () => {
    const state = closedState();
    const longValue = Array.from({ length: 160 }, (_, index) => `Long-value-piece-${index + 1}`).join(" ");
    state.testRuns[0].devices[0].channels[0].parameters = [
      { name: "Type/range of measurement", value: longValue },
      { name: "Smoothing", value: "Inactive detail to omit" },
    ];
    const result = await pdfContent(await createTestReportPdf({ state }));
    for (let index = 1; index <= 160; index++) assert.ok(result.text.includes(`Long-value-piece-${index}`));
    assert.doesNotMatch(result.text, /Inactive detail to omit/);
    const continued = result.pages.filter(page => page.includes("Configured settings (continued)"));
    assert.ok(continued.length > 0);
    assert.ok(continued.filter(page => /Long-value-piece-/.test(page)).every(page => page.includes("Shared diagnostics")));
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
  });
});

test("configured settings group modules and identify different diagnostics and ranges by location", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const module = run.stations[0].modules[0];
    module.orderNumber = "6ES7 134-6GF00-0AA1";
    module.name = "AI 8xI";
    module.parameters = [
      { name: "Diagnostics: Undervoltage", value: "1", rawValue: "1", enumId: "Diag:Undervoltage" },
      { name: "Potential group", value: "1", rawValue: "1", enumId: "BaseUnit" },
    ];
    const output = (slot, voltage) => ({ slot, name: "DQ 8x24VDC/0.5A HF", orderNumber: "6ES7 132-6BF01-0CA0",
      parameters: [{ name: "Diagnostics: Wire break", value: "1" }, { name: "Diagnostics: No supply voltage L+", value: voltage }] });
    run.stations[0].modules.push(output(1, "1"), output(2, "0"), { slot: 4, name: "Empty module", parameters: [] });
    const device = run.devices[0];
    const channel = device.channels[0];
    channel.role = "Positioner";
    channel.symbolicName = "V-3501-Y-POS";
    const range = value => ({ name: "Type/range of measurement", value, enumId: "Measurement type/-area" });
    channel.parameters = [
      range("770"),
      { name: "Smoothing", value: "0", rawValue: "0", enumId: "Smoothing" },
      { name: "Reaction to CPU STOP", value: "0", rawValue: "0", enumId: "Substitute value behaviour digital" },
    ];
    device.channels.push({ ...structuredClone(channel), id: "second-channel", channel: 1,
      sourceChannel: "Channel 2", symbolicName: "V-3502-POS", parameters: [range("771")], series: [] },
    { ...structuredClone(channel), id: "third-channel", channel: 2,
      sourceChannel: "Channel 3", symbolicName: "V-3503-POS", parameters: [range("771")], series: [] });
    const valve = run.devices[1].channels[0];
    Object.assign(valve, { role: "Command", symbolicName: "V-3501" });
    run.devices[1].channels.push({ ...structuredClone(valve), id: "other-output", slot: 2, symbolicName: "V-3502", series: [] });
    run.unassignedChannels = [{ ...structuredClone(channel), id: "legacy-channel", slot: 5,
      parameters: [range("265")],
      series: [] }];
    const result = await pdfContent(await createTestReportPdf({ state }));
    const summaryPage = result.pages.findIndex(page => page.includes("Device name\nSlot\nChannels\nTest Result"));
    const settings = result.pages.slice(1, summaryPage).join("\n");
    assert.match(settings, /Valve commands\nStation Example slots 1, 2\n2 of 16\n24 V DC digital output\nWire break/);
    assert.match(settings, /Positioner feedback\nStation Example slot 3\n3 of 8\n2-wire current, 4-20 mA\n2 of 3 channels\nUndervoltage/);
    assert.match(settings, /Settings that differ/);
    assert.match(settings, /Station Example slot 2\nSupply voltage monitoring\nOff \(on for the other channels in this group\)/);
    assert.match(settings, /Station Example slot 3 \| Channel 0 \| V-3501-Y-POS\nSignal range\n2-wire current, 0-20 mA/);
    assert.match(settings, /^265$/m, "the code stays visible without the module order number");
    assert.doesNotMatch(settings, /Reaction to CPU STOP|encoded selection|Potential group|Smoothing|Channel settings|Empty module/i);
    assert.equal(settings.match(/Valve commands/g)?.length, 1, "matching outputs share a summary row");
    const guide = settings.slice(settings.indexOf("What the diagnostics detect"));
    assert.match(guide, /^What the diagnostics detect/);
    assert.match(guide, /Wire break\nDetects broken wiring or a disconnected device\./);
    assert.match(guide, /Supply voltage\nFlags missing or low DC power at the module\./);
    assert.match(guide, /Undervoltage\nFlags a supply voltage below the module's minimum\./);
    assert.doesNotMatch(guide, /HART|Reference junction/, "the guide omits diagnostics absent from the settings");
  });
});

test("runs without selected parameters omit the configured settings section", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    run.stations[0].modules[0].parameters = [];
    for (const device of run.devices) for (const channel of device.channels) channel.parameters = [];
    for (const channel of run.unassignedChannels)
      channel.parameters = [{ name: "Reaction to CPU STOP", value: "0" }];
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.doesNotMatch(result.text, /Configured settings|Stations and module parameters/);
    assert.match(result.pages[0], /Software: Siemens PRONETA Basic/);
    assert.match(result.pages[1], /Device name/);
  });
});

test("result-only runs keep Not tested distinct without fabricating a graph or pass", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    run.clock = { basis: "source-local", timeZone: "Source clock (unspecified)", startMs: null, endMs: null };
    run.devices = [run.devices[0]];
    run.devices[0].status = "Not tested";
    run.devices[0].channels[0].status = "Not tested";
    run.devices[0].channels[0].rawStatus = "Unrecorded";
    run.devices[0].channels[0].series = [];
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.match(result.text, /No dated event log imported/);
    assert.match(result.text, /Test Result: Not tested \(source: Unrecorded\)/);
    assert.doesNotMatch(result.text, /connect recorded changes|Test Result: Passed/);
  });
});

test("explicit-offset logs label normalized graph coordinates as UTC and retain original invalid tokens and times", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    run.clock.basis = "absolute";
    run.clock.timeZone = "Source clock (timezone not recorded)";
    run.devices[0].channels[0].series[0].points[1].time = "2026-11-19T14:17:02-05:00";
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.match(result.text, /Clock: UTC/);
    assert.match(result.text, /2026-11-19T14:17:02-05:00/);
    assert.doesNotMatch(result.text, /Clock: Source clock \(timezone not recorded\)/);
  });
});

test("setup pages use only the selected approved photo snapshot with uncropped images and revision footers", async () => {
  const state = closedState();
  const archived = runFixture("archived");
  archived.setupPhotos = [
    setupPhoto("wide", { testRunId: "archived", caption: "Approved overview caption" }),
    setupPhoto("portrait", { testRunId: "archived", width: 3, height: 6, caption: "Approved detail caption" }),
  ];
  const newer = runFixture("newer");
  newer.setupPhotos = [setupPhoto("unselected", { testRunId: "newer", caption: "Newer caption must not appear" })];
  state.testRuns = [archived, newer];
  await withSetupImages(async ({ backend, fetched, accessed }) => {
    const progress = [];
    const pending = createTestReportPdf({ state, runId: "archived", backend, onProgress: message => progress.push(message) });
    archived.setupPhotos[0].caption = "Mutated current caption";
    archived.setupPhotos[0].path = "inspector-1/mutated.png";
    const result = await pdfContent(await pending);
    assert.deepEqual(accessed.map(photo => photo.path), ["inspector-1/wide.png", "inspector-1/portrait.png"]);
    assert.equal(accessed[0].caption, "Approved overview caption");
    assert.doesNotMatch(result.text, /Mutated|Newer caption|unselected\.png/);
    const photoPages = result.pages.map((text, page) => ({ text, page, images: photoPlacements(result.streams[page]) }))
      .filter(page => page.page > 0 && page.images.length);
    assert.equal(photoPages.length, 2);
    const firstDevicePage = result.pages.findIndex(page => page.split("\n")[2] === "RTD-EXAMPLE");
    for (let index = 0; index < photoPages.length; index += 1) {
      const { text, page, images } = photoPages[index];
      assert.match(text, /Run archived - Setup/);
      assert.match(text, new RegExp(`Photo ${index + 1} of 2`));
      assert.match(text, /Revision 2 \| Skid: Skid Example/);
      assert.match(text, /Approved: 2026-11-20 11:30:00 UTC/);
      assert.equal(images.length, 1);
      assert.ok(page < firstDevicePage, "setup photos precede device pages");
      const image = images[0];
      assert.ok(Math.abs(image.width / image.height - (index === 0 ? 2 : 0.5)) < 0.00001);
      assert.ok(image.x >= 43.19 && image.x + image.width <= 748.81);
      assert.ok(612 - image.y <= 548.01, "the image stays above the footer");
    }
    assert.match(photoPages[0].text, /Approved overview caption/);
    assert.match(photoPages[1].text, /Approved detail caption/);
    assert.ok(fetched.filter(item => item.url.startsWith("/private/")).every(item => item.options.cache === "no-store"));
    assert.equal(progress.at(-1), "Test report ready");
  }, url => new Response(url.includes("portrait") ? setupPng.portrait : setupPng.wide, { headers: { "content-type": "image/png" } }));
});

test("setup photo scope and metadata are checked before assets load", async () => {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("No assets expected"); };
  try {
    const backend = { getPhotoUrl: async () => "/private/setup.png" };
    for (const [photos, message] of [
      [null, /photo list is invalid/],
      [[setupPhoto("photo", { walkdownId: "other-skid" })], /another skid/],
      [[setupPhoto("photo", { testRunId: "other-run" })], /another test run/],
      [[setupPhoto("photo", { caption: "x".repeat(1001) })], /invalid metadata/],
      [[setupPhoto("photo", { width: 0 })], /invalid metadata/],
      [[setupPhoto("photo", { path: "https:\/\/example.invalid/image.png" })], /invalid metadata/],
      [[setupPhoto("same"), setupPhoto("same")], /invalid metadata/],
      [Array.from({ length: 31 }, (_, index) => setupPhoto(`photo-${index}`)), /photo list is invalid/],
    ]) {
      const state = closedState(); state.testRuns[0].setupPhotos = photos;
      await assert.rejects(createTestReportPdf({ state, backend }), message);
    }
    const state = closedState(); state.testRuns[0].setupPhotos = [setupPhoto("photo")];
    await assert.rejects(createTestReportPdf({ state }), /Connect to the private photo storage/);
    await assert.rejects(createTestReportPdf({ state, backend: { ...backend, walkdownId: "other-skid" } }), /connection belongs to another skid/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = original; }
});

test('PDF setup pages follow the saved array order instead of filename or creation time', async () => {
  const state = closedState();
  state.testRuns[0].setupPhotos = [
    setupPhoto('z', { createdAt: '2026-11-20T12:00:00Z' }),
    setupPhoto('a', { createdAt: '2026-11-19T12:00:00Z' }),
    setupPhoto('m', { createdAt: '2026-11-19T18:00:00Z' }),
  ];
  await withSetupImages(async ({ backend, accessed }) => {
    const result = await pdfContent(await createTestReportPdf({ state, backend }));
    const pages = result.pages.filter((text, index) => index > 0 && photoPlacements(result.streams[index]).length);
    assert.deepEqual(accessed.map(photo => photo.id), ['z', 'a', 'm']);
    for (const [index, id] of ['z', 'a', 'm'].entries()) {
      assert.match(pages[index], new RegExp(`Photo ${index + 1} of 3`));
      assert.match(pages[index], new RegExp(`Saved caption for ${id}`));
    }
  });
});

test("missing, oversized, or unreadable setup photos stop export instead of omitting evidence", async () => {
  const state = closedState(); state.testRuns[0].setupPhotos = [setupPhoto("photo")];
  const before = structuredClone(state);
  let cancelled = false;
  for (const [respond, message] of [
    [() => new Response("missing", { status: 404 }), /setup photo "photo.png".*HTTP 404/],
    [() => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), /JPEG, PNG, or WebP/],
    [() => new Response(setupPng.wide, { headers: { "content-type": "image/png", "content-length": String(12 * 1024 * 1024 + 1) } }), /12 MB limit/],
    [() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/png" } }), /12 MB limit/],
    [() => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } }), /image is empty/],
    [() => new Response("not a PNG", { headers: { "content-type": "image/png" } }), /could not be decoded/],
    [() => new Response(setupPng.portrait, { headers: { "content-type": "image/png" } }), /dimensions differ/],
  ]) await withSetupImages(async ({ backend }) => {
    await assert.rejects(createTestReportPdf({ state, backend }), message);
  }, respond);
  await withSetupImages(async () => {
    await assert.rejects(createTestReportPdf({ state, backend: { getPhotoUrl: async () => { throw new Error("Access denied"); } } }), /Could not access setup photo.*Access denied/);
  });
  assert.equal(cancelled, true, "a body exceeding the byte limit is cancelled");
  assert.deepEqual(state, before, "failed exports do not alter approved evidence");
});

test("long setup captions paginate fully without losing photos or crossing the footer", async () => {
  const state = closedState();
  state.testRuns[0].setupPhotos = [
    setupPhoto("first", { caption: Array.from({ length: 55 }, (_, index) => `Caption-line-${index + 1}`).join("\n") }),
    setupPhoto("second", { caption: "Following setup photo caption" }),
  ];
  const before = structuredClone(state);
  await withSetupImages(async ({ backend }) => {
    const result = await pdfContent(await createTestReportPdf({ state, backend }));
    for (let index = 1; index <= 55; index++) assert.ok(result.text.includes(`Caption-line-${index}`));
    assert.match(result.text, /Setup \(continued\)/);
    assert.match(result.text, /Following setup photo caption/);
    assert.equal(result.streams.slice(1).flatMap(photoPlacements).length, 2);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
    assert.deepEqual(state, before);
  });
});

test("PDF connects analog values and digital steps, draws held tails, and breaks at invalid readings", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const points = entries => entries.map(([offset, value]) => ({
      timeMs: startMs + offset, time: "Synthetic source time", value, valid: value !== null,
      rawValue: value === null ? "Invalid" : String(value), previousValue: 0,
      previousRawValue: "0", sourceId: "source-log", sourceRow: 2,
    }));
    const cases = [
      { name: "Analog ramp", kind: "analog", points: points([[0, 4], [196_000, 20]]) },
      { name: "Digital steps", kind: "digital", points: points([[98_000, 1], [196_000, 0]]) },
      { name: "Invalid gap", kind: "analog", points: points([[0, 4], [98_000, 8], [196_000, null], [294_000, 12]]) },
      { name: "Invalid final reading", kind: "analog", points: points([[0, 4], [196_000, 8], [294_000, null]]) },
    ];
    run.devices = cases.map((series, index) => ({ id: `vector-${index}`, name: series.name, status: "Not tested", channels: [{
      id: `channel-${index}`, symbolicName: series.name, stationId: "station-1", slot: index + 1,
      channel: 0, role: series.kind === "digital" ? "Command" : "Input",
      status: "Not tested", parameters: [], series: [{ id: `series-${index}`, unit: "", ...series }],
    }] }));
    run.unassignedChannels = [];
    const result = await pdfContent(await createTestReportPdf({ state }));
    const isBlue = line => line.color.length === 3 && line.color.every((value, index) => Math.abs(value - [24, 108, 161][index] / 255) < 0.005);
    const graphLines = name => {
      const page = result.pages.findIndex(text => text.includes(name) && /Figure \d+\./.test(text));
      assert.ok(page >= 0, `Missing graph for ${name}`);
      return pdfLines(result.streams[page]).filter(isBlue);
    };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} differs from ${expected}`);
    const same = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
    // These single-signal devices keep their own fitted device time ranges.
    const left = 100.2, right = 723.8, width = right - left;
    const analog = graphLines("Analog ramp");
    assert.equal(analog.length, 2);
    assert.deepEqual(analog[0].dash, []);
    assert.deepEqual(analog[1].dash, [4, 3]);
    near(analog[0].from.x, left); near(analog[0].to.x, left + width / 1.04);
    assert.notEqual(analog[0].from.y, analog[0].to.y, "analog points are connected directly");
    same(analog[1].from, analog[0].to);
    near(analog[1].from.y, analog[1].to.y); near(analog[1].to.x, right);

    const digital = graphLines("Digital steps");
    assert.equal(digital.length, 5);
    assert.deepEqual(digital.map(line => line.dash), [[], [], [], [4, 3], [4, 3]]);
    const [firstStep, hold, lastStep, initial, tail] = digital;
    near(initial.from.x, left); near(initial.from.y, initial.to.y);
    same(initial.to, firstStep.from); same(firstStep.to, hold.from);
    near(hold.from.x, left + width / 27); near(hold.to.x, left + width * 26 / 27);
    near(hold.from.y, hold.to.y);
    same(lastStep.from, hold.to); near(lastStep.from.x, lastStep.to.x);
    assert.notEqual(lastStep.from.y, lastStep.to.y, "digital state changes vertically");
    same(tail.from, lastStep.to); near(tail.from.y, tail.to.y); near(tail.to.x, right);
    near(initial.from.y, tail.to.y);
    assert.match(result.pages.find(page => page.includes("Digital steps") && /Figure \d+\./.test(page)), /Initial state 0/);

    const gap = graphLines("Invalid gap");
    assert.equal(gap.length, 2, "there is no connection across the invalid event");
    near(gap[0].to.x, left + width / (3 * 1.04));
    near(gap[1].from.x, left + width / 1.04);
    assert.deepEqual(gap[1].dash, [4, 3]); near(gap[1].to.x, right);
    const trailing = graphLines("Invalid final reading");
    assert.equal(trailing.length, 1, "an invalid final event prevents holding an earlier value");
    assert.deepEqual(trailing[0].dash, []);
    const red = result.streams.flatMap(pdfLines).filter(line => line.color.length === 3
      && line.color.every((value, index) => Math.abs(value - [170, 49, 43][index] / 255) < 0.005));
    assert.ok(red.length > 0);
    assert.ok(red.every(line => line.dash.length === 0), "held-tail dash style must not leak into invalid-value markers");
  });
});

test("PDF feedback traces start at 0.0 V, keep measured steps, and do not reset later manual views", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const points = values => values.map((value, index) => ({
      timeMs: startMs + 50_000 + index * 50_000, time: `Recorded event ${index + 1}`,
      value, valid: true, rawValue: String(value), previousValue: index ? values[index - 1] : 0,
      previousRawValue: String(index ? values[index - 1] : 0), sourceId: "source-log", sourceRow: index + 2,
    }));
    const channel = (id, name, unit, values) => ({
      id, symbolicName: name, stationId: "station-1", slot: id === "feedback" ? 2 : 3, channel: 0,
      role: id === "feedback" ? "Feedback" : "Positioner", status: "Passed", parameters: [],
      series: [{ id: `${id}-series`, name, kind: "analog", unit, points: points(values) }],
    });
    run.devices = [{ id: "feedback-example", name: "Valve example", status: "Passed", channels: [
      channel("feedback", "V-3501_FB", "V", [0.3, 0.1, 0.15]),
      channel("position", "V-3501-POS", "mA", [4, 20, 12]),
    ] }];
    run.unassignedChannels = [];
    const before = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    const feedback = readPlot(result, "V-3501_FB");
    const solid = feedback.traces.filter(line => line.dash.length === 0);
    const tails = feedback.traces.filter(line => line.dash.length > 0);
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} differs from ${expected}`);
    const same = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
    assert.equal(solid.length, 5, "the first measured voltage follows the initial zero transition and two recorded steps");
    assert.equal(tails.length, 2, "the initial zero and final held value are separate dashed segments");
    const [initial, tail] = tails;
    const [firstJump, ...steps] = solid;
    assert.deepEqual(initial.dash, [4, 3]);
    near(initial.from.x, feedback.left);
    near(initial.from.y, initial.to.y);
    same(initial.to, firstJump.from);
    near(firstJump.from.x, firstJump.to.x);
    same(firstJump.to, steps[0].from);
    const firstVoltageY = firstJump.to.y;
    const secondVoltageY = steps[1].to.y;
    near(initial.from.y, firstVoltageY + (secondVoltageY - firstVoltageY) * (0 - 0.3) / (0.1 - 0.3));
    assert.match(result.pages[feedback.page], /Initial value 0\.0 V/);
    for (let index = 0; index < steps.length; index += 2) {
      const [hold, jump] = steps.slice(index, index + 2);
      assert.ok(hold.to.x > hold.from.x);
      near(hold.from.y, hold.to.y);
      same(hold.to, jump.from);
      near(jump.from.x, jump.to.x);
      assert.notEqual(jump.from.y, jump.to.y);
      if (index + 2 < steps.length) same(jump.to, steps[index + 2].from);
    }
    assert.deepEqual(tail.dash, [4, 3]);
    same(tail.from, solid.at(-1).to);
    near(tail.from.y, tail.to.y);
    near(tail.to.x, feedback.right);
    assert.ok(result.blocks[feedback.page].some(block => block.text === "V"), "the PDF keeps the original voltage unit");
    const position = readPlot(result, "V-3501-POS");
    const diagonals = position.traces.filter(line => line.dash.length === 0);
    assert.equal(diagonals.length, 2);
    assert.ok(diagonals.every(line => line.from.x !== line.to.x && line.from.y !== line.to.y));
    const later = await pdfContent(await createTestReportPdf({ state,
      timeRanges: { [run.id]: { "feedback-example": { startMs: startMs + 75_000, endMs: startMs + 125_000 } } },
    }));
    const laterFeedback = readPlot(later, "V-3501_FB");
    assert.equal(laterFeedback.traces.length, 3);
    assert.ok(laterFeedback.traces.every(line => line.dash.length === 0), "a later manual view does not add a new zero baseline");
    assert.doesNotMatch(later.text, /Initial value 0\.0 V/);
    assert.deepEqual(state, before, "export cannot rewrite approved kinds, voltages, or timestamps");
  });
});

test("PDF separates mixed-unit and same-unit signals within a device while printing its comment once", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const point = (offset, value, extra = {}) => ({
      timeMs: startMs + offset, time: "Original source timestamp", value, valid: value !== null,
      rawValue: String(value), previousValue: 0, previousRawValue: "0", sourceId: "source-log", sourceRow: 21, ...extra,
    });
    const channel = (id, series) => ({
      id, symbolicName: "Valve device", stationId: "station-1", slot: id === 2 ? 1 : 3, sourceChannel: `Channel ${id}`,
      status: "Not tested", parameters: [], series,
    });
    run.comment = "Overall run engineering note";
    run.devices = [{ id: "valve", name: "Valve device", status: "Not tested", comment: "Engineering note covering every valve graph", channels: [
      channel(1, [{ id: "position", name: "VLV-900-POS", kind: "analog", unit: "mA", points: [point(0, 0), point(100_000, 25)] },
        { id: "pressure", name: "PD-900", kind: "analog", unit: "mA", points: [point(50_000, 0), point(150_000, 25)] },
        { id: "empty", name: "Empty signal", kind: "analog", unit: "mA", points: [] }]),
      channel(2, [{ id: "state", name: "Valve output", kind: "digital", unit: "", points: [point(25_000, 1), point(125_000, 0)] }]),
      channel(3, [{ id: "temperature", name: "Temperature evidence", kind: "analog", unit: "°C", points: [
        point(100_000, 20), point(200_000, 30), point(210_000, null, { rawValue: "BAD-TEMP", sourceRow: 47 }), point(220_000, 24),
      ] }]),
    ] }];
    run.unassignedChannels = [];
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.deepEqual(state, saved, "separate plots must not rewrite approved observations or comments");
    assert.equal(result.text.match(/Figure \d+\./g)?.length, 4, "every populated series has its own graph");
    assert.doesNotMatch(result.text, /Recorded values - shared time axis|\nLegend\n|Empty signal/);
    assert.equal(result.text.match(/\nDevice comment\n/g)?.length, 1);
    assert.equal(result.text.match(/Engineering note covering every valve graph/g)?.length, 1);
    assert.equal(result.text.match(/Overall test run comment/g)?.length, 1);
    assert.equal(result.text.match(/Overall run engineering note/g)?.length, 1);
    assert.match(result.text, /BAD-TEMP/);
    assert.match(result.text, /synthetic-log.csv, row 47/);
    assert.match(result.text, /Original source timestamp/);
    const titles = ["VLV-900-POS", "PD-900", "Valve output", "Temperature evidence"];
    const plots = titles.map(title => readPlot(result, title));
    const graphPages = plots.map(plot => plot.page);
    assert.equal(new Set(graphPages).size, 1, "a typical device keeps its separate graphs on one page");
    const devicePage = result.pages[graphPages[0]];
    assert.match(devicePage, /Valve device/);
    assert.equal(devicePage.match(/^mA$/gm)?.length, 2, "current axes carry unit-only labels");
    const summary = result.pages.find(page => page.includes("Channels\nTest Result"));
    assert.match(summary, /Device name\nSlot\nChannels\nTest Result\nValve device\n1, 3\n3\nNot tested/);
    assert.doesNotMatch(result.text, /Logged changes|Each signal has a separate graph|Original tokens are retained below|Parameter tables show/);
    assert.match(devicePage, /Engineering note covering every valve graph/);
    for (const plot of plots) assert.deepEqual(plot.timeTicks, ["19:17:00", "19:18:14", "19:19:29", "19:20:44"],
      "every signal uses the same automatic device time interval");
    assert.ok(devicePage.indexOf("Device comment") > devicePage.indexOf("Figure 4."));
    const traces = plots.map(plot => plot.traces);
    assert.deepEqual(traces.map(lines => lines.length), [2, 2, 3, 2], "individual plots preserve connections, digital steps, held tails, and invalid gaps");
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} differs from ${b}`);
    // Each plot independently covers its full mA, Celsius, or digital frame.
    for (const index of [0, 1, 3]) near(Math.abs(traces[index][0].from.y - traces[index][0].to.y), plots[index].height);
    near(Math.abs(traces[2][1].from.y - traces[2][1].to.y), plots[2].height);
    near(traces[0][0].from.x, plots[0].left);
    near(traces[0][0].to.x, plots[0].left + plots[0].width * 100_000 / 224_800);
    near(traces[1][0].from.x, plots[1].left + plots[1].width * 50_000 / 224_800);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
  });
});

test("automatic PDF device axes align disjoint channels across rows and pages without including filtered evidence", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: value !== null,
      previousValue: 0, rawValue: String(value), sourceId: "source-log", sourceRow: 8, ...extra });
    const channel = (name, unit, kind, offsets, values, index, extra = {}) => ({
      id: `shared-channel-${index}`, symbolicName: name, stationId: "station-1", slot: index + 1,
      channel: 0, sourceChannel: "Channel 1", role: kind === "digital" ? "Command" : "Analog input",
      status: "Passed", parameters: [], series: [{ id: `shared-series-${index}`, name, kind, unit,
        points: offsets.map((offset, index) => point(offset, values[index])) }], ...extra,
    });
    const channels = [
      channel("Shared command", "", "digital", [20_000, 120_000], [0, 1], 0),
      channel("Shared_FB", "V", "analog", [40_000, 140_000], [0.3, 0.1], 1),
      channel("Shared-POS", "mA", "analog", [80_000, 180_000], [4, 20], 2),
      channel("Late command", "", "digital", [200_000, 250_000], [0, 1], 3),
      channel("Coincident voltage", "V", "analog", [120_000, 220_000], [2, 3], 4),
      channel("Shared temperature", "°C", "analog", [60_000, 160_000], [21, 25], 5),
      channel("Earliest current", "mA", "analog", [10_000, 30_000], [4, 5], 6),
      channel("Latest voltage", "V", "analog", [260_000, 280_000], [0.2, 0.1], 7),
    ];
    channels[6].series[0].points.unshift(point(0, 4, { excluded: true }));
    channels[6].series[0].points.push(point(392_000, 4, { excluded: true }));
    channels.push(channel("Filtered signal", "V", "analog", [0, 392_000], [1, 2], 8, { status: "Not applicable" }));
    run.devices = [{ id: "shared-device", name: "Shared valve", status: "Passed", channels },
      { id: "other-device", name: "Separate device", status: "Passed", channels: [
        channel("Other early", "V", "analog", [0, 2000], [1, 2], 9),
        channel("Other late", "V", "analog", [500, 2500], [2, 3], 10),
      ] }];
    run.unassignedChannels = [];
    const before = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    const titles = channels.slice(0, 8).map(channel => channel.series[0].name);
    const plots = titles.map(title => readPlot(result, title));
    assert.ok(new Set(plots.map(plot => plot.page)).size > 1, "the fixture exercises repeated chart rows across a page break");
    for (const plot of plots) assert.deepEqual(plot.timeTicks, ["19:17:09", "19:19:25", "19:21:41"],
      "each exported signal carries the same earliest-to-latest device axis on every page");
    assert.doesNotMatch(result.text, /Filtered signal/);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} differs from ${b}`);
    const normalizedX = (plot, x) => (x - plot.left) / plot.width;
    const commandJump = plots[0].traces.find(line => line.dash.length === 0 && line.from.x === line.to.x);
    const coincidentLine = plots[4].traces.find(line => line.dash.length === 0);
    assert.ok(commandJump && coincidentLine);
    near(normalizedX(plots[0], commandJump.from.x), 111_000 / 272_000);
    near(normalizedX(plots[0], commandJump.from.x), normalizedX(plots[4], coincidentLine.from.x),
      "the same recorded timestamp has the same relative horizontal position in different rows");
    const feedback = plots[1];
    const [initial, tail] = feedback.traces.filter(line => line.dash.length > 0);
    assert.ok(initial && tail);
    near(initial.from.x, feedback.left);
    near(normalizedX(feedback, initial.to.x), 31_000 / 272_000);
    near(normalizedX(feedback, tail.from.x), 131_000 / 272_000);
    near(tail.to.x, feedback.right);
    assert.match(result.pages[feedback.page], /Initial value 0\.0 V/);
    const otherPlots = ["Other early", "Other late"].map(title => readPlot(result, title));
    for (const plot of otherPlots) assert.deepEqual(plot.timeTicks, ["19:17:00", "19:17:01", "19:17:02", "19:17:03"],
      "a second device uses its own shared range");
    assert.deepEqual(state, before, "shared display axes leave approved timestamps, excluded events, and measurements intact");
  });
});

test("unassigned channels retain separate signal graphs and invalid-source details", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const channel = run.devices[0].channels[0];
    channel.symbolicName = "Unassigned recorded input";
    channel.series.push({ id: "unassigned-output", name: "Unassigned output", kind: "digital", unit: "", points: [
      { timeMs: startMs, value: 0, valid: true }, { timeMs: startMs + 196_000, value: 1, valid: true },
    ] });
    run.devices = [];
    run.unassignedChannels = [channel];
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.equal(result.text.match(/Figure \d+\./g)?.length, 2);
    assert.match(result.text, /Unassigned channels/);
    assert.match(result.text, /Unassigned output/);
    assert.match(result.text, /Temperature/);
    assert.match(result.text, /7FFFH/);
    assert.match(result.text, /synthetic-log.csv, row 3/);
    const graphPage = result.pages.findIndex(page => page.includes("Figure 1."));
    assert.match(result.pages[graphPage], /Unassigned channels/);
    assert.deepEqual(state, saved);
  });
});

test("PDF validates optional engineer comments before loading fonts or setup photos", async () => {
  const original = globalThis.fetch;
  let fetched = false, accessed = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("No assets expected"); };
  const backend = { getPhotoUrl: async () => { accessed = true; return "/private/setup.png"; } };
  try {
    for (const value of [null, 0, false, [], {}, "x".repeat(4001), "🧪".repeat(4001), "Comment\0with NUL"]) {
      const runState = closedState();
      runState.testRuns[0].setupPhotos = [setupPhoto("review")];
      runState.testRuns[0].comment = value;
      await assert.rejects(createTestReportPdf({ state: runState, backend }), /overall test run comment.*at most 4,000 characters/);
      const deviceState = closedState();
      deviceState.testRuns[0].setupPhotos = [setupPhoto("review")];
      deviceState.testRuns[0].devices[0].comment = value;
      await assert.rejects(createTestReportPdf({ state: deviceState, backend }), /device comment.*at most 4,000 characters/);
    }
    assert.equal(fetched, false);
    assert.equal(accessed, false);
  } finally { globalThis.fetch = original; }
});

test("run and device comments preserve multiline Unicode separately from imported tester comments", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    run.comment = "Kiểm tra tổng thể hoàn tất.\nΔοκιμή συνολική";
    run.devices[0].comment = "Nhiệt độ ổn định tại 25°C.\nПроверено устройство\n\n- Wire-break — Passed\n- Supply voltage — Passed";
    run.devices[1].comment = "  \n \t";
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    const overallPage = result.pages.find(page => page.includes("Overall test run comment"));
    assert.ok(overallPage);
    assert.equal(overallPage.split("\n")[2], run.name);
    assert.match(overallPage, /Kiểm tra tổng thể hoàn tất\.\nΔοκιμή συνολική/);
    const devicePage = result.pages.find(page => page.includes("Device comment"));
    assert.ok(devicePage);
    assert.match(devicePage, /RTD-EXAMPLE/);
    assert.match(devicePage, /Nhiệt độ ổn định tại 25degC\.\nПроверено устройство/);
    assert.equal(result.text.match(/Device comment/g)?.length, 1, "whitespace-only comments stay omitted");
    assert.match(result.text, /Tester comment: Investigate the wiring before retest\./);
    const blocks = result.blocks.flat();
    for (const text of ["Overall test run comment", "Kiểm tra tổng thể hoàn tất.", "Δοκιμή συνολική",
      "Device comment", "Nhiệt độ ổn định tại 25degC.", "Проверено устройство"]) {
      const color = blocks.find(block => block.text === text)?.color;
      assert.ok(color?.every((value, index) => Math.abs(value - [24, 108, 161][index] / 255) < 0.005),
        `Expected blue text for ${text}`);
    }
    const deviceBlocks = result.blocks[result.pages.indexOf(devicePage)];
    for (const text of ["Wire-break", "Supply voltage"]) {
      const row = deviceBlocks.find(block => block.text === text);
      assert.ok(row, `Missing diagnostic ${text}`);
      assert.ok(deviceBlocks.some(block => block.text === "•" && block.y === row.y && block.x < row.x));
      const passed = deviceBlocks.find(block => block.text === "Passed" && block.y === row.y && block.x > row.x);
      assert.ok(passed?.color?.every((value, index) => Math.abs(value - [31, 105, 57][index] / 255) < 0.005),
        `Expected green Passed status for ${text}`);
    }
    assert.deepEqual(state, saved);
  });
});

test("long run and device comments paginate completely above the footer through the 4,000-character limit", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const runLines = Array.from({ length: 70 }, (_, index) => `Run-comment-line-${String(index + 1).padStart(2, "0")}: Kiểm tra`);
    const deviceLines = Array.from({ length: 70 }, (_, index) => `Device-comment-line-${String(index + 1).padStart(2, "0")}: Проверено`);
    const tail = "\nRun-comment-final-boundary";
    run.comment = ("🧪" + runLines.join("\n")).padEnd(4001 - tail.length, "x") + tail;
    run.devices[0].comment = deviceLines.join("\n");
    assert.equal(Array.from(run.comment).length, 4000);
    assert.equal(run.comment.length, 4001, "the limit counts Unicode code points, not UTF-16 code units");
    assert.ok(run.devices[0].comment.length < 4000);
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    for (const line of [...runLines, ...deviceLines]) assert.ok(result.text.includes(line), `Missing comment text: ${line}`);
    assert.match(result.text, /Run-comment-final-boundary/);
    assert.match(result.text, /\[U\+1F9EA\]/, "unsupported glyphs retain the established printable-text representation");
    assert.ok(result.pages.filter(page => /Run-comment-line-/.test(page)).length > 1);
    assert.ok(result.pages.filter(page => /Device-comment-line-/.test(page)).length > 1);
    assert.ok(result.pages.some(page => page.includes(`${run.name} (continued)`) && /Run-comment-line-/.test(page)));
    assert.ok(result.pages.some(page => page.includes("RTD-EXAMPLE (continued)") && /Device-comment-line-/.test(page)));
    assert.match(result.text, /Tester comment: Investigate the wiring before retest\./);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
    assert.deepEqual(state, saved);
  });
});

test("PDF graph ordering moves individual mixed-unit graphs across rows and pages with their legends and audits", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const device = graphOrderDevice("Ordered");
    run.devices = [device];
    run.unassignedChannels = [];
    const entries = deviceGraphEntries(device);
    const selected = [7, 6, 0, 1, 4, 5, 2];
    const graphOrders = { [run.id]: { [device.id]: ["removed-graph", entries[7].key, ...selected.map(index => entries[index].key)] } };
    const before = structuredClone({ state, graphOrders });
    const result = await pdfContent(await createTestReportPdf({ state, graphOrders }));
    const expected = [...selected, 3].map(index => entries[index]);
    const titles = entries.map(({ series }) => series.name);
    const plotted = result.blocks.flat().filter(block => titles.includes(block.text)).map(block => block.text);
    assert.deepEqual(plotted, expected.map(({ series }) => series.name),
      "unknown keys and duplicates cannot hide graphs; an unlisted new graph is appended");
    assert.equal(result.text.match(/Figure \d+\./g)?.length, entries.length);
    const plots = expected.map(({ series }) => readPlot(result, series.name));
    assert.ok(new Set(plots.map(plot => plot.page)).size > 1, "ordering is global across page breaks");
    for (const plot of plots) assert.deepEqual(plot.timeTicks, plots[0].timeTicks, "graph order does not change the shared device axis");
    const text = result.text.replace(/\s+/g, " ");
    expected.forEach(({ series, channel }, index) => {
      const label = `Figure ${index + 1}.`;
      const next = text.indexOf(`Figure ${index + 2}.`);
      const legend = text.slice(text.indexOf(label), next < 0 ? undefined : next);
      const measurement = series.kind === "digital" ? "Recorded state" : series.unit === "V" ? "Measured voltage"
        : series.unit === "°C" ? "Measured temperature" : "Measured current";
      assert.ok(legend.startsWith(`${label} ${measurement} for the input. Station Example | Slot ${channel.slot} | ${channel.sourceChannel}`),
        `Figure ${index + 1} keeps ${series.name}'s measurement and location`);
    });
    const audits = [...result.text.matchAll(/Invalid or unplottable values - ([^\n]+)/g)].map(match => match[1]);
    assert.deepEqual(audits, [entries[6].series.name, entries[1].series.name], "source audit details follow their graph order");
    const feedback = readPlot(result, entries[1].series.name);
    assert.match(result.pages[feedback.page], /Initial value 0\.0 V/);
    assert.equal(feedback.traces.filter(line => line.dash.length > 0).length, 2, "reordering preserves the feedback zero baseline and held tail");
    assert.deepEqual({ state, graphOrders }, before, "view ordering cannot mutate approved observations or caller preferences");
  });
});

test("PDF graph orders stay scoped to each run and device and retain legacy keys through N/A filtering", async () => {
  await withFonts(async () => {
    const state = closedState();
    const [run] = state.testRuns;
    const first = graphOrderDevice("First", 4), second = graphOrderDevice("Second", 2);
    for (const channel of first.channels) {
      delete channel.id;
      for (const series of channel.series) delete series.id;
    }
    first.channels.unshift({ ...structuredClone(first.channels[0]), status: "Not applicable" });
    run.devices = [first, second];
    run.unassignedChannels = [];
    const another = runFixture("other-run");
    another.devices = [graphOrderDevice("Other run", 3)];
    another.unassignedChannels = [];
    state.testRuns.push(another);
    const firstEntries = deviceGraphEntries(first).filter(({ channel }) => channel.status !== "Not applicable");
    const secondEntries = deviceGraphEntries(second);
    const anotherEntries = deviceGraphEntries(another.devices[0]);
    const graphOrders = {
      [run.id]: { [first.id]: firstEntries.map(entry => entry.key).reverse(), "absent-device": "ignored" },
      [another.id]: { [another.devices[0].id]: [anotherEntries[2].key] },
      "absent-run": null,
    };
    const result = await pdfContent(await createTestReportPdf({ state, graphOrders }));
    const allTitles = [...firstEntries, ...secondEntries, ...anotherEntries].map(({ series }) => series.name);
    const plotted = result.blocks.flat().filter(block => allTitles.includes(block.text)).map(block => block.text);
    assert.deepEqual(plotted, [...firstEntries].reverse().concat(secondEntries, anotherEntries[2], anotherEntries.slice(0, 2)).map(({ series }) => series.name));
    assert.equal(result.text.match(/Figure \d+\./g)?.length, 9, "N/A duplicate channels stay omitted without shifting retained legacy graph keys");
    const selected = await pdfContent(await createTestReportPdf({ state, runId: run.id,
      graphOrders: { ...graphOrders, [another.id]: "ignored for an unselected run" } }));
    assert.doesNotMatch(selected.text, /Other run (?:command|feedback_FB|current)/);
    assert.equal(selected.text.match(/Figure \d+\./g)?.length, 6);
  });
});

test("PDF graph order is captured before asynchronous asset loading", async () => {
  const original = globalThis.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => { await gate; return assetResponse(String(url).split("/").pop()); };
  try {
    const state = closedState();
    const run = state.testRuns[0], device = graphOrderDevice("Captured", 3);
    run.devices = [device]; run.unassignedChannels = [];
    const entries = deviceGraphEntries(device);
    const graphOrders = { [run.id]: { [device.id]: entries.map(entry => entry.key).reverse() } };
    const pending = createTestReportPdf({ state, graphOrders });
    graphOrders[run.id][device.id].reverse();
    release();
    const result = await pdfContent(await pending);
    const titles = entries.map(({ series }) => series.name);
    assert.deepEqual(result.blocks.flat().filter(block => titles.includes(block.text)).map(block => block.text), [...titles].reverse());
    assert.equal(run.graphOrders, undefined, "view order is never inserted into approved run evidence");
  } finally { release(); globalThis.fetch = original; }
});

test("invalid selected PDF graph orders fail before fonts or private photos load", async () => {
  const original = globalThis.fetch;
  let fetched = false, accessed = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("No assets expected"); };
  const backend = { getPhotoUrl: async () => { accessed = true; return "/private/setup.png"; } };
  try {
    const state = closedState();
    state.testRuns[0].setupPhotos = [setupPhoto("order")];
    for (const order of [null, undefined, "order", {}, [null], [1], [""], ["bad\0key"], new Array(1)])
      await assert.rejects(createTestReportPdf({ state, backend, graphOrders: { "run-1": { "device-1": order } } }), /graph order.*invalid/);
    for (const graphOrders of [null, [], "orders", new Map(), { "run-1": null }, { "run-1": [] }, { "run-1": "orders" }])
      await assert.rejects(createTestReportPdf({ state, backend, graphOrders }), /Graph orders must be grouped by test run and device/);
    assert.equal(fetched, false);
    assert.equal(accessed, false);
  } finally { globalThis.fetch = original; }
});

test("manual device ranges apply to every separate channel graph and preserve hidden source evidence", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const device = run.devices[0];
    const point = (offset, value) => ({ timeMs: startMs + offset, value, valid: true, sourceId: "source-log", sourceRow: 22 });
    device.channels.push({ ...structuredClone(run.devices[1].channels[0]), id: "manual-channel", symbolicName: "Manual command", series: [
      { id: "manual-digital", name: "Manual command", kind: "digital", unit: "", points: [point(50_000, 0), point(150_000, 1), point(250_000, 0)] },
      { id: "manual-current", name: "V-900-POS", kind: "analog", unit: "mA", points: [point(0, 0), point(100_000, 10), point(200_000, 20), point(300_000, 25)] },
    ] });
    run.comment = "Overall review stays saved";
    device.comment = "Device review stays saved";
    const timeRanges = { [run.id]: { [device.id]: { startMs: startMs + 100_000, endMs: startMs + 200_000 } } };
    const graphOrders = { [run.id]: { [device.id]: deviceGraphEntries(device).map(entry => entry.key).reverse() } };
    const originalState = structuredClone(state), originalRanges = structuredClone(timeRanges);
    const result = await pdfContent(await createTestReportPdf({ state, timeRanges, graphOrders }));
    const titles = ["Temperature", "Manual command", "V-900-POS"];
    assert.deepEqual(result.blocks.flat().filter(block => titles.includes(block.text)).map(block => block.text), [...titles].reverse(),
      "manual horizontal windows remain independent of the selected graph order");
    const pages = titles.map(title => {
      const page = result.pages.findIndex(text => text.includes(`\n${title}\n`));
      assert.ok(page >= 0, `Missing graph ${title}`);
      return page;
    });
    for (const page of pages) {
      assert.match(result.pages[page], /19:18:40/);
      assert.match(result.pages[page], /19:20:20/);
    }
    assert.match(result.text, /7FFFH/);
    assert.match(result.text, /synthetic-log.csv, row 3/);
    const otherPage = result.pages.find(page => page.includes("\nOutput state\n"));
    assert.ok(otherPage);
    assert.match(otherPage, /19:21:56/);
    const isColor = (line, rgb) => line.color.length === 3 && line.color.every((value, index) => Math.abs(value - rgb[index] / 255) < 0.005);
    const plots = titles.map(title => readPlot(result, title));
    const traces = plots.map(plot => plot.traces);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} differs from ${b}`);
    assert.equal(traces[0].length, 1, "the last recorded temperature holds through this later view");
    assert.deepEqual(traces[0][0].dash, [4, 3]);
    near(traces[0][0].from.x, plots[0].left); near(traces[0][0].to.x, plots[0].right);
    assert.equal(traces[1].length, 3, "digital steps are clipped at both manual view edges");
    assert.equal(traces[2].length, 1);
    near(traces[2][0].from.x, plots[2].left); near(traces[2][0].to.x, plots[2].right);
    near(Math.abs(traces[2][0].from.y - traces[2][0].to.y), plots[2].height * 10 / 25, "the full source mA scale stays unchanged");
    assert.equal(result.streams.flatMap(pdfLines).filter(line => isColor(line, [170, 49, 43])).length, 0, "invalid markers outside the view are not plotted");
    assert.equal(result.text.match(/Device review stays saved/g)?.length, 1);
    assert.equal(result.text.match(/Overall review stays saved/g)?.length, 1);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
    assert.deepEqual(state, originalState);
    assert.deepEqual(timeRanges, originalRanges);
  });
});

test("manual PDF ranges remain scoped to their run and device and ignore unselected entries", async () => {
  await withFonts(async () => {
    const state = closedState();
    const archived = runFixture("archived"), newer = runFixture("newer");
    archived.devices[0].channels[0].series[0].name = "Archived temperature";
    newer.devices[0].channels[0].series[0].name = "Newer temperature";
    state.testRuns = [archived, newer];
    const selectedRanges = { archived: { "device-1": { startMs: startMs + 1000, endMs: startMs + 3000 }, "missing-device": "ignored" }, newer: null };
    const selected = await pdfContent(await createTestReportPdf({ state, runId: "archived", timeRanges: selectedRanges }));
    const archivedPage = selected.pages.find(page => page.includes("Archived temperature"));
    assert.match(archivedPage, /19:17:01/);
    assert.match(archivedPage, /19:17:03/);
    assert.doesNotMatch(selected.text, /Newer temperature/);
    const allRanges = { archived: selectedRanges.archived, "missing-run": { "device-1": "ignored" } };
    const all = await pdfContent(await createTestReportPdf({ state, timeRanges: allRanges }));
    const newerPage = all.pages.find(page => page.includes("Newer temperature"));
    assert.ok(newerPage);
    assert.match(newerPage, /19:17:04/);
  });
});

test("manual PDF range options are captured before asynchronous font loading", async () => {
  const original = globalThis.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => { await gate; return assetResponse(String(url).split("/").pop()); };
  try {
    const state = closedState();
    const timeRanges = { "run-1": { "device-1": { startMs: startMs + 1000, endMs: startMs + 3000 } } };
    const pending = createTestReportPdf({ state, timeRanges });
    timeRanges["run-1"]["device-1"].startMs = startMs + 100_000;
    timeRanges["run-1"]["device-1"].endMs = startMs + 200_000;
    release();
    const result = await pdfContent(await pending);
    const graphPage = result.pages.find(page => page.includes("\nTemperature\n"));
    assert.ok(graphPage);
    assert.match(graphPage, /19:17:01/);
    assert.match(graphPage, /19:17:03/);
    assert.doesNotMatch(graphPage, /19:18:40|19:20:20/);
    assert.equal(state.testRuns[0].timeRanges, undefined, "view options never become approved test-run data");
  } finally { release(); globalThis.fetch = original; }
});

test("invalid selected PDF time ranges fail before fonts or private photos load", async () => {
  const original = globalThis.fetch;
  let fetched = false, accessed = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("No assets expected"); };
  const backend = { getPhotoUrl: async () => { accessed = true; return "/private/setup.png"; } };
  try {
    const state = closedState();
    state.testRuns[0].setupPhotos = [setupPhoto("range")];
    const invalid = [null, undefined, [], "range", {},
      { startMs, endMs: startMs }, { startMs: startMs + 2000, endMs: startMs + 1000 },
      { startMs: startMs - 1, endMs: startMs + 1000 }, { startMs, endMs: CLOCK.endMs + 1 },
      { startMs: startMs + 0.5, endMs: startMs + 1000 }, { startMs, endMs: startMs + 1000.5 },
      { startMs: NaN, endMs: startMs + 1000 }, { startMs, endMs: Infinity },
      { startMs: String(startMs), endMs: startMs + 1000 }];
    for (const range of invalid)
      await assert.rejects(createTestReportPdf({ state, backend, timeRanges: { "run-1": { "device-1": range } } }), /manual graph time range.*invalid/);
    for (const timeRanges of [null, [], "ranges", { "run-1": null }, { "run-1": [] }, { "run-1": "ranges" }])
      await assert.rejects(createTestReportPdf({ state, backend, timeRanges }), /grouped by test run and device/);
    assert.equal(fetched, false);
    assert.equal(accessed, false);
  } finally { globalThis.fetch = original; }
});

test("approved PDF reconnects retained readings without printing removed events", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, time: `Source time ${offset}`,
      value, valid: value !== null, rawValue: value === null ? "REMOVED-INVALID" : `Original ${value}`,
      previousValue: 0, previousRawValue: "Previous original", sourceId: "source-log", sourceRow: offset / 1000 + 2, ...extra });
    const device = run.devices[0];
    run.devices = [device];
    run.unassignedChannels = [];
    device.comment = "One review for all retained graphs";
    const channel = device.channels[0];
    channel.parameters = [];
    channel.series = [
      { id: "analog-removal", name: "Analog removal", kind: "analog", unit: "mA", points: [
        point(0, 0, { excluded: false }), point(98_000, 25, { excluded: true }),
        point(196_000, 10), point(294_000, 20, { excluded: true }),
      ] },
      { id: "digital-removal", name: "Digital removal", kind: "digital", unit: "", points: [
        point(0, 0), point(98_000, 1, { excluded: true }), point(196_000, 0),
      ] },
      { id: "invalid-removal", name: "Invalid removal", kind: "analog", unit: "mA", points: [
        point(0, 4), point(98_000, null, { excluded: true }), point(196_000, 20),
      ] },
    ];
    const original = structuredClone(state);
    const timeRanges = { [run.id]: { [device.id]: { ...CLOCK } } };
    const result = await pdfContent(await createTestReportPdf({ state, timeRanges }));
    const graphs = ["Analog removal", "Digital removal", "Invalid removal"].map(title => readPlot(result, title));
    const plots = graphs.map(graph => graph.traces);
    assert.deepEqual(plots.map(lines => lines.length), [2, 2, 2]);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} differs from ${b}`);
    for (const { traces: lines, left, right, width } of graphs) {
      assert.deepEqual(lines.map(line => line.dash), [[], [4, 3]]);
      near(lines[0].from.x, left); near(lines[0].to.x, left + width / 2);
      near(lines[1].from.x, left + width / 2); near(lines[1].to.x, right);
      near(lines[1].from.y, lines[0].to.y); near(lines[1].from.y, lines[1].to.y);
    }
    assert.notEqual(plots[0][0].from.y, plots[0][0].to.y, "analog trace reconnects across the removed spike");
    assert.ok(plots[1].every(line => line.from.y === line.to.y), "removed digital change creates no remaining state transition");
    assert.notEqual(plots[2][0].from.y, plots[2][0].to.y, "a removed invalid row no longer breaks the retained trace");
    assert.doesNotMatch(result.text, /Removed events|Source time 294000|REMOVED-INVALID|Original 25|Invalid or unplottable values/);
    assert.equal(result.text.match(/One review for all retained graphs/g)?.length, 1);
    assert.deepEqual(state, original);
  });
});

test("PDF omits excluded events outside a manual view and retains active invalid readings", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const device = run.devices[0];
    run.devices = [device];
    run.unassignedChannels = [];
    const channel = device.channels[0];
    channel.parameters = [];
    const removed = Array.from({ length: 75 }, (_, index) => ({
      timeMs: startMs + index * 1000, time: `Audit-source-time-${String(index + 1).padStart(2, "0")}`,
      value: index, previousValue: index - 1, valid: index !== 22, excluded: true,
      rawValue: `After-token-${String(index + 1).padStart(2, "0")}`, previousRawValue: `Before-token-${String(index + 1).padStart(2, "0")}`,
      sourceId: "source-log", sourceRow: index + 8001,
    }));
    channel.series = [{ id: "audited", name: "Audited signal", kind: "analog", unit: "mA", points: [
      ...removed,
      { timeMs: startMs + 125_000, value: null, valid: false, rawValue: "ACTIVE-INVALID-TOKEN", previousRawValue: "Active before", sourceId: "source-log", sourceRow: 9000 },
      { timeMs: startMs + 150_000, value: 10 }, { timeMs: startMs + 200_000, value: 20 },
    ] }];
    const original = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state, timeRanges: {
      [run.id]: { [device.id]: { startMs: startMs + 100_000, endMs: startMs + 200_000 } },
    } }));
    assert.doesNotMatch(result.text, /Removed events|Audit-source-time-|Before-token-|After-token-|synthetic-log\.csv, row 80\d\d/);
    assert.match(result.text, /Invalid or unplottable values - Audited signal/);
    assert.equal(result.text.match(/ACTIVE-INVALID-TOKEN/g)?.length, 1);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved(?: date)?:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
    assert.deepEqual(state, original);
  });
});

test("malformed event removal flags are rejected before assets load", async () => {
  const original = globalThis.fetch;
  let fetched = false, accessed = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("No assets expected"); };
  const backend = { getPhotoUrl: async () => { accessed = true; return "/private/setup.png"; } };
  try {
    for (const excluded of [null, undefined, 0, 1, "true", [], {}]) {
      const state = closedState();
      state.testRuns[0].setupPhotos = [setupPhoto("removal")];
      state.testRuns[0].devices[0].channels[0].series[0].points[0].excluded = excluded;
      await assert.rejects(createTestReportPdf({ state, backend }), /excluded|exclusion|remov|boolean/i);
    }
    assert.equal(fetched, false);
    assert.equal(accessed, false);
  } finally { globalThis.fetch = original; }
});
