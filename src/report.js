import { jsPDF } from "jspdf";
import {
  commentsFor,
  inspectionProgress,
  photosFor,
  recordStatus,
  terminalProgress,
} from "./inspection.js";

const REPORT_TITLE = "450k Skid x7 - DCS";
const COVER_TITLE = "450k skid x7 - DCS";
const PAGE = { width: 792, height: 612, margin: 43.2, bottom: 570 };
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
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.9);
  doc.setTextColor(80, 80, 80);
  doc.text("Jeevy Fabrication", PAGE.margin, 16);
  doc.text(REPORT_TITLE, PAGE.width - PAGE.margin, 16, { align: "right" });
}

function newPage(doc, project, section) {
  doc.addPage();
  drawPageHeader(doc, project, section);
  return 61;
}

function drawFooters(doc, project) {
  const count = doc.getNumberOfPages();
  for (let page = 1; page <= count; page += 1) {
    doc.setPage(page);
    const pageLabel = `Page ${page} of ${count}`;
    const footer = `Revision ${printableText(project.revision)} | Skid: ${printableText(project.skidName)}`;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.9);
    const availableWidth =
      PAGE.width - PAGE.margin * 2 - doc.getTextWidth(pageLabel) - 18;
    setText(doc, [80, 80, 80], 7.9);
    const lines = doc.splitTextToSize(footer, availableWidth);
    if (lines.length > 2)
      throw new Error("Skid name is too long to fit in the report footer.");
    lines.forEach((line, index) =>
      doc.text(line, PAGE.margin, 599 - (lines.length - index - 1) * 11),
    );
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(pageLabel, PAGE.width - PAGE.margin, 599, {
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

function drawCover(doc, project, generatedAt, logoImage) {
  drawPageHeader(doc, project, "Cover");
  doc.addImage(logoImage, "PNG", PAGE.margin, 39.6, 223.2, 74.88);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(15.1);
  doc.text(
    generatedAt.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    PAGE.margin,
    239,
  );
  const subtitle = `QA Report - ${printableText(project.skidName)}`;
  let size = 36;
  let lines;
  let subtitleEnd;
  do {
    setText(doc, [0, 0, 0], size, "bold");
    lines = doc.splitTextToSize(subtitle, PAGE.width - PAGE.margin * 2);
    subtitleEnd = 345 + (lines.length - 1) * size * 1.2;
    if (subtitleEnd + 40 <= 550) break;
    size -= 1;
  } while (size >= 12);
  if (subtitleEnd + 40 > 550)
    throw new Error("Skid name is too long to fit on the report cover.");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(Math.min(31.9, size - 1));
  doc.text(COVER_TITLE, PAGE.margin, 290);
  setText(doc, [0, 0, 0], size, "bold");
  lines.forEach((line, index) =>
    doc.text(line, PAGE.margin, 345 + index * size * 1.2),
  );
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(`Revision ${printableText(project.revision)}`, PAGE.margin, subtitleEnd + 40);
}

function drawOverview(doc, schedule, state, project, generatedAt, layoutImage) {
  let y = newPage(doc, project, "Conduit layout");
  setText(doc, COLOR.ink, 28, "bold");
  doc.text("Conduit Layout", PAGE.margin, y);
  const dimensions = doc.getImageProperties(layoutImage);
  const fitted = fitImageInBox(
    dimensions.width,
    dimensions.height,
    PAGE.width - PAGE.margin * 2,
    290,
  );
  doc.addImage(
    layoutImage,
    dimensions.fileType,
    PAGE.margin + (PAGE.width - PAGE.margin * 2 - fitted.width) / 2,
    88,
    fitted.width,
    fitted.height,
  );

  const progress = inspectionProgress(schedule.devices, schedule.groups, state);
  const cardsY = 389;
  const cardWidth = (PAGE.width - PAGE.margin * 2 - 24) / 3;
  const metrics = [
    [`${progress.devices}/${schedule.devices.length}`, "Devices complete"],
    [`${progress.terminals}/${schedule.groups.length}`, "Terminals complete"],
    [String(state.photos.length), "Evidence photos"],
  ];
  metrics.forEach(([value, label], index) => {
    const x = PAGE.margin + index * (cardWidth + 12);
    doc.setFillColor(...COLOR.pale);
    doc.roundedRect(x, cardsY, cardWidth, 60, 5, 5, "F");
    setText(doc, COLOR.blue, 17, "bold");
    doc.text(value, x + 12, cardsY + 26);
    setText(doc, COLOR.muted, 9);
    doc.text(label, x + 12, cardsY + 45);
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
  const countsY = cardsY + 78;
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

  setText(doc, COLOR.muted, 8);
  doc.text(
    `Generated ${formatDate(generatedAt)} by ${printableText(state.inspector?.name || state.inspector?.email || "Inspector not recorded")}. Full target coverage follows.`,
    PAGE.margin,
    countsY + 56,
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
    doc.text("Evidence status", 220, y);
    doc.text("Quality", 340, y);
    doc.text("Cable pairs / coverage", 430, y);
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
      300,
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
      220,
      y + 17,
    );
    const quality = qualityFor(`terminal:${group.id}`, state);
    setText(doc, qualityColor(quality), 9, "bold");
    doc.text(quality, 340, y + 17);
    setText(doc, COLOR.ink, 9);
    doc.text(coverageLines, 430, y + 17);
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
        300,
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
      doc.text(statusLabel(status), 220, y + 14);
      const quality = qualityFor(`device:${device.id}`, state);
      setText(doc, qualityColor(quality), 9, "bold");
      doc.text(quality, 340, y + 14);
      setText(doc, COLOR.ink, 9);
      doc.text(cableLines, 430, y + 14);
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
      `All ${photos.length} photo${photos.length === 1 ? "" : "s"} follow on the next page${photos.length > 2 ? "s" : ""}.`,
      PAGE.margin,
      y,
    );
  }
}

async function drawPhotoPage(
  doc,
  photos,
  entry,
  backend,
  project,
  state,
  onProgress,
  completed,
  totalPhotos,
) {
  const y = newPage(doc, project, `${entry.label} - photos`);
  setText(doc, COLOR.ink, 16, "bold");
  doc.text(printableText(entry.label), PAGE.margin, y);
  const quality = qualityFor(entry.key, state);
  setText(doc, qualityColor(quality), 9, "bold");
  doc.text(`Quality: ${quality}`, PAGE.margin, y + 20);

  const gap = 18;
  const slotWidth =
    photos.length === 1
      ? PAGE.width - PAGE.margin * 2
      : (PAGE.width - PAGE.margin * 2 - gap) / 2;
  const prepared = [];
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const name = printableText(photo.name || "Inspection photo");
    onProgress(`Adding photo ${completed + index + 1} of ${totalPhotos}…`);
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
    setText(doc, COLOR.blue, 10, "bold");
    const nameLines = doc.splitTextToSize(name, slotWidth);
    setText(doc, COLOR.muted, 9);
    const metaLines = doc.splitTextToSize(
      printableText(
        `Captured ${formatDate(photo.createdAt)} by ${personName(photo.createdBy, state)}`,
      ),
      slotWidth,
    );
    prepared.push({ data, properties, nameLines, metaLines });
  }

  const imageTop = Math.max(
    161,
    ...prepared.map(
      ({ nameLines, metaLines }) =>
        101 + nameLines.length * 13 + metaLines.length * 11 + 10,
    ),
  );
  const boxHeight = PAGE.bottom - imageTop - 5;
  if (boxHeight < 160)
    throw new Error("Photo metadata is too long to fit on a landscape page.");
  prepared.forEach(({ data, properties, nameLines, metaLines }, index) => {
    const x = PAGE.margin + index * (slotWidth + gap);
    setText(doc, COLOR.blue, 10, "bold");
    doc.text(nameLines, x, 101);
    setText(doc, COLOR.muted, 9);
    doc.text(metaLines, x, 101 + nameLines.length * 13 + 5);
    doc.setDrawColor(...COLOR.line);
    doc.rect(x, imageTop, slotWidth, boxHeight);
    const fitted = fitImageInBox(
      properties.width,
      properties.height,
      slotWidth,
      boxHeight,
    );
    doc.addImage(
      data,
      properties.fileType,
      x + (slotWidth - fitted.width) / 2,
      imageTop + (boxHeight - fitted.height) / 2,
      fitted.width,
      fitted.height,
    );
  });
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
  const walkdownId = state.project?.walkdownId;
  if (walkdownId && backend?.walkdownId && backend.walkdownId !== walkdownId)
    throw new Error("The selected skid does not match the loaded report data.");
  if (
    [...state.photos, ...state.comments].some(
      (item) => item.walkdownId && item.walkdownId !== walkdownId,
    )
  ) {
    throw new Error("The report contains evidence from another skid.");
  }
  if (state.photos.length && typeof backend?.getPhotoUrl !== "function") {
    throw new Error("Photo access is unavailable for this report.");
  }
  if (
    typeof state.project?.skidName !== "string" ||
    !state.project.skidName.trim()
  ) {
    throw new Error("Name this skid before exporting its QA report.");
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
    title: REPORT_TITLE,
    revision: state.project?.revision ?? schedule.project.revision,
    skidName: state.project.skidName.trim().replace(/\s+/g, " "),
  };
  const totalPhotos = state.photos.length;
  onProgress("Loading report assets…");
  const baseUrl = import.meta.env?.BASE_URL || "/";
  const [layout, logo, regularFont, boldFont] = await Promise.all([
    fetchImage(`${baseUrl}assets/conduit-layout.png`, "the conduit layout"),
    fetchImage(`${baseUrl}assets/jeevy-logo-black.png`, "the Jeevy logo"),
    fetchFont(`${baseUrl}assets/NotoSans-Regular.ttf`, true),
    fetchFont(`${baseUrl}assets/NotoSans-Bold.ttf`, true),
  ]);
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "letter",
    compress: true,
  });
  doc.addFileToVFS("NotoSans-Regular.ttf", regularFont);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", boldFont);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  doc._reportBoldFont = true;
  doc.setProperties({
    title: `${COVER_TITLE} - QA Report - ${project.skidName}`,
    subject: `Revision ${project.revision} inspection evidence for ${project.skidName}`,
    author:
      state.inspector?.name || state.inspector?.email || "Jeevy Fabrication",
    creator: "Jeevy DCS QA Report",
  });
  drawCover(doc, project, generatedAt, logo);
  drawOverview(doc, schedule, state, project, generatedAt, layout);
  drawGeneralComments(doc, state, project);
  drawSummary(doc, schedule, state, project);
  let completed = 0;
  for (const entry of entries) {
    if (recordStatus(entry.key, state) === "not-started") continue;
    drawRecordDetails(doc, entry, state, project);
    const photos = photosFor(entry.key, state);
    for (let index = 0; index < photos.length; index += 2) {
      const pagePhotos = photos.slice(index, index + 2);
      await drawPhotoPage(
        doc,
        pagePhotos,
        entry,
        backend,
        project,
        state,
        onProgress,
        completed,
        totalPhotos,
      );
      completed += pagePhotos.length;
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
