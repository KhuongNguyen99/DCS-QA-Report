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
    const font = fonts[String(url).split("/").pop()];
    return font ? new Response(font) : photoResponse(String(url), options);
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

function pdfFilledRects(stream) {
  let color = [], rectangles = [];
  const result = [];
  for (const line of stream.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const operator = tokens.at(-1);
    if (operator === "rg" && tokens.length === 4) color = tokens.slice(0, 3).map(Number);
    else if (operator === "re" && tokens.length === 5)
      rectangles.push({ x: +tokens[0], y: 612 - Number(tokens[1]), width: +tokens[2], height: Math.abs(Number(tokens[3])) });
    else if (["f", "F", "f*"].includes(operator)) {
      result.push(...rectangles.map(rectangle => ({ ...rectangle, color: [...color] })));
      rectangles = [];
    } else if (["S", "n"].includes(operator)) rectangles = [];
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

test("approved test PDF preserves evidence and run context while fitting each graph's time axis", async () => {
  await withFonts(async (requested) => {
    const state = closedState();
    const legacyNote = "synthetic-log.csv, line 10: duplicate I/O event retained; no observations were removed.";
    state.testRuns[0].warnings.push(legacyNote);
    const savedState = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.deepEqual(state, savedState, "Clarifying a legacy import note must not change approved evidence");
    assert.deepEqual(requested.sort(), ["NotoSans-Bold.ttf", "NotoSans-Regular.ttf"]);
    for (const text of ["I/O test report", "Skid Example", "Revision 2", "Inspector Example", "2026-11-20 11:30:00 UTC",
      "Siemens PRONETA Basic", "Version entered by tester", "RTD-EXAMPLE", "VALVE-EXAMPLE", "Recorded wiring result: Failed (source: Error)",
      "Recorded wiring result: Passed (source: OK)", "0 (encoded selection)", "Celsius", "7FFFH", "synthetic-log.csv, row 3",
      "Module diagnostic setting", "Unused-channel setting", "Not applicable", "Synthetic warning retained for review.", "Unrecognized synthetic event"])
      assert.ok(result.text.includes(text), `Missing report text: ${text}`);
    const reportText = result.text.replace(/\s+/g, " ");
    assert.ok(reportText.includes(legacyNote), "The original archived warning stays in the report");
    assert.match(reportText, /This does not establish a duplicate physical event; multiple changes can share a timestamp\./);
    assert.match(reportText, /All observations were retained\./);
    assert.ok(reportText.indexOf("Earlier import notes use") < reportText.indexOf(legacyNote), "Clarification precedes the original notes");
    assert.ok(result.text.replace(/\s/g, "").includes("ab".repeat(32)));
    assert.doesNotMatch(result.raw, /\/Subtype\s*\/Image/, "Charts must remain vector shapes");
    assert.match(result.raw, /D:20261120113000\+00'00'/, "PDF metadata uses approval time, not export time");
    const graphPages = result.pages.filter((page) => page.includes("connect recorded changes"));
    assert.equal(graphPages.length, 2);
    for (const page of graphPages) {
      for (const time of ["19:17:00", "19:23:32"]) assert.ok(page.includes(time), "the full run context stays visible");
      assert.match(page, /Graph span:/);
      assert.match(page, /Shared run span:/);
      assert.match(page, /dashed tail holds the last value to the graph end/);
      assert.match(page, /Source clock \(unspecified\)/);
    }
    assert.ok(graphPages.some(page => page.includes("19:17:04")), "the short temperature series has a fitted axis");
    assert.ok(graphPages.some(page => page.includes("19:21:56")), "the late digital series starts near its observations");
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
      .filter(page => page.images.length);
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
    assert.equal(result.streams.flatMap(photoPlacements).length, 2);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
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
    // Fixed page positions contain a separate fitted time range for each graph.
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
    assert.equal(digital.length, 3);
    assert.deepEqual(digital.map(line => line.dash), [[], [], [4, 3]]);
    near(digital[0].from.x, left + width / 27); near(digital[0].to.x, left + width * 26 / 27);
    near(digital[0].from.y, digital[0].to.y);
    same(digital[1].from, digital[0].to); near(digital[1].from.x, digital[1].to.x);
    assert.notEqual(digital[1].from.y, digital[1].to.y, "digital state changes vertically");
    same(digital[2].from, digital[1].to); near(digital[2].from.y, digital[2].to.y); near(digital[2].to.x, right);

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

test("PDF combines all device channels with matching legends and independent unit scales", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const point = (offset, value, extra = {}) => ({
      timeMs: startMs + offset, time: "Original source timestamp", value, valid: value !== null,
      rawValue: String(value), previousValue: 0, previousRawValue: "0", sourceId: "source-log", sourceRow: 21, ...extra,
    });
    const channel = (id, series) => ({
      id, symbolicName: "Combined device", stationId: "station-1", slot: 3, sourceChannel: `Channel ${id}`,
      status: "Not tested", parameters: [], series,
    });
    run.devices = [{ id: "combined", name: "Combined device", status: "Not tested", channels: [
      channel(1, [{ id: "position", name: "VLV-900-POS", kind: "analog", unit: "mA", points: [point(0, 0), point(100_000, 25)] },
        { id: "pressure", name: "PD-900", kind: "analog", unit: "mA", points: [point(50_000, 0), point(150_000, 25)] }]),
      channel(2, [{ id: "state", name: "Valve output", kind: "digital", unit: "", points: [point(25_000, 1), point(125_000, 0)] }]),
      channel(3, [{ id: "temperature", name: "Temperature evidence", kind: "analog", unit: "°C", points: [
        point(100_000, 20), point(200_000, 30), point(210_000, null, { rawValue: "BAD-TEMP", sourceRow: 47 }), point(220_000, 24),
      ] }]),
    ] }];
    run.unassignedChannels = [];
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.deepEqual(state, saved, "combining plots must not rewrite approved observations");
    assert.equal(result.text.match(/Graph span:/g)?.length, 1, "one device has exactly one graph");
    assert.equal(result.text.match(/Recorded values - shared time axis/g)?.length, 1);
    assert.equal(result.text.match(/\nLegend\n/g)?.length, 1);
    assert.match(result.text.replace(/\s+/g, " "), /One graph per device shares a time axis/);
    assert.match(result.text, /BAD-TEMP/);
    assert.match(result.text, /synthetic-log.csv, row 47/);
    assert.match(result.text, /Original source timestamp/);
    const graphPage = result.pages.findIndex(page => page.includes("connect recorded changes"));
    const pageBlocks = result.blocks[graphPage];
    const axisLabels = pageBlocks.filter(block => ["mA", "degC", "State"].includes(block.text));
    assert.deepEqual(axisLabels.map(block => block.text).sort(), ["mA", "degC", "State"].sort(), "same-unit traces share one axis");
    assert.equal(new Set(axisLabels.map(block => block.x)).size, 3, "each unit has a separate vertical axis");
    const legendSwatches = result.streams.flatMap(pdfFilledRects).filter(rect => rect.height === 5 && rect.width === 19);
    assert.equal(legendSwatches.length, 4, "every trace has its own legend key");
    const colorKey = color => color.join(",");
    assert.equal(new Set(legendSwatches.map(rect => colorKey(rect.color))).size, 4);
    const allLines = pdfLines(result.streams[graphPage]);
    const traces = legendSwatches.map(rect => allLines.filter(line => colorKey(line.color) === colorKey(rect.color)));
    assert.deepEqual(traces.map(lines => lines.length), [2, 2, 3, 2], "all traces and held tails share the plot; invalid temperatures break their trace");
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} differs from ${b}`);
    // mA 0..25, degrees Celsius 20..30, and digital 0..1 each fill their own scale.
    near(traces[0][0].from.y, traces[1][0].from.y);
    near(traces[0][0].to.y, traces[1][0].to.y);
    near(traces[0][0].from.y, traces[3][0].from.y);
    near(traces[0][0].to.y, traces[3][0].to.y);
    near(traces[2][0].from.y, traces[0][0].to.y);
    near(traces[2][1].to.y, traces[0][0].from.y);
    near(traces[0][0].to.x, traces[3][0].from.x);
    near(traces[1][0].from.x, (traces[0][0].from.x + traces[0][0].to.x) / 2);
    for (const [index, name] of ["VLV-900-POS", "PD-900", "Valve output", "Temperature evidence"].entries()) {
      const text = result.blocks.flat().find(block => block.text.includes(name));
      assert.ok(text && Math.abs(text.y - legendSwatches[index].y - 5.2) < 0.01, `${name} is paired with its colored key`);
    }
  });
});

test("long combined legends retain every trace, identify reused colors by dashes, and paginate above the footer", async () => {
  await withFonts(async () => {
    const state = closedState();
    const run = state.testRuns[0];
    const device = run.devices[0];
    run.devices = [device];
    run.unassignedChannels = [];
    device.channels[0].parameters = [];
    device.channels[0].series = Array.from({ length: 36 }, (_, index) => ({
      id: `legend-${index}`, name: `Legend-trace-${String(index + 1).padStart(2, "0")} ${"Retained source description ".repeat(8)}`,
      kind: "analog", unit: "mA", points: [
        { timeMs: startMs, value: index, valid: true }, { timeMs: startMs + 196_000, value: index + 1, valid: true },
      ],
    }));
    const saved = structuredClone(state);
    const result = await pdfContent(await createTestReportPdf({ state }));
    assert.equal(result.text.match(/Graph span:/g)?.length, 1);
    for (let index = 1; index <= 36; index++)
      assert.equal(result.text.match(new RegExp(`Legend-trace-${String(index).padStart(2, "0")}`, "g"))?.length, 1);
    const legendPages = result.pages.filter(page => /Legend-trace-/.test(page));
    assert.ok(legendPages.length > 1, "legend continues onto extra pages");
    assert.ok(legendPages.some(page => page.includes("(continued)")));
    const swatches = result.streams.flatMap(pdfFilledRects).filter(rect => rect.height === 5 && rect.width <= 19);
    assert.ok(swatches.some(rect => rect.width < 19), "cycled trace dashes also appear in the legend keys");
    assert.ok(result.streams.flatMap(pdfLines).some(line => line.dash.length
      && line.from.y !== line.to.y), "the graph retains dash identity for cycled colors");
    for (const rect of swatches) assert.ok(rect.y + rect.height <= 548.1);
    for (const page of result.blocks) for (const block of page) {
      if (!block.text || block.y === null || /^(Approved:|Revision \d+ \| Skid:|Page \d+ of)/.test(block.text)) continue;
      assert.ok(block.y >= 15.9 && block.y <= 548.1, `Body text overlaps footer: ${JSON.stringify(block)}`);
    }
    assert.deepEqual(state, saved);
  });
});

test("unassigned channels retain their combined graphs and invalid-source details", async () => {
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
    assert.equal(result.text.match(/Graph span:/g)?.length, 1);
    assert.match(result.text, /Unassigned channels/);
    assert.match(result.text, /Unassigned output/);
    assert.match(result.text, /Temperature/);
    assert.match(result.text, /7FFFH/);
    assert.match(result.text, /synthetic-log.csv, row 3/);
    const graphPage = result.pages.findIndex(page => page.includes("connect recorded changes"));
    assert.match(result.pages[graphPage], /Unassigned channels/);
    assert.deepEqual(state, saved);
  });
});
