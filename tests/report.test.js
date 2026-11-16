import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("full report paginates long comments and includes every private photo", async () => {
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
    createdAt: "2026-11-16T14:00:00Z",
    createdBy: "inspector-1",
  }));
  const state = {
    project: schedule.project,
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
        completedAt: "2026-11-16T15:00:00Z",
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
        createdAt: "2026-11-16T14:30:00Z",
        authorName: "QA Inspector",
      },
      {
        id: "long-2",
        recordKey: `device:${schedule.devices[0].id}`,
        text: "Second inspection note with the complete cable route. ".repeat(
          75,
        ),
        createdAt: "2026-11-16T14:45:00Z",
        authorName: "QA Inspector",
      },
      {
        id: "terminal",
        recordKey: `terminal:${schedule.groups[0].id}`,
        text: "Terminal inspected; photograph pending.",
        createdAt: "2026-11-16T14:30:00Z",
        authorName: "QA Inspector",
      },
    ],
  };
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const payload = String(url).includes("conduit-layout")
      ? layout
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
      generatedAt: new Date("2026-11-16T16:00:00Z"),
      onProgress: (update) => progress.push(update),
    });
    const pdf = Buffer.from(await blob.arrayBuffer()).toString("latin1");
    assert.ok(pdf.startsWith("%PDF-"));
    assert.ok((pdf.match(/\/Type\s*\/Page\b/g) || []).length >= 8);
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
        project: schedule.project,
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
      generatedAt: new Date("2026-11-16T16:00:00Z"),
    });
    const pdf = Buffer.from(await blob.arrayBuffer()).toString("latin1");
    assert.ok((pdf.match(/\/Type\s*\/Page\b/g) || []).length >= 5);
    assert.equal(fetched.length, 3); // Layout and two fonts; no private images.
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
