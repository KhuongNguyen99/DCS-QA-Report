import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createTestReportPdf } from "../src/test-report.js";

const fonts = {
  "NotoSans-Regular.ttf": await readFile(new URL("../public/assets/NotoSans-Regular.ttf", import.meta.url)),
  "NotoSans-Bold.ttf": await readFile(new URL("../public/assets/NotoSans-Bold.ttf", import.meta.url)),
};
const startMs = Date.UTC(2026, 10, 19, 19, 17);
const CLOCK = { basis: "source-local", timeZone: "Source clock (unspecified)", startMs, endMs: startMs + 392_000 };

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
        parameters: [{ name: "Module diagnostic setting", value: "Enabled", rawValue: "1", group: "Module", recordIndex: 128 }] }] }],
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
    return { text, x: xy ? Number(xy[1]) : null, y: xy ? 612 - Number(xy[2]) : null };
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

async function withFonts(callback) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const name = String(url).split("/").pop();
    requested.push(name);
    assert.ok(fonts[name], `Only report fonts should be fetched, got ${url}`);
    return new Response(fonts[name]);
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

test("approved test PDF preserves results, active settings, raw invalid tokens, provenance, and common graph clocks", async () => {
  await withFonts(async (requested) => {
    const result = await pdfContent(await createTestReportPdf({ state: closedState() }));
    assert.deepEqual(requested.sort(), ["NotoSans-Bold.ttf", "NotoSans-Regular.ttf"]);
    for (const text of ["I/O test report", "Skid Example", "Revision 2", "Inspector Example", "2026-11-20 11:30:00 UTC",
      "Siemens PRONETA Basic", "Version entered by tester", "RTD-EXAMPLE", "VALVE-EXAMPLE", "Recorded wiring result: Failed (source: Error)",
      "Recorded wiring result: Passed (source: OK)", "0 (encoded selection)", "Celsius", "7FFFH", "synthetic-log.csv, row 3",
      "Module diagnostic setting", "Unused-channel setting", "Not applicable", "Synthetic warning retained for review.", "Unrecognized synthetic event"])
      assert.ok(result.text.includes(text), `Missing report text: ${text}`);
    assert.ok(result.text.replace(/\s/g, "").includes("ab".repeat(32)));
    assert.doesNotMatch(result.raw, /\/Subtype\s*\/Image/, "Charts must remain vector shapes");
    assert.match(result.raw, /D:20261120113000\+00'00'/, "PDF metadata uses approval time, not export time");
    const graphPages = result.pages.filter((page) => page.includes("connect recorded changes"));
    assert.equal(graphPages.length, 2);
    for (const page of graphPages) {
      for (const tick of ["19:17:00", "19:18:38", "19:20:16", "19:21:54", "19:23:32"]) assert.ok(page.includes(tick), tick);
      assert.match(page, /dashed tail holds the last value to the run end/);
      assert.match(page, /Source clock \(unspecified\)/);
    }
    result.pages.forEach((page, index) => {
      assert.ok(page.includes(`Page ${index + 1} of ${result.pages.length}`));
      assert.ok(page.includes("Revision 2 | Skid: Skid Example"));
    });
  });
});

test("selected run exports the loaded archived revision and excludes other runs", async () => {
  await withFonts(async () => {
    const state = closedState();
    state.project.revision = 1;
    const archived = runFixture("archived");
    archived.name = "Archived run";
    archived.software.version = "Saved version 1";
    const newer = runFixture("newer");
    newer.name = "Unselected new run";
    newer.software.version = "Version that must not appear";
    state.testRuns = [archived, newer];
    const result = await pdfContent(await createTestReportPdf({ state, runId: "archived" }));
    assert.match(result.text, /Revision 1/);
    assert.match(result.text, /Saved version 1/);
    assert.doesNotMatch(result.text, /Unselected new run|Version that must not appear/);
    const all = await pdfContent(await createTestReportPdf({ state }));
    assert.match(all.text, /2 saved test run\(s\) included/);
    assert.match(all.text, /Unselected new run/);
    assert.match(all.text, /Version that must not appear/);
  });
});

test("export captures the approved payload before asynchronous font loading", async () => {
  const original = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    await gate;
    return new Response(fonts[String(url).split("/").pop()]);
  };
  try {
    const state = closedState();
    const pending = createTestReportPdf({ state });
    state.project.revision = 99;
    state.project.skidName = "Mutated skid";
    state.testRuns[0].devices[0].name = "Mutated device";
    state.testRuns[0].software.version = "Mutated software";
    release();
    const result = await pdfContent(await pending);
    assert.match(result.text, /Revision 2/);
    assert.match(result.text, /RTD-EXAMPLE/);
    assert.doesNotMatch(result.text, /Mutated|Revision 99/);
  } finally { globalThis.fetch = original; }
});

