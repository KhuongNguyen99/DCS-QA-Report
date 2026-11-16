import { jsPDF } from "jspdf";
import {
  commentsFor,
  inspectionProgress,
  photosFor,
  recordStatus,
  terminalProgress,
} from "./inspection.js";

const PAGE = { width: 595.28, height: 841.89, margin: 42, bottom: 790 };
const COLOR = {
  ink: [30, 43, 54],
  muted: [83, 101, 116],
  line: [213, 222, 229],
  blue: [17, 90, 130],
  pale: [235, 245, 250],
  white: [255, 255, 255],
  green: [31, 105, 57],
  red: [170, 49, 43],
  amber: [145, 90, 20],
  gray: [104, 117, 127],
};

/** Noto Sans covers Latin (including Vietnamese), Greek, and Cyrillic text. */
export function printableText(value) {
  const replacements = new Map([
    ["\u2018", "'"],
    ["\u2019", "'"],
    ["\u201c", '"'],
    ["\u201d", '"'],
    ["\u2013", "-"],
    ["\u2014", "-"],
    ["\u2011", "-"],
    ["\u2022", "*"],
    ["\u2192", "->"],
    ["\u00d7", "x"],
    ["\u00b0", "deg"],
    ["\u00a0", " "],
  ]);
  return Array.from(String(value ?? "").normalize("NFC"))
    .map((character) => {
      if (replacements.has(character)) return replacements.get(character);
      if (character === "\n" || character === "\r" || character === "\t")
        return character;
      const code = character.codePointAt(0);
      return (code >= 32 && code <= 0x024f) ||
        (code >= 0x0300 && code <= 0x052f) ||
        (code >= 0x1e00 && code <= 0x1eff)
        ? character
        : `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
    })
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ");
}

export function fitImageInBox(imageWidth, imageHeight, boxWidth, boxHeight) {
  if (
    ![imageWidth, imageHeight, boxWidth, boxHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error("Image dimensions must be positive.");
  }
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  return { width: imageWidth * scale, height: imageHeight * scale };
}

function formatDate(value) {
  if (!value) return "Not recorded";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? printableText(value)
    : printableText(
        date.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      );
}

function statusLabel(status) {
  return status === "complete"
    ? "Complete"
    : status === "in-progress"
      ? "In progress"
      : "Not started";
}

export function qualityFor(key, state) {
  const quality = state.records.find((record) => record.key === key)?.quality;
  return quality === "good" ? "Good" : quality === "bad" ? "Bad" : "Unrated";
}

function qualityColor(quality) {
  return quality === "Good"
    ? COLOR.green
    : quality === "Bad"
      ? COLOR.red
      : COLOR.gray;
}

function personName(id, state) {
  if (id && id === state.inspector?.id)
    return state.inspector.name || state.inspector.email || id;
  return id || "Inspector not recorded";
}

function setText(doc, color = COLOR.ink, size = 10, style = "normal") {
  doc.setTextColor(...color);
  doc.setFont(
    "NotoSans",
    style === "bold" && doc._reportBoldFont ? "bold" : "normal",
  );
  doc.setFontSize(size);
}

function drawPageHeader(doc, project, section) {
  setText(doc, COLOR.blue, 9, "bold");
  doc.text("JEEVY FABRICATION", PAGE.margin, 31);
  setText(doc, COLOR.muted, 8);
  doc.text(printableText(section).toUpperCase(), PAGE.width - PAGE.margin, 31, {
    align: "right",
  });
  doc.setDrawColor(...COLOR.line);
  doc.setLineWidth(0.7);
  doc.line(PAGE.margin, 43, PAGE.width - PAGE.margin, 43);
  setText(doc, COLOR.muted, 8);
  doc.text(
    `${printableText(project.title)}  |  Rev ${printableText(project.revision)}`,
    PAGE.margin,
    55,
  );
}

function newPage(doc, project, section) {
  doc.addPage();
  drawPageHeader(doc, project, section);
  return 79;
}

function drawFooters(doc, project) {
  const count = doc.getNumberOfPages();
  for (let page = 1; page <= count; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...COLOR.line);
    doc.line(PAGE.margin, 805, PAGE.width - PAGE.margin, 805);
    setText(doc, COLOR.muted, 8);
    doc.text(printableText(project.title), PAGE.margin, 820);
    doc.text(`Page ${page} of ${count}`, PAGE.width - PAGE.margin, 820, {
      align: "right",
    });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  }
  return btoa(binary);
}

async function imageData(blob) {
  if (
    !(blob instanceof Blob) ||
    !["image/jpeg", "image/png", "image/webp"].includes(blob.type)
  ) {
    throw new Error("Evidence must be a JPEG, PNG, or WebP image.");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw new Error("Evidence image is empty.");
  return `data:${blob.type};base64,${bytesToBase64(bytes)}`;
}

async function fetchImage(url, label) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `Could not fetch ${label}: ${error.message || String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok)
    throw new Error(
      `Could not fetch ${label} (HTTP ${response.status}). Refresh and try again.`,
    );
  return imageData(await response.blob());
}

async function fetchFont(url, required) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (!required) return null;
    throw new Error(
      `Could not load the report font: ${error.message || String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    if (!required) return null;
    throw new Error(
      "Could not load the report font. Refresh the app and try again.",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("The report font is empty.");
  return bytesToBase64(bytes);
}

function drawCover(doc, schedule, state, project, generatedAt, layoutImage) {
  drawPageHeader(doc, project, "Inspection report");
  setText(doc, COLOR.blue, 10, "bold");
  doc.text("DCS QUALITY ASSURANCE", PAGE.margin, 102);
  setText(doc, COLOR.ink, 25, "bold");
  const titleLines = doc.splitTextToSize(
    printableText(project.title),
    PAGE.width - PAGE.margin * 2,
  );
  doc.text(titleLines, PAGE.margin, 138);
  const belowTitle = 138 + titleLines.length * 27;
  setText(doc, COLOR.muted, 10);
  doc.text(
    `Revision ${printableText(project.revision)}  |  Generated ${formatDate(generatedAt)}`,
    PAGE.margin,
    belowTitle + 7,
  );
  doc.text(
    `Exported by ${printableText(state.inspector?.name || state.inspector?.email || "Inspector not recorded")}`,
    PAGE.margin,
    belowTitle + 24,
  );

  const progress = inspectionProgress(schedule.devices, schedule.groups, state);
  const cardsY = belowTitle + 56;
  const cardWidth = (PAGE.width - PAGE.margin * 2 - 20) / 3;
  const metrics = [
    [`${progress.devices}/${schedule.devices.length}`, "Devices complete"],
    [`${progress.terminals}/${schedule.groups.length}`, "Terminals complete"],
    [String(state.photos.length), "Evidence photos"],
  ];
  metrics.forEach(([value, label], index) => {
    const x = PAGE.margin + index * (cardWidth + 10);
    doc.setFillColor(...COLOR.pale);
    doc.roundedRect(x, cardsY, cardWidth, 68, 7, 7, "F");
    setText(doc, COLOR.blue, 20, "bold");
    doc.text(value, x + 12, cardsY + 29);
    setText(doc, COLOR.muted, 9);
    doc.text(label, x + 12, cardsY + 49);
  });

  const statusCounts = { complete: 0, "in-progress": 0, "not-started": 0 };
  const qualityCounts = { Good: 0, Bad: 0, Unrated: 0 };
  for (const group of schedule.groups)
    statusCounts[recordStatus(`terminal:${group.id}`, state)] += 1;
  for (const device of schedule.devices)
    statusCounts[recordStatus(`device:${device.id}`, state)] += 1;
  for (const group of schedule.groups)
    qualityCounts[qualityFor(`terminal:${group.id}`, state)] += 1;
  for (const device of schedule.devices)
    qualityCounts[qualityFor(`device:${device.id}`, state)] += 1;
  const countsY = cardsY + 92;
  setText(doc, COLOR.ink, 10, "bold");
  doc.text(
    "Evidence status across all scheduled targets",
    PAGE.margin,
    countsY,
  );
  setText(doc, COLOR.muted, 9);
  doc.text(
    `${statusCounts.complete} complete  |  ${statusCounts["in-progress"]} in progress  |  ${statusCounts["not-started"]} not started / no evidence`,
    PAGE.margin,
    countsY + 20,
  );
  setText(doc, COLOR.muted, 9);
  doc.text(
    `Quality: ${qualityCounts.Good} good  |  ${qualityCounts.Bad} bad  |  ${qualityCounts.Unrated} unrated`,
    PAGE.margin,
    countsY + 35,
  );

  const imageY = countsY + 78;
  setText(doc, COLOR.ink, 14, "bold");
  doc.text("Conduit layout", PAGE.margin, imageY);
  doc.setDrawColor(...COLOR.line);
  doc.rect(PAGE.margin, imageY + 15, PAGE.width - PAGE.margin * 2, 215);
  const dimensions = doc.getImageProperties(layoutImage);
  const fitted = fitImageInBox(
    dimensions.width,
    dimensions.height,
    PAGE.width - PAGE.margin * 2 - 16,
    199,
  );
  doc.addImage(
    layoutImage,
    dimensions.fileType,
    PAGE.margin + (PAGE.width - PAGE.margin * 2 - fitted.width) / 2,
    imageY + 23 + (199 - fitted.height) / 2,
    fitted.width,
    fitted.height,
  );
  setText(doc, COLOR.muted, 8);
  doc.text(
    "Complete schedule and evidence details follow. Missing evidence is listed explicitly in the summary.",
    PAGE.margin,
    imageY + 250,
  );
}

function cableLabel(device) {
  return device.cables?.length
    ? device.cables.map((cable) => `${cable.type} #${cable.number}`).join(", ")
    : "No cable pairs listed";
}

function drawSummary(doc, schedule, state, project) {
  let y;
  function start() {
    y = newPage(doc, project, "Schedule summary");
    setText(doc, COLOR.ink, 17, "bold");
    doc.text("All terminals and devices", PAGE.margin, y);
    y += 25;
    setText(doc, COLOR.muted, 9);
    doc.text("Target", PAGE.margin + 7, y);
    doc.text("Evidence status", 170, y);
    doc.text("Quality", 265, y);
    doc.text("Cable pairs / coverage", 337, y);
    y += 10;
    doc.setDrawColor(...COLOR.line);
    doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
    y += 5;
  }
  function ensure(height) {
    if (y + height > PAGE.bottom) {
      start();
      return true;
    }
    return false;
  }
  function groupHeader(group, progress, continued = false) {
    const coverageLines = doc.splitTextToSize(
      `${progress.complete}/${progress.total} devices complete; ${progress.terminalPhotos} terminal photos`,
      205,
    );
    const height = Math.max(29, coverageLines.length * 11 + 13);
    doc.setFillColor(...COLOR.pale);
    doc.rect(PAGE.margin, y, PAGE.width - PAGE.margin * 2, height, "F");
    setText(doc, COLOR.ink, 10, "bold");
    doc.text(
      `Terminal ${printableText(group.id)}${continued ? " (cont.)" : ""}`,
      PAGE.margin + 7,
      y + 17,
    );
    setText(doc, COLOR.blue, 9, "bold");
    doc.text(
      statusLabel(recordStatus(`terminal:${group.id}`, state)),
      170,
      y + 17,
    );
    const quality = qualityFor(`terminal:${group.id}`, state);
    setText(doc, qualityColor(quality), 9, "bold");
    doc.text(quality, 265, y + 17);
    setText(doc, COLOR.ink, 9);
    doc.text(coverageLines, 337, y + 17);
    y += height + 2;
  }
  start();
  for (const group of schedule.groups) {
    const progress = terminalProgress(group.id, schedule.devices, state);
    ensure(46);
    groupHeader(group, progress);
    for (const device of schedule.devices.filter(
      (item) => item.terminal === group.id,
    )) {
      const cableLines = doc.splitTextToSize(
        printableText(cableLabel(device)),
        200,
      );
      const rowHeight = Math.max(22, cableLines.length * 11 + 9);
      if (ensure(rowHeight + 46)) groupHeader(group, progress, true);
      setText(doc, COLOR.ink, 9, "bold");
      doc.text(printableText(device.name), PAGE.margin + 7, y + 14);
      const status = recordStatus(`device:${device.id}`, state);
      setText(
        doc,
        status === "complete"
          ? COLOR.green
          : status === "in-progress"
            ? COLOR.amber
            : COLOR.gray,
        9,
      );
      doc.text(statusLabel(status), 170, y + 14);
      const quality = qualityFor(`device:${device.id}`, state);
      setText(doc, qualityColor(quality), 9, "bold");
      doc.text(quality, 265, y + 14);
      setText(doc, COLOR.ink, 9);
      doc.text(cableLines, 337, y + 14);
      y += rowHeight;
      doc.setDrawColor(...COLOR.line);
      doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
    }
    y += 10;
  }
}

function drawWrappedText(
  doc,
  value,
  x,
  width,
  startY,
  project,
  section,
  lineHeight = 13,
) {
  let y = startY;
  const text = printableText(value) || "(empty)";
  const lines = text
    .split("\n")
    .flatMap((paragraph) => doc.splitTextToSize(paragraph || " ", width));
  for (const line of lines) {
    if (y + lineHeight > PAGE.bottom) {
      y = newPage(doc, project, section);
      setText(doc, COLOR.muted, 9, "bold");
      doc.text("Continued", x, y);
      y += 18;
      setText(doc, COLOR.ink, 9);
    }
    doc.text(line, x, y);
    y += lineHeight;
  }
  return y;
}

function drawComments(doc, comments, state, project, section, startY) {
  let y = startY;
  for (const comment of comments) {
    if (y + 52 > PAGE.bottom)
      y = newPage(doc, project, `${section} - comments`);
    setText(doc, COLOR.blue, 9, "bold");
    const author = comment.authorName || personName(comment.createdBy, state);
    y =
      drawWrappedText(
        doc,
        `${author}  |  ${formatDate(comment.createdAt)}`,
        PAGE.margin,
        PAGE.width - PAGE.margin * 2,
        y,
        project,
        `${section} - comments`,
        13,
      ) + 4;
    setText(doc, COLOR.ink, 9);
    y =
      drawWrappedText(
        doc,
        comment.text,
        PAGE.margin + 8,
        PAGE.width - PAGE.margin * 2 - 8,
        y,
        project,
        `${section} - comments`,
        13,
      ) + 17;
  }
  return y;
}

function drawGeneralComments(doc, state, project) {
  const comments = state.comments.filter(
    (comment) => comment.recordKey === "walkdown:general",
  );
  if (!comments.length) return;
  let y = newPage(doc, project, "General walkdown notes");
  setText(doc, COLOR.ink, 18, "bold");
  doc.text("General walkdown notes", PAGE.margin, y);
  y += 25;
  setText(doc, COLOR.muted, 9);
  doc.text(
    `${comments.length} note${comments.length === 1 ? "" : "s"} across the inspection`,
    PAGE.margin,
    y,
  );
  y += 20;
  doc.setDrawColor(...COLOR.line);
  doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
  drawComments(doc, comments, state, project, "General walkdown notes", y + 25);
}

function drawRecordDetails(doc, entry, state, project) {
  const { key, label, device } = entry;
  const status = recordStatus(key, state);
  const photos = photosFor(key, state);
  const comments = commentsFor(key, state);
  const record = state.records.find((item) => item.key === key);
  let y = newPage(doc, project, label);
  setText(doc, COLOR.ink, 18, "bold");
  doc.text(printableText(label), PAGE.margin, y);
  y += 25;
  setText(doc, COLOR.blue, 10, "bold");
  doc.text(statusLabel(status), PAGE.margin, y);
  setText(doc, COLOR.muted, 9);
  doc.text(
    `${photos.length} photo${photos.length === 1 ? "" : "s"}  |  ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
    PAGE.margin + 100,
    y,
  );
  const quality = qualityFor(key, state);
  setText(doc, qualityColor(quality), 9, "bold");
  doc.text(`Quality: ${quality}`, PAGE.width - PAGE.margin, y, {
    align: "right",
  });
  y += 23;
  if (device) {
    setText(doc, COLOR.ink, 9);
    y =
      drawWrappedText(
        doc,
        `Cable pairs: ${cableLabel(device)}`,
        PAGE.margin,
        PAGE.width - PAGE.margin * 2,
        y,
        project,
        label,
        13,
      ) + 7;
  }
  if (record?.complete) {
    setText(doc, COLOR.muted, 9);
    y =
      drawWrappedText(
        doc,
        `Completed ${formatDate(record.completedAt)} by ${personName(record.completedBy, state)}`,
        PAGE.margin,
        PAGE.width - PAGE.margin * 2,
        y,
        project,
        label,
        13,
      ) + 8;
  }
  doc.setDrawColor(...COLOR.line);
  doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
  y += 22;
  setText(doc, COLOR.ink, 12, "bold");
  doc.text("Comments", PAGE.margin, y);
  y += 19;
  if (!comments.length) {
    setText(doc, COLOR.muted, 9);
    doc.text("No comments recorded.", PAGE.margin, y);
    y += 18;
  }
  y = drawComments(doc, comments, state, project, label, y);
  if (photos.length) {
    if (y + 26 > PAGE.bottom) y = newPage(doc, project, label);
    setText(doc, COLOR.muted, 9);
    doc.text(
      `All ${photos.length} photo${photos.length === 1 ? "" : "s"} follow on separate pages.`,
      PAGE.margin,
      y,
    );
  }
}

async function drawPhotoPage(doc, photo, entry, backend, project, state) {
  const name = printableText(photo.name || "Inspection photo");
  const label = `${entry.label} - photo`;
  let y = newPage(doc, project, label);
  setText(doc, COLOR.ink, 16, "bold");
  doc.text(printableText(entry.label), PAGE.margin, y);
  y += 22;
  const quality = qualityFor(entry.key, state);
  setText(doc, qualityColor(quality), 9, "bold");
  doc.text(`Quality: ${quality}`, PAGE.margin, y);
  y += 16;
  setText(doc, COLOR.blue, 10, "bold");
  y =
    drawWrappedText(
      doc,
      name,
      PAGE.margin,
      PAGE.width - PAGE.margin * 2,
      y,
      project,
      label,
      14,
    ) + 3;
  setText(doc, COLOR.muted, 9);
  y =
    drawWrappedText(
      doc,
      `Captured ${formatDate(photo.createdAt)} by ${personName(photo.createdBy, state)}`,
      PAGE.margin,
      PAGE.width - PAGE.margin * 2,
      y,
      project,
      label,
      12,
    ) + 13;

  let url;
  try {
    url = await backend.getPhotoUrl(photo);
  } catch (error) {
    throw new Error(
      `Could not access photo "${name}": ${error.message || String(error)}`,
      { cause: error },
    );
  }
  const data = await fetchImage(url, `photo "${name}"`);
  let properties;
  try {
    properties = doc.getImageProperties(data);
  } catch (error) {
    throw new Error(`Photo "${name}" could not be decoded for the PDF.`, {
      cause: error,
    });
  }
  const boxWidth = PAGE.width - PAGE.margin * 2;
  const boxHeight = PAGE.bottom - y - 13;
  if (boxHeight < 100)
    throw new Error(`Photo "${name}" metadata is too long for a page.`);
  const fitted = fitImageInBox(
    properties.width,
    properties.height,
    boxWidth,
    boxHeight,
  );
  doc.setDrawColor(...COLOR.line);
  doc.rect(PAGE.margin, y, boxWidth, boxHeight);
  doc.addImage(
    data,
    properties.fileType,
    PAGE.margin + (boxWidth - fitted.width) / 2,
    y + (boxHeight - fitted.height) / 2,
    fitted.width,
    fitted.height,
  );
}

/** Builds a full inspection snapshot. The caller handles download or sharing. */
export async function createInspectionPdf({
  schedule,
  state,
  backend,
  generatedAt = new Date(),
  onProgress = () => {},
}) {
  if (
    !schedule?.project ||
    !Array.isArray(schedule.groups) ||
    !Array.isArray(schedule.devices)
  ) {
    throw new Error("The inspection schedule is incomplete.");
  }
  if (
    !state ||
    !Array.isArray(state.records) ||
    !Array.isArray(state.photos) ||
    !Array.isArray(state.comments)
  ) {
    throw new Error("Shared inspection data is incomplete.");
  }
  if (state.photos.length && typeof backend?.getPhotoUrl !== "function") {
    throw new Error("Photo access is unavailable for this report.");
  }
  const entries = schedule.groups.flatMap((group) => [
    { key: `terminal:${group.id}`, label: `Terminal ${group.id}` },
    ...schedule.devices
      .filter((device) => device.terminal === group.id)
      .map((device) => ({
        key: `device:${device.id}`,
        label: `Device ${device.name} - Terminal ${group.id}`,
        device,
      })),
  ]);
  const validKeys = new Set(entries.map((entry) => entry.key));
  const orphan =
    state.photos.find((item) => !validKeys.has(item.recordKey)) ||
    state.comments.find(
      (item) =>
        item.recordKey !== "walkdown:general" && !validKeys.has(item.recordKey),
    );
  if (orphan)
    throw new Error(
      "Evidence is not assigned to a scheduled target. Refresh the inspection and try again.",
    );
  const project = {
    title: state.project?.title || schedule.project.title,
    revision: state.project?.revision ?? schedule.project.revision,
  };
  const totalPhotos = state.photos.length;
  onProgress("Loading report assets…");
  const baseUrl = import.meta.env?.BASE_URL || "/";
  const [layout, regularFont, boldFont] = await Promise.all([
    fetchImage(`${baseUrl}assets/conduit-layout.png`, "the conduit layout"),
    fetchFont(`${baseUrl}assets/NotoSans-Regular.ttf`, true),
    fetchFont(`${baseUrl}assets/NotoSans-Bold.ttf`, false),
  ]);
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
    compress: true,
  });
  doc.addFileToVFS("NotoSans-Regular.ttf", regularFont);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  if (boldFont) {
    doc.addFileToVFS("NotoSans-Bold.ttf", boldFont);
    doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
    doc._reportBoldFont = true;
  }
  doc.setProperties({
    title: `${project.title} - DCS QA Inspection`,
    subject: `Revision ${project.revision} inspection evidence`,
    author:
      state.inspector?.name || state.inspector?.email || "Jeevy Fabrication",
    creator: "Jeevy DCS QA Report",
  });
  drawCover(doc, schedule, state, project, generatedAt, layout);
  drawGeneralComments(doc, state, project);
  drawSummary(doc, schedule, state, project);
  let completed = 0;
  for (const entry of entries) {
    if (recordStatus(entry.key, state) === "not-started") continue;
    drawRecordDetails(doc, entry, state, project);
    for (const photo of photosFor(entry.key, state)) {
      onProgress(`Adding photo ${completed + 1} of ${totalPhotos}…`);
      await drawPhotoPage(doc, photo, entry, backend, project, state);
      completed += 1;
    }
  }
  if (completed !== totalPhotos) {
    throw new Error(
      `${totalPhotos - completed} evidence photo(s) are not assigned to scheduled targets. Refresh the inspection and try again.`,
    );
  }
  drawFooters(doc, project);
  onProgress("Report ready");
  return doc.output("blob");
}
