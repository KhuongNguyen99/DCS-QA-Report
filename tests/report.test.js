import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  createInspectionPdf,
  fitImageInBox,
  printableText,
  qualityFor,
} from "../src/report.js";

const schedule = JSON.parse(
  await readFile(new URL("../src/data/schedule.json", import.meta.url), "utf8"),
);
const layout = await readFile(
  new URL("../public/assets/conduit-layout.png", import.meta.url),
);
const logo = await readFile(
  new URL("../public/assets/jeevy-logo-black.png", import.meta.url),
);
const regularFont = await readFile(
  new URL("../public/assets/NotoSans-Regular.ttf", import.meta.url),
);
const boldFont = await readFile(
  new URL("../public/assets/NotoSans-Bold.ttf", import.meta.url),
);
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP88OMPAwMDEwMYAAAizgLoOA4+wgAAAABJRU5ErkJggg==",
  "base64",
);
const GENERATED_AT = new Date("2026-11-16T16:00:00Z");

async function pdfContent(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const raw = bytes.toString("latin1");
  const objects = new Map(
    [...raw.matchAll(/(?:^|\n)(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj/g)].map(
      ([, id, body]) => [id, body],
    ),
  );
  const streamFor = (body) => {
    const marker = body?.match(/stream\r?\n/);
    const length = Number(body?.match(/\/Length\s+(\d+)/)?.[1]);
    if (!marker || !Number.isSafeInteger(length)) return "";
    // Compressed bytes can end with CR; use /Length instead of consuming it as a line ending.
    const start = marker.index + marker[0].length;
    const stream = body.slice(start, start + length);
    try {
      return inflateSync(Buffer.from(stream, "latin1")).toString("latin1");
    } catch {
      return stream;
    }
  };
  // Decode jsPDF's embedded Noto subset to verify the actual page text.
  const fonts = new Map();
  const resources = [...objects.values()].find((body) => /\/Font\s*<</.test(body));
  for (const [, font, id] of resources.matchAll(/\/F(\d+)\s+(\d+) 0 R/g)) {
    const unicodeId = objects.get(id)?.match(/\/ToUnicode\s+(\d+) 0 R/)?.[1];
    if (!unicodeId) continue;
    const glyphs = new Map(
      [...streamFor(objects.get(unicodeId)).matchAll(/<([0-9a-fA-F]{4})><([0-9a-fA-F]{4})>/g)].map(
        ([, glyph, code]) => [glyph.toUpperCase(), String.fromCharCode(parseInt(code, 16))],
      ),
    );
    fonts.set(font, glyphs);
  }
  const streams = [...objects.values()]
    .filter((body) => /\/Type\s*\/Page\b/.test(body))
    .map((body) => {
      const contentId = body.match(/\/Contents\s+(\d+) 0 R/)?.[1];
      return streamFor(objects.get(contentId));
    });
  const pages = streams.map((stream) => {
      return [...stream.matchAll(/BT\r?\n([\s\S]*?)\r?\nET/g)]
        .map(([, block]) => {
          const hex = block.match(/<([0-9a-fA-F]+)>\s*Tj/)?.[1];
          if (hex) {
            const font = block.match(/\/F(\d+)\s+[\d.]+\s+Tf/)?.[1];
            const glyphs = fonts.get(font);
            return [...hex.matchAll(/.{4}/g)]
              .map(([glyph]) => glyphs?.get(glyph.toUpperCase()) || "")
              .join("");
          }
          return block.match(/\((.*?)\)\s*Tj/)?.[1] || "";
        })
        .join("\n");
    });
  return { raw, text: pages.join("\n"), pages, streams };
}

async function compactReport(state) {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    fetched.push(path);
    const payload = path.includes("conduit-layout") ? layout
      : path.includes("jeevy-logo-black") ? logo
        : path.includes("NotoSans-Regular") ? regularFont
          : path.includes("NotoSans-Bold") ? boldFont : tinyPng;
    return new Response(new Blob([payload], {
      type: path.includes(".ttf") ? "font/ttf" : "image/png",
    }));
  };
  try {
    const blob = await createInspectionPdf({
      schedule,
      state: { project: { ...schedule.project, skidName: "Skid 01" },
        records: [], photos: [], comments: [], ...state },
      backend: { getPhotoUrl: async (photo) => `/private/${photo.id}` },
      generatedAt: GENERATED_AT,
    });
    return { ...await pdfContent(blob), fetched };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function evidencePhotos(key, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${key}-${index + 1}`, recordKey: key,
    name: `evidence-${key.split(":")[1]}-${index + 1}.png`,
    createdAt: "2026-11-15T14:00:00Z", createdBy: "Inspector A",
  }));
}

function photoPlacements(stream) {
  return [...stream.matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\s*\/I\d+ Do/g)]
    .map(([, width, height, x, y]) => ({ width: +width, height: +height, x: +x, y: +y }));
}

function detailPagesFor(pages, streams, name) {
  return pages.map((text, index) => ({ text, stream: streams[index] }))
    .filter(({ text }) => text.split("\n")[2] === name);
}

function assertPlainDetail(text, name, quality) {
  assert.equal(text.split("\n")[2], name);
  if (quality) assert.ok(text.split("\n").includes(quality), text);
  else assert.doesNotMatch(text, /\b(?:Good|Bad|Unrated)\b/);
  assert.doesNotMatch(text, /\b(?:Complete|Completed|In progress|Not started|Unrated)\b/);
  assert.doesNotMatch(text, /Quality:|Cable pairs:|Evidence photos|Captured |\(continued\)|\(cont\.\)/);
  assert.doesNotMatch(text, /Inspector A|evidence-[^\s]+\.png|Nov 15, 2026|photo\s*\|\s*\d+ comment/i);
}

for (const count of [1, 2, 3, 4, 6]) {
  test(`${count} photos and comments fit on one plain page per device and terminal`, async () => {
    const keys = ["terminal:A", `device:${schedule.devices[0].id}`];
    const photos = keys.flatMap((key) => evidencePhotos(key, count));
    const { pages, streams, fetched } = await compactReport({
      photos,
      records: keys.map((key) => ({ key, complete: true, quality: "good",
        completedAt: "2026-11-16T15:00:00Z", completedBy: "Inspector A" })),
      comments: keys.map((recordKey) => ({ recordKey, authorName: "Inspector A",
        createdAt: "2026-11-16T15:00:00Z",
        text: `Verified ${recordKey}: cable labels and wiring are correct.` })),
    });
    const names = ["Terminal A", schedule.devices[0].name];
    assert.equal(fetched.filter((path) => path.startsWith("/private/")).length, photos.length);
    for (let index = 0; index < names.length; index += 1) {
      const details = detailPagesFor(pages, streams, names[index]);
      assert.equal(details.length, 1, pages.join("\n---\n"));
      const { text, stream } = details[0];
      assert.ok(text.includes(`Verified ${keys[index]}`));
      assertPlainDetail(text, names[index], "Good");
      assert.match(text, /Comments/);
      for (const photo of photos.filter((photo) => photo.recordKey === keys[index]))
        assert.ok(!text.includes(photo.name), photo.name);
      const placements = photoPlacements(stream);
      assert.equal(placements.length, count);
      placements.forEach(({ x, y, width, height }) => {
        assert.ok(x >= 43.1 && x + width <= 748.9);
        assert.ok(y >= 53.9 && y + height <= 568.9);
        assert.ok(height >= 109.9, `Photo height ${height} should remain readable`);
        assert.ok(Math.abs(width - height) < 0.01); // Square fixture keeps its aspect ratio.
      });
    }
  });
}

test("equipment photos and comments fit on one plain page for each scheduled item", async () => {
  const equipment = schedule.equipment;
  const counts = [1, 4, 6];
  const keys = equipment.map((item) => `equipment:${item.id}`);
  const photos = keys.flatMap((key, index) => evidencePhotos(key, counts[index]));
  const { pages, streams, fetched } = await compactReport({
    photos,
    records: keys.map((key, index) => ({
      key, complete: true, quality: index === 1 ? "bad" : "good",
      completedAt: "2026-11-16T15:00:00Z", completedBy: "Inspector A",
    })),
    comments: keys.map((recordKey) => ({
      recordKey, authorName: "Inspector A", createdAt: "2026-11-16T15:00:00Z",
      text: `Verified ${recordKey}: enclosure, wiring, and labeling are correct.`,
    })),
  });
  assert.equal(fetched.filter((path) => path.startsWith("/private/")).length, photos.length);
  for (let index = 0; index < equipment.length; index += 1) {
    const detailPages = detailPagesFor(pages, streams, equipment[index].name);
    assert.equal(detailPages.length, 1, equipment[index].name);
    const { text, stream } = detailPages[0];
    assert.match(text, new RegExp(`Verified ${keys[index]}`));
    assertPlainDetail(text, equipment[index].name, index === 1 ? "Bad" : "Good");
    assert.match(text, /Comments/);
    for (const photo of photos.filter((item) => item.recordKey === keys[index]))
      assert.ok(!text.includes(photo.name), photo.name);
    assert.equal(photoPlacements(stream).length, counts[index]);
  }
});

test("a target with evidence and no quality has no rating on its detail page", async () => {
  const key = "terminal:B";
  const { pages, streams } = await compactReport({
    photos: evidencePhotos(key, 1),
    comments: [{ recordKey: key, text: "Connector inspected." }],
  });
  const details = detailPagesFor(pages, streams, "Terminal B");
  assert.equal(details.length, 1);
  assertPlainDetail(details[0].text, "Terminal B");
  assert.match(details[0].text, /Connector inspected\./);
  assert.equal(photoPlacements(details[0].stream).length, 1);
});

test("inspection overview lists all 39 targets with only names and rated quality", async () => {
  const completeKey = "equipment:control-box";
  const startedKey = "equipment:solenoid-box";
  const { pages, streams } = await compactReport({
    photos: evidencePhotos(completeKey, 1).concat(evidencePhotos(startedKey, 1)),
    records: [
      { key: completeKey, complete: true, quality: "good" },
      { key: startedKey, complete: false, quality: "bad" },
    ],
  });
  assert.equal(photoPlacements(streams[1]).length, 1); // Conduit layout only.
  assert.doesNotMatch(pages[1], /complete|progress|evidence|photo|Generated|Inspector|Quality:/i);
  const summary = pages.filter((page) => page.includes("Inspection overview")).join("\n");
  assert.ok(summary);
  assert.match(summary, /Control Box\nGood/);
  assert.match(summary, /Solenoid Box\nBad/);
  assert.ok(summary.split("\n").includes("Transducer Panel"));
  assert.doesNotMatch(summary, /\b(?:Complete|In progress|Not started|Unrated)\b|Quality:|Cable pairs|photo|comment|coverage/i);
  for (const group of schedule.groups) assert.ok(summary.includes(`Terminal ${group.id}`), group.id);
  for (const device of schedule.devices) assert.ok(summary.includes(device.name), device.name);
  assert.equal(schedule.groups.length + schedule.devices.length, 36);
  assert.equal(schedule.groups.length + schedule.devices.length + schedule.equipment.length, 39);
});

test("equipment overflow repeats its heading and retains every photo and comment", async () => {
  const key = "equipment:control-box";
  const photos = evidencePhotos(key, 8);
  const note = Array.from({ length: 80 }, (_, index) =>
    `Equipment check ${index + 1}: enclosure seals and terminal wiring verified.`).join("\n");
  const { pages, text, streams } = await compactReport({
    photos,
    records: [{ key, complete: true, quality: "good" }],
    comments: [{ recordKey: key, authorName: "Inspector A",
      createdAt: "2026-11-16T15:00:00Z", text: note }],
  });
  const details = detailPagesFor(pages, streams, "Control Box");
  assert.ok(details.length >= 2);
  details.forEach(({ text: pageText }) => assertPlainDetail(pageText, "Control Box", "Good"));
  for (const photo of photos) assert.ok(!text.includes(photo.name), photo.name);
  const normalized = details.map(({ text: pageText }) => pageText).join("\n").replace(/\s+/g, "");
  for (const line of note.split("\n"))
    assert.ok(normalized.includes(line.replace(/\s+/g, "")), line);
  assert.equal(details.reduce((sum, { stream }) => sum + photoPlacements(stream).length, 0), 8);
  assert.equal(streams.reduce((sum, stream) => sum + photoPlacements(stream).length, 0), 10); // Cover, layout, 8 photos.
});

test("many photos and long notes continue with their target name and lose no evidence", async () => {
  const key = `device:${schedule.devices[0].id}`;
  const photos = evidencePhotos(key, 13);
  const note = Array.from({ length: 100 }, (_, index) =>
    `Check ${index + 1}: verified cable routing, labels, and terminal connections.`).join("\n");
  const { pages, text, streams, fetched } = await compactReport({ photos,
    records: [{ key, complete: false, quality: "bad" }],
    comments: [{ recordKey: key, authorName: "Inspector A",
      createdAt: "2026-11-16T15:00:00Z", text: note }],
  });
  assert.equal(new Set(fetched.filter((path) => path.startsWith("/private/"))).size, 13);
  assert.equal(fetched.filter((path) => path.startsWith("/private/")).length, 13);
  const details = detailPagesFor(pages, streams, schedule.devices[0].name);
  assert.ok(details.length >= 2);
  details.forEach(({ text: pageText }) => assertPlainDetail(pageText, schedule.devices[0].name, "Bad"));
  for (const photo of photos) assert.ok(!text.includes(photo.name), photo.name);
  const normalized = details.map(({ text: pageText }) => pageText).join("\n").replace(/\s+/g, "");
  for (const line of note.split("\n")) assert.ok(normalized.includes(line.replace(/\s+/g, "")), line);
  assert.equal(details.reduce((sum, { stream }) => sum + photoPlacements(stream).length, 0), 13);
  assert.equal(streams.reduce((sum, stream) => sum + photoPlacements(stream).length, 0), 15); // Cover, layout, 13 evidence images.
});

test("image placement preserves aspect ratio without cropping", () => {
  assert.deepEqual(fitImageInBox(4000, 2000, 500, 400), {
    width: 500,
    height: 250,
  });
  assert.deepEqual(fitImageInBox(1000, 4000, 500, 400), {
    width: 100,
    height: 400,
  });
  assert.throws(() => fitImageInBox(0, 100, 500, 400), /positive/);
});

test("Vietnamese and Latin text remain intact; unsupported characters remain visible", () => {
  assert.equal(printableText("“Valve” → café"), '"Valve" -> café');
  assert.equal(printableText("Kiểm tra đầu cáp"), "Kiểm tra đầu cáp");
  assert.equal(printableText("Проверка кабеля"), "Проверка кабеля");
  assert.equal(printableText("检查"), "[U+68C0][U+67E5]");
});

test("quality labels are independent of completion and explicit when unrated", () => {
  const state = {
    records: [
      { key: "terminal:A", complete: false, quality: "bad" },
      { key: "device:V-3571#1", complete: true, quality: "good" },
    ],
  };
  assert.equal(qualityFor("terminal:A", state), "Bad");
  assert.equal(qualityFor("device:V-3571#1", state), "Good");
  assert.equal(qualityFor("terminal:B", state), "Unrated");
});

test("full report paginates plain comments, includes private photos, and dates every page", async () => {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  const progress = [];
  const photos = [1, 2, 3].map((number) => ({
    id: `photo-${number}`,
    recordKey: `device:${schedule.devices[0].id}`,
    path: `private/${number}`,
    name: `evidence-${number}.png`,
    width: 1,
    height: 1,
    createdAt: "2026-11-15T14:00:00Z",
    createdBy: "inspector-1",
  }));
  const state = {
    project: { ...schedule.project, revision: 17, skidName: "Pump House A" },
    inspector: {
      id: "inspector-1",
      name: "QA Inspector",
      email: "qa@example.com",
    },
    records: [
      {
        key: `device:${schedule.devices[0].id}`,
        complete: true,
        quality: "good",
        completedAt: "2026-11-15T15:00:00Z",
        completedBy: "inspector-1",
      },
      {
        key: `terminal:${schedule.groups[0].id}`,
        complete: false,
        quality: "bad",
      },
    ],
    photos,
    comments: [
      {
        id: "long",
        recordKey: `device:${schedule.devices[0].id}`,
        text: "Observed cable routing and terminal labeling. ".repeat(90),
        createdAt: "2026-11-15T14:30:00Z",
        authorName: "QA Inspector",
      },
      {
        id: "long-2",
        recordKey: `device:${schedule.devices[0].id}`,
        text: "Second inspection note with the complete cable route. ".repeat(
          75,
        ),
        createdAt: "2026-11-15T14:45:00Z",
        authorName: "QA Inspector",
      },
      {
        id: "terminal",
        recordKey: `terminal:${schedule.groups[0].id}`,
        text: "Terminal inspected; photograph pending.",
        createdAt: "2026-11-15T14:30:00Z",
        authorName: "QA Inspector",
      },
    ],
  };
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const payload = String(url).includes("conduit-layout")
      ? layout
      : String(url).includes("jeevy-logo-black")
        ? logo
        : String(url).includes("NotoSans-Regular")
          ? regularFont
          : String(url).includes("NotoSans-Bold")
            ? boldFont
            : tinyPng;
    return new Response(
      new Blob([payload], {
        type: String(url).includes(".ttf") ? "font/ttf" : "image/png",
      }),
    );
  };
  try {
    const blob = await createInspectionPdf({
      schedule,
      state,
      backend: { getPhotoUrl: async (photo) => `/private/${photo.id}` },
      generatedAt: GENERATED_AT,
      onProgress: (update) => progress.push(update),
    });
    const { raw, text, pages: pageTexts, streams } = await pdfContent(blob);
    assert.ok(raw.startsWith("%PDF-"));
    const pages = (raw.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.ok(pages >= 6);
    assert.equal(
      (
        raw.match(
          /\/MediaBox\s*\[\s*0\s+0\s+792(?:\.0*)?\s+612(?:\.0*)?\s*\]/g,
        ) || []
      ).length,
      pages,
    );
    assert.equal((text.match(/Jeevy Fabrication/g) || []).length, pages);
    assert.match(text, /450k Skid x7 - DCS/); // Page header.
    assert.match(text, /450k skid x7 - DCS/); // Cover title.
    assert.match(raw, /450k skid x7 - DCS - QA Report - Pump House A/); // Full subtitle in PDF metadata.
    assert.match(raw, /\/CreationDate\s*\(D:20261116/);
    assert.doesNotMatch(raw, /\/Author\s*\((?:QA Inspector|qa@example\.com|inspector-1)\)/);
    assert.equal((text.match(/Revision 17/g) || []).length, pages + 1);
    assert.match(pageTexts[0], /QA Report - Pump House A/);
    assert.match(pageTexts[0], /November 16, 2026/);
    assert.equal(pageTexts.length, pages);
    pageTexts.forEach((pageText, index) => {
      assert.match(pageText, /Revision 17 \| Skid: Pump House A/);
      assert.match(pageText, /Inspected date: Nov 16, 2026/);
      assert.match(pageText, new RegExp(`Page ${index + 1} of ${pages}`));
    });
    assert.doesNotMatch(text, /QA Inspector|qa@example\.com|inspector-1|evidence-[123]\.png|Captured |Nov 15, 2026/);
    assert.equal(streams.reduce((sum, stream) => sum + photoPlacements(stream).length, 0), 5);
    for (let page = 1; page <= pages; page += 1) {
      assert.match(text, new RegExp(`Page ${page} of ${pages}`));
    }
    assert.equal(
      fetched.filter((url) => url.startsWith("/private/")).length,
      3,
    );
    assert.equal(progress.at(-1), "Report ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("general walkdown notes retain non-Latin text and paginate without changing target coverage", async () => {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const payload = String(url).includes("conduit-layout")
      ? layout
      : String(url).includes("jeevy-logo-black")
        ? logo
        : String(url).includes("NotoSans-Regular")
          ? regularFont
          : boldFont;
    return new Response(
      new Blob([payload], {
        type: String(url).includes(".ttf") ? "font/ttf" : "image/png",
      }),
    );
  };
  try {
    const blob = await createInspectionPdf({
      schedule,
      state: {
        project: { ...schedule.project, skidName: "Проверка A" },
        inspector: { id: "inspector-1", name: "QA Inspector" },
        records: [],
        photos: [],
        comments: [
          {
            id: "general-1",
            recordKey: "walkdown:general",
            authorName: "Инспектор",
            createdAt: "2026-11-16T14:00:00Z",
            text: "Проверка кабеля и общей компоновки. ".repeat(110),
          },
          {
            id: "general-2",
            recordKey: "walkdown:general",
            authorName: "Nguyễn Văn An",
            createdAt: "2026-11-16T14:20:00Z",
            text: "Ghi chú kiểm tra tổng thể cho toàn bộ skid. ".repeat(95),
          },
        ],
      },
      backend: null,
      generatedAt: GENERATED_AT,
    });
    const { raw, pages } = await pdfContent(blob);
    assert.ok((raw.match(/\/Type\s*\/Page\b/g) || []).length >= 5);
    pages.forEach((pageText) =>
      assert.match(pageText, /Revision 3 \| Skid: Проверка A/),
    );
    const notes = pages.filter((pageText) => pageText.includes("Walkdown comments")).join("\n");
    assert.ok(notes);
    assert.doesNotMatch(notes, /Инспектор|Nguyễn Văn An|notes across|Captured |Nov 16, 2026,/);
    const normalized = notes.replace(/\s+/g, "");
    assert.ok(normalized.includes("Проверкакабеляиобщейкомпоновки."));
    assert.ok(normalized.includes("Ghichúkiểmtratổngthểchotoànbộskid."));
    assert.equal(fetched.length, 4); // Layout, logo, and two fonts; no private images.
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("report refuses to omit evidence assigned outside the schedule", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Blob([layout], { type: "image/png" }));
  try {
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            project: { skidName: "Pump House A" },
            records: [],
            comments: [],
            photos: [{ id: "orphan", recordKey: "device:UNKNOWN" }],
          },
          backend: { getPhotoUrl: async () => "/photo" },
        }),
      /not assigned to a scheduled target/,
    );
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            project: { skidName: "Pump House A" },
            records: [],
            comments: [],
            photos: [{ id: "orphan-equipment", recordKey: "equipment:UNKNOWN" }],
          },
          backend: { getPhotoUrl: async () => "/photo" },
        }),
      /not assigned to a scheduled target/,
    );
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            project: { skidName: "Pump House A" },
            records: [],
            photos: [],
            comments: [
              {
                id: "orphan",
                recordKey: "device:UNKNOWN",
                text: "Unassigned note",
              },
            ],
          },
        }),
      /not assigned to a scheduled target/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("report requires a named skid before loading assets", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Assets should not be fetched");
  };
  try {
    for (const skidName of [undefined, "  "]) {
      await assert.rejects(
        () =>
          createInspectionPdf({
            schedule,
            state: {
              project: { ...schedule.project, skidName },
              records: [],
              photos: [],
              comments: [],
            },
          }),
        /Name this skid/,
      );
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("report rejects evidence or backend data from another skid before loading assets", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Assets should not be fetched");
  };
  const state = {
    project: { ...schedule.project, skidName: "Pump House A", walkdownId: "skid-a" },
    records: [],
    photos: [],
    comments: [],
  };
  try {
    await assert.rejects(
      () => createInspectionPdf({ schedule, state, backend: { walkdownId: "skid-b" } }),
      /selected skid does not match/,
    );
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            ...state,
            photos: [{ recordKey: `device:${schedule.devices[0].id}`, walkdownId: "skid-b" }],
          },
          backend: { walkdownId: "skid-a", getPhotoUrl: async () => "/photo" },
        }),
      /evidence from another skid/,
    );
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            ...state,
            photos: [{ recordKey: "equipment:control-box", walkdownId: "skid-b" }],
          },
          backend: { walkdownId: "skid-a", getPhotoUrl: async () => "/photo" },
        }),
      /evidence from another skid/,
    );
    await assert.rejects(
      () =>
        createInspectionPdf({
          schedule,
          state: {
            ...state,
            comments: [{ recordKey: "walkdown:general", walkdownId: "skid-b" }],
          },
          backend: { walkdownId: "skid-a" },
        }),
      /evidence from another skid/,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid document creation dates fail before fetching report assets", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("Unexpected fetch"); };
  try {
    for (const generatedAt of [null, "2026-11-17", new Date("invalid")]) {
      await assert.rejects(() => createInspectionPdf({
        schedule,
        state: { project: { ...schedule.project, skidName: "Skid A" }, records: [], photos: [], comments: [] },
        generatedAt,
      }), /creation date is invalid/);
    }
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 120-character skid name stays complete in a wrapped footer on every page", async () => {
  const originalFetch = globalThis.fetch;
  const skidName = "W".repeat(120);
  globalThis.fetch = async (url) => {
    const value = String(url);
    const payload = value.includes("conduit-layout")
      ? layout
      : value.includes("jeevy-logo-black")
        ? logo
        : value.includes("NotoSans-Regular")
          ? regularFont
          : boldFont;
    return new Response(
      new Blob([payload], {
        type: value.includes(".ttf") ? "font/ttf" : "image/png",
      }),
    );
  };
  try {
    const blob = await createInspectionPdf({
      schedule,
      state: {
        project: { ...schedule.project, skidName },
        records: [],
        photos: [],
        comments: [],
      },
    });
    const { pages } = await pdfContent(blob);
    assert.ok(pages.length > 1);
    assert.match(pages[0].replace(/\n/g, ""), new RegExp(`QA Report - ${skidName}`));
    pages.forEach((pageText, index) => {
      const footer = pageText
        .split("Revision 3 | Skid: ")[1]
        .split(`Page ${index + 1} of ${pages.length}`)[0]
        .replace(/Inspected date: [^\n]+/g, "")
        .replace(/\n/g, "");
      assert.equal(footer, skidName);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