test("long selected parameters and notes paginate completely above the footer", async () => {
  await withFonts(async () => {
    const state = closedState();
    const parameters = Array.from({ length: 65 }, (_, index) => ({ name: `Parameter-${index + 1}`, value: `Selected-${index + 1}`, group: "Synthetic group" }));
    const longValue = Array.from({ length: 160 }, (_, index) => `Long-value-piece-${index + 1}`).join(" ");
    parameters.push({ name: "Oversized selected value", value: longValue });
    state.testRuns[0].devices[0].channels[0].parameters = parameters;
    state.testRuns[0].warnings.push(Array.from({ length: 70 }, (_, index) => `Import-note-line-${index + 1}`).join("\n"));
    const result = await pdfContent(await createTestReportPdf({ state }));
    for (let index = 1; index <= 65; index++) {
      assert.ok(result.text.includes(`Parameter-${index}`));
      assert.ok(result.text.includes(`Selected-${index}`));
    }
    for (let index = 1; index <= 160; index++) assert.ok(result.text.includes(`Long-value-piece-${index}`));
    for (let index = 1; index <= 70; index++) assert.ok(result.text.includes(`Import-note-line-${index}`));
    assert.ok(result.pages.some((page) => page.includes("(continued)")));
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
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
    run.devices[0].channels[0].rawStatus = "N.a.";
    run.devices[0].channels[0].series = [];
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.match(result.text, /No dated event log imported/);
    assert.match(result.text, /Recorded wiring result: Not tested \(source: N.a.\)/);
    assert.doesNotMatch(result.text, /connect recorded changes|Recorded wiring result: Passed/);
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
    assert.match(result.text, /UTC \(normalized from source timestamps/);
    assert.match(result.text, /original event timestamps retain their offsets/);
    assert.match(result.text, /2026-11-19T14:17:02-05:00/);
    assert.doesNotMatch(result.text, /Clock: Source clock \(timezone not recorded\)/);
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
      channel: 0, status: "Not tested", parameters: [], series: [{ id: `series-${index}`, unit: "", ...series }],
    }] }));
    run.unassignedChannels = [];
    const result = await pdfContent(await createTestReportPdf({ state }));
    const isBlue = line => line.color.length === 3 && line.color.every((value, index) => Math.abs(value - [24, 108, 161][index] / 255) < 0.005);
    const graphLines = name => {
      const page = result.pages.findIndex(text => text.includes(name) && text.includes("connect recorded changes"));
      assert.ok(page >= 0, `Missing graph for ${name}`);
      return pdfLines(result.streams[page]).filter(isBlue);
    };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} differs from ${expected}`);
    const same = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
    // Landscape report plot spans these fixed page positions; all cases keep
    // the same run clock while their observations cover different intervals.
    const left = 100.2, right = 723.8, width = right - left;
    const analog = graphLines("Analog ramp");
    assert.equal(analog.length, 2);
    assert.deepEqual(analog[0].dash, []);
    assert.deepEqual(analog[1].dash, [4, 3]);
    near(analog[0].from.x, left); near(analog[0].to.x, left + width / 2);
    assert.notEqual(analog[0].from.y, analog[0].to.y, "analog points are connected directly");
    same(analog[1].from, analog[0].to);
    near(analog[1].from.y, analog[1].to.y); near(analog[1].to.x, right);

    const digital = graphLines("Digital steps");
    assert.equal(digital.length, 3);
    assert.deepEqual(digital.map(line => line.dash), [[], [], [4, 3]]);
    near(digital[0].from.x, left + width / 4); near(digital[0].to.x, left + width / 2);
    near(digital[0].from.y, digital[0].to.y);
    same(digital[1].from, digital[0].to); near(digital[1].from.x, digital[1].to.x);
    assert.notEqual(digital[1].from.y, digital[1].to.y, "digital state changes vertically");
    same(digital[2].from, digital[1].to); near(digital[2].from.y, digital[2].to.y); near(digital[2].to.x, right);

    const gap = graphLines("Invalid gap");
    assert.equal(gap.length, 2, "there is no connection across the invalid event");
    near(gap[0].to.x, left + width / 4);
    near(gap[1].from.x, left + width * 3 / 4);
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
