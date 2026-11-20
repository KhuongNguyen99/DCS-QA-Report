import { jsPDF } from "jspdf";
import { inspectionTargets, revisionNumber } from "./domain.js";
import { commentsFor, photosFor, recordStatus } from "./inspection.js";

const REPORT_TITLE = "450k Skid x7 - DCS";
const COVER_TITLE = "450k skid x7 - DCS";
const PAGE = { width: 792, height: 612, margin: 43.2, bottom: 558 };
const COLOR = {
  ink: [30, 43, 54],
  muted: [83, 101, 116],
  line: [213, 222, 229],
  green: [31, 105, 57],
  red: [170, 49, 43],
  gray: [104, 117, 127],
};
const COMMENT = { size: 14, lineHeight: 18, headingSize: 13, headingHeight: 22, gap: 10 };
const COMMENT_COLOR = [196, 32, 32];

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

export function qualityFor(key, state) {
  const quality = state.records.find((record) => record.key === key)?.quality;
  return quality === "good" ? "Passed" : quality === "bad" ? "Failed" : "Unrated";
}

function qualityColor(quality) {
  return quality === "Passed"
    ? COLOR.green
    : quality === "Failed"
      ? COLOR.red
      : COLOR.gray;
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

export function drawReportFooter(doc, project, closedAt, page, count) {
  const approvedDate = closedAt.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
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
  doc.text(`Approved date: ${approvedDate}`, PAGE.margin, 599 - lines.length * 11);
  lines.forEach((line, index) =>
    doc.text(line, PAGE.margin, 599 - (lines.length - index - 1) * 11),
  );
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(pageLabel, PAGE.width - PAGE.margin, 599, { align: "right" });
}

function drawFooters(doc, project, closedAt) {
  const count = doc.getNumberOfPages();
  for (let page = 1; page <= count; page += 1) {
    drawReportFooter(doc, project, closedAt, page, count);
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

export function loadReportLogo() {
  return fetchImage(`${import.meta.env?.BASE_URL || "/"}assets/jeevy-logo-black.png`, "the Jeevy logo");
}

export function drawCover(doc, project, closedAt, logoImage, label = "QC Report") {
  drawPageHeader(doc, project, "Cover");
  doc.addImage(logoImage, "PNG", PAGE.margin, 39.6, 223.2, 74.88);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(15.1);
  doc.text(
    closedAt.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
    PAGE.margin,
    239,
  );
  const subtitle = `${label} - ${printableText(project.skidName)}`;
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

function drawOverview(doc, project, layoutImage) {
  const y = newPage(doc, project, "Conduit layout");
  setText(doc, COLOR.ink, 28, "bold");
  doc.text("Conduit Layout", PAGE.margin, y);
  const dimensions = doc.getImageProperties(layoutImage);
  const fitted = fitImageInBox(
    dimensions.width, dimensions.height,
    PAGE.width - PAGE.margin * 2, PAGE.bottom - 110,
  );
  doc.addImage(
    layoutImage, dimensions.fileType,
    PAGE.margin + (PAGE.width - PAGE.margin * 2 - fitted.width) / 2,
    100 + (PAGE.bottom - 110 - fitted.height) / 2,
    fitted.width, fitted.height,
  );
}

function drawSummary(doc, targets, state, project) {
  const rows = Math.floor((PAGE.bottom - 103) / 22);
  const gap = 24;
  const width = (PAGE.width - PAGE.margin * 2 - gap) / 2;
  for (let offset = 0; offset < targets.length; offset += rows * 2) {
    const y = newPage(doc, project, "Inspection overview");
    setText(doc, COLOR.ink, 17, "bold");
    doc.text("Inspection overview", PAGE.margin, y);
    for (let column = 0; column < 2; column += 1) {
      const x = PAGE.margin + column * (width + gap);
      setText(doc, COLOR.muted, 9);
      doc.text("Item", x + 7, 88);
      doc.text("Passed/Failed", x + width - 7, 88, { align: "right" });
      doc.setDrawColor(...COLOR.line);
      doc.line(x, 98, x + width, 98);
      targets.slice(offset + column * rows, offset + (column + 1) * rows)
        .forEach((target, index) => {
          const rowY = 103 + index * 22;
          setText(doc, COLOR.ink, 9, "bold");
          doc.text(printableText(target.label), x + 7, rowY + 14);
          const quality = qualityFor(target.key, state);
          if (quality !== "Unrated") {
            setText(doc, qualityColor(quality), 12, "bold");
            doc.text(quality, x + width - 7, rowY + 14, { align: "right" });
          }
          doc.setDrawColor(...COLOR.line);
          doc.line(x, rowY + 22, x + width, rowY + 22);
        });
    }
  }
}

function prepareRecordComments(doc, comments) {
  setText(doc, COMMENT_COLOR, COMMENT.size, "bold");
  return comments.map((comment) => printableText(comment.text)
    .split("\n")
    .flatMap((paragraph) => doc.splitTextToSize(
      paragraph || " ", PAGE.width - PAGE.margin * 2,
    )));
}

function drawRecordComments(doc, comments, startY, nextPage, showHeading = true) {
  if (!comments.length) return;
  let y = startY;
  function heading() {
    if (!showHeading) return;
    setText(doc, COMMENT_COLOR, COMMENT.headingSize, "bold");
    doc.text("Comments", PAGE.margin, y);
    y += COMMENT.headingHeight;
  }
  if (y + (showHeading ? COMMENT.headingHeight : 0) + COMMENT.lineHeight > PAGE.bottom)
    y = nextPage();
  heading();
  for (const lines of comments) {
    for (const line of lines) {
      if (y + COMMENT.lineHeight > PAGE.bottom) {
        y = nextPage();
        heading();
      }
      setText(doc, COMMENT_COLOR, COMMENT.size, "bold");
      doc.text(line, PAGE.margin, y);
      y += COMMENT.lineHeight;
    }
    y += COMMENT.gap;
  }
}

function drawGeneralComments(doc, state, project) {
  const comments = prepareRecordComments(doc, commentsFor("walkdown:general", state));
  if (!comments.length) return;
  function nextPage() {
    const y = newPage(doc, project, "Walkdown comments");
    setText(doc, COLOR.ink, 18, "bold");
    doc.text("Walkdown comments", PAGE.margin, y);
    return y + 26;
  }
  drawRecordComments(doc, comments, nextPage(), nextPage, false);
}

function drawRecordDetails(doc, entry, state, project) {
  const y = newPage(doc, project, entry.label);
  setText(doc, COLOR.ink, 18, "bold");
  doc.text(printableText(entry.label), PAGE.margin, y);
  const quality = qualityFor(entry.key, state);
  if (quality !== "Unrated") {
    setText(doc, qualityColor(quality), 28, "bold");
    doc.text(quality, PAGE.width - PAGE.margin, y, { align: "right" });
  }
  doc.setDrawColor(...COLOR.line);
  doc.line(PAGE.margin, y + 17, PAGE.width - PAGE.margin, y + 17);
  return y + 35;
}

async function prepareRecordPhotos(
  doc,
  photos,
  backend,
  onProgress,
  completed,
  totalPhotos,
) {
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
    prepared.push({ data, properties });
  }
  return prepared;
}

function recordPhotoGrid(photos) {
  const columns = photos.length === 4 ? 2 : Math.min(3, photos.length);
  const rows = Math.ceil(photos.length / columns);
  const gap = 12;
  return {
    cells: photos, columns, rows, gap,
    width: (PAGE.width - PAGE.margin * 2 - (columns - 1) * gap) / columns,
    minHeight: rows * 110 + (rows - 1) * gap,
  };
}

function drawRecordPhotoGrid(doc, grid, top, height) {
  const { cells, columns, rows, gap, width } = grid;
  const rowHeight = (height - (rows - 1) * gap) / rows;
  cells.forEach(({ data, properties }, index) => {
    const x = PAGE.margin + (index % columns) * (width + gap);
    const y = top + Math.floor(index / columns) * (rowHeight + gap);
    const fitted = fitImageInBox(properties.width, properties.height, width, rowHeight);
    doc.addImage(
      data, properties.fileType,
      x + (width - fitted.width) / 2,
      y + (rowHeight - fitted.height) / 2,
      fitted.width, fitted.height,
    );
  });
}

async function drawRecord(
  doc, entry, state, project, backend, onProgress, completed, totalPhotos,
) {
  let y = drawRecordDetails(doc, entry, state, project);
  const nextPage = () => drawRecordDetails(doc, entry, state, project);
  const comments = prepareRecordComments(doc, commentsFor(entry.key, state));
  const commentsHeight = comments.length
    ? COMMENT.headingHeight + comments.reduce(
        (height, lines) => height + lines.length * COMMENT.lineHeight + COMMENT.gap, 0,
      )
    : 0;
  const photos = photosFor(entry.key, state);
  for (let offset = 0; offset < photos.length; offset += 6) {
    const prepared = await prepareRecordPhotos(
      doc, photos.slice(offset, offset + 6), backend,
      onProgress, completed + offset, totalPhotos,
    );
    const grid = recordPhotoGrid(prepared);
    const available = PAGE.bottom - y;
    const lastPhotos = offset + prepared.length === photos.length;
    // Long records continue at readable sizes without cropping or omitting evidence.
    const reserve = lastPhotos && commentsHeight
      ? Math.max(0, Math.min(commentsHeight, available - grid.minHeight - 16))
      : 0;
    const gridHeight = available - reserve - (reserve > 0 ? 16 : 0);
    drawRecordPhotoGrid(doc, grid, y, gridHeight);
    y += gridHeight + 16;
    if (!lastPhotos) y = nextPage();
  }
  drawRecordComments(doc, comments, y, nextPage);
  return photos.length;
}

/** The approved date belongs to the stored revision, never to the export time. */
export function approvedReportDate(state) {
  const project = state?.project;
  if (project?.status !== "closed" || !Number.isSafeInteger(project.revision) || project.revision < 1)
    throw new Error("Approve and close this revision before exporting the QC report.");
  const value = project.closedAt;
  const closedAt = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? new Date(value) : null;
  if (!closedAt || !Number.isFinite(closedAt.getTime()))
    throw new Error("The revision approval date is invalid. Reload the closed revision before exporting.");
  return closedAt;
}

function reportEntries(state, schedule) {
  if (Object.hasOwn(state, "catalog")) {
    if (!Array.isArray(state.catalog) || !state.catalog.length)
      throw new Error("The closed revision's inspection catalog is incomplete. Reload the revision before exporting.");
    const keys = new Set();
    const labels = new Set();
    return state.catalog.map((item) => {
      if (!item || typeof item.key !== "string" || !item.key.trim()
        || typeof item.label !== "string" || !item.label.trim()
        || keys.has(item.key.trim()) || labels.has(item.label.trim())) {
        throw new Error("The closed revision's inspection catalog contains missing or duplicate items. Reload the revision before exporting.");
      }
      keys.add(item.key.trim());
      labels.add(item.label.trim());
      return { key: item.key.trim(), label: item.label.trim() };
    });
  }
  if (!schedule?.project || !Array.isArray(schedule.groups) || !Array.isArray(schedule.devices))
    throw new Error("The inspection schedule is incomplete.");
  return inspectionTargets(schedule).map((target) => ({ key: target.key, label: target.name }));
}

/** Builds an approved inspection snapshot. The caller handles download or sharing. */
export async function createInspectionPdf({
  schedule,
  state,
  backend,
  onProgress = () => {},
}) {
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
    throw new Error("Name this skid before exporting its QC report.");
  }
  const closedAt = approvedReportDate(state);
  const entries = reportEntries(state, schedule);
  const validKeys = new Set(entries.map((entry) => entry.key));
  const orphan =
    state.records.find((item) => !validKeys.has(item.key)) ||
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
    revision: revisionNumber(state.project),
    skidName: state.project.skidName.trim().replace(/\s+/g, " "),
  };
  const totalPhotos = state.photos.length;
  onProgress("Loading report assets…");
  const baseUrl = import.meta.env?.BASE_URL || "/";
  const [layout, logo, regularFont, boldFont] = await Promise.all([
    fetchImage(`${baseUrl}assets/conduit-layout.png`, "the conduit layout"),
    loadReportLogo(),
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
  // A UTC PDF date remains stable even when two inspectors export in different zones.
  const pdfDate = `D:${closedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14)}+00'00'`;
  doc.setCreationDate(pdfDate);
  doc.setProperties({
    title: `${COVER_TITLE} - QC Report - ${project.skidName}`,
    subject: `Revision ${project.revision} inspection evidence for ${project.skidName}`,
    author: "Jeevy Fabrication",
    creator: "Jeevy DCS QC Report",
  });
  drawCover(doc, project, closedAt, logo);
  drawOverview(doc, project, layout);
  drawGeneralComments(doc, state, project);
  drawSummary(doc, entries, state, project);
  let completed = 0;
  for (const entry of entries) {
    if (recordStatus(entry.key, state) === "not-started") continue;
    completed += await drawRecord(
      doc, entry, state, project, backend, onProgress, completed, totalPhotos,
    );
  }
  if (completed !== totalPhotos) {
    throw new Error(
      `${totalPhotos - completed} evidence photo(s) are not assigned to scheduled targets. Refresh the inspection and try again.`,
    );
  }
  drawFooters(doc, project, closedAt);
  onProgress("Report ready");
  return doc.output("blob");
}
