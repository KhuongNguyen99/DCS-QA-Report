import { jsPDF } from "jspdf";
import { revisionNumber } from "./domain.js";
import { normalizePronetaStatus } from "./proneta-parser.js";
import { approvedReportDate, drawCover, drawReportFooter, fitImageInBox, loadReportLogo, printableText } from "./report.js";
import { buildTestChart, deviceChartTimeRange, formatSourceTime, isTestTimeRange, isDigitalOutputChannel } from "./test-chart.js";
import { isGraphOrder, orderDeviceGraphs } from "./test-graph-order.js";
import { testCommentBlocks } from "./test-comment-format.js";
import { summarizeTestSettings } from "./test-settings-summary.js";

const PAGE = { width: 792, height: 612, margin: 43.2, bottom: 548 };
const WIDTH = PAGE.width - PAGE.margin * 2;
const COLOR = {
  ink: [30, 43, 54], muted: [83, 101, 116], line: [213, 222, 229],
  fill: [242, 246, 248], blue: [24, 108, 161], green: [31, 105, 57], red: [170, 49, 43],
};
const RESULT_LABELS = new Set(["Passed", "Failed", "Not tested", "Not applicable"]);
const MAX_SETUP_PHOTO_BYTES = 12 * 1024 * 1024;
const SETUP_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_COMMENT_LENGTH = 4000;

function validateReportComment(value, label) {
  if (value !== undefined && (typeof value !== "string" || Array.from(value).length > MAX_COMMENT_LENGTH || value.includes("\0")))
    throw new Error(`The saved ${label} must be text of at most 4,000 characters without NUL characters. Reload the approved revision.`);
}

function reportComment(writer, label, value) {
  if (!value?.trim()) return;
  writer.heading(label, 10, COLOR.blue);
  const blocks = testCommentBlocks(value);
  for (const { kind, lines } of blocks) {
    if (kind === "diagnostics") writer.diagnostics(lines);
    else {
      const text = blocks.length === 1 ? value : lines.join("\n").trim();
      if (text) writer.paragraph(text, { color: COLOR.blue });
    }
  }
}

function isRunDeviceMap(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateSetupPhotos(run, project) {
  if (run.setupPhotos === undefined) return;
  if (!Array.isArray(run.setupPhotos) || run.setupPhotos.length > 30)
    throw new Error("The saved test setup photo list is invalid. Reload the approved revision.");
  const ids = new Set();
  for (const photo of run.setupPhotos) {
    if (!photo || typeof photo !== "object" || Array.isArray(photo)
      || typeof photo.id !== "string" || !photo.id.trim() || ids.has(photo.id)
      || typeof photo.name !== "string" || !photo.name.trim() || photo.name.length > 255
      || typeof photo.path !== "string" || !photo.path.trim() || photo.path.length > 2048
      || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(photo.path)
      || photo.path.includes("\\") || photo.path.split("/").some((part) => part === ".." || part === ".")
      || ![photo.width, photo.height].every((value) => Number.isInteger(value) && value > 0 && value <= 24000)
      || typeof photo.caption !== "string" || photo.caption.length > 1000)
      throw new Error("A saved setup photo has invalid metadata. Reload the approved revision.");
    if (photo.walkdownId !== project.walkdownId)
      throw new Error("The test setup contains a photo from another skid.");
    if (photo.testRunId !== run.id)
      throw new Error("The test setup contains a photo from another test run.");
    ids.add(photo.id);
  }
}

async function setupImageData(photo, backend) {
  const name = printableText(photo.name);
  let url;
  try { url = await backend.getPhotoUrl(photo); }
  catch (error) {
    throw new Error(`Could not access setup photo "${name}": ${error.message || String(error)}`, { cause: error });
  }
  if (typeof url !== "string" || !url.trim())
    throw new Error(`Could not access setup photo "${name}". Reload the report and try again.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}. Reload the report and try again.`);
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!SETUP_IMAGE_TYPES.has(type)) throw new Error("The file must be a JPEG, PNG, or WebP image.");
    if (Number(response.headers.get("content-length")) > MAX_SETUP_PHOTO_BYTES)
      throw new Error("The image exceeds the 12 MB limit.");
    const reader = response.body?.getReader();
    let bytes;
    if (reader) {
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_SETUP_PHOTO_BYTES) {
            await reader.cancel();
            throw new Error("The image exceeds the 12 MB limit.");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } else bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("The image is empty.");
    if (bytes.length > MAX_SETUP_PHOTO_BYTES) throw new Error("The image exceeds the 12 MB limit.");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:${type};base64,${btoa(binary)}`;
  } catch (error) {
    const detail = controller.signal.aborted ? "The image download timed out. Try exporting again." : error.message || String(error);
    throw new Error(`Could not load setup photo "${name}": ${detail}`, { cause: error });
  } finally { clearTimeout(timeout); controller.abort(); }
}

function textStyle(doc, size = 10, bold = false, color = COLOR.ink) {
  doc.setFont("NotoSans", bold ? "bold" : "normal");
  doc.setFontSize(size);
  doc.setTextColor(...color);
}

function paragraphLines(doc, value, width = WIDTH) {
  return printableText(value).split("\n").flatMap(line => doc.splitTextToSize(line || " ", width));
}

function isNotApplicable(value) {
  return normalizePronetaStatus(value) === "Not applicable";
}

function applicableChannel({ symbolicName, status, rawStatus }) {
  return ![symbolicName, status, rawStatus].some(isNotApplicable);
}

function resultLabel(value) {
  return RESULT_LABELS.has(value) ? value : "Not tested";
}

function resultColor(value) {
  return value === "Passed" ? COLOR.green : value === "Failed" ? COLOR.red : COLOR.ink;
}

function stationName(run, id) {
  return run.stations?.find((station) => station.id === id)?.name || id || "Unknown station";
}

function channelLabel(channel) {
  const value = channel.sourceChannel ?? channel.channel;
  if (value === undefined || value === null || value === "") return "Channel unspecified";
  return /^channel\b/i.test(String(value)) ? String(value) : `Channel ${value}`;
}

function sourceLabel(run, point) {
  const source = run.sources?.find((item) => item.id === point.sourceId);
  return `${source?.name || point.sourceId || "Unknown source"}${point.sourceRow ? `, row ${point.sourceRow}` : ""}`;
}

function dateLabel(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function rangeLabel(clock) {
  if (!Number.isFinite(clock?.startMs) || !Number.isFinite(clock?.endMs)) return "No dated event log imported";
  return `${formatSourceTime(clock.startMs, true)} to ${formatSourceTime(clock.endMs, true)}`;
}

function clockLabel(clock) {
  return clock?.basis === "absolute"
    ? "UTC"
    : clock?.timeZone || "Source clock (unspecified)";
}

async function reportFont(file) {
  const baseUrl = import.meta.env?.BASE_URL || "/";
  let response;
  try { response = await fetch(`${baseUrl}assets/${file}`); }
  catch (error) { throw new Error(`Could not load the report font: ${error.message || String(error)}`, { cause: error }); }
  if (!response.ok) throw new Error("Could not load the report font. Refresh the app and try again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("The report font is empty.");
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}

/** A paginated writer: table rows and long notes may continue onto new pages. */
function reportWriter(doc, y) {
  let sectionTitle = "Test run details";
  let figureNumber = 0;
  function header() {
    textStyle(doc, 7.9, false, COLOR.muted);
    doc.text("Jeevy Fabrication", PAGE.margin, 16);
    doc.text("I/O test report", PAGE.width - PAGE.margin, 16, { align: "right" });
  }
  function page(title = sectionTitle, continuation = false) {
    doc.addPage("letter", "landscape");
    sectionTitle = title;
    header();
    y = 55;
    textStyle(doc, 20, true);
    const label = continuation ? `${title} (continued)` : title;
    for (const line of doc.splitTextToSize(printableText(label), WIDTH)) {
      doc.text(line, PAGE.margin, y);
      y += 24;
    }
    y += 4;
  }
  function ensure(height) {
    if (y + height > PAGE.bottom) page(sectionTitle, true);
  }
  function paragraph(value, { size = 9, bold = false, color = COLOR.ink, gap = 7, lineHeight = size * 1.45,
    left = PAGE.margin, width = WIDTH } = {}) {
    textStyle(doc, size, bold, color);
    const lines = paragraphLines(doc, value, width);
    for (const line of lines) {
      ensure(lineHeight);
      textStyle(doc, size, bold, color);
      doc.text(line, left, y + size);
      y += lineHeight;
    }
    y += gap;
  }
  function heading(value, size = 12, color = COLOR.ink) {
    ensure(size * 1.5 + 28);
    paragraph(value, { size, bold: true, color, gap: 7 });
  }
  function diagnostics(labels) {
    const size = 9, lineHeight = 13, left = PAGE.margin + 14, gap = 7;
    textStyle(doc, size, true, COLOR.green);
    const labelWidth = WIDTH - (left - PAGE.margin) - gap - doc.getTextWidth("Passed");
    for (const label of labels) {
      textStyle(doc, size, false, COLOR.blue);
      const lines = paragraphLines(doc, label, labelWidth);
      for (const [index, line] of lines.entries()) {
        ensure(lineHeight);
        textStyle(doc, size, false, COLOR.blue);
        if (index === 0) doc.text("•", PAGE.margin + 4, y + size);
        doc.text(line, left, y + size);
        if (index === lines.length - 1) {
          const statusLeft = left + doc.getTextWidth(line) + gap;
          textStyle(doc, size, true, COLOR.green);
          doc.text("Passed", statusLeft, y + size);
        }
        y += lineHeight;
      }
    }
    y += gap;
  }
  function table(columns, rows, { compact = false, caption = "" } = {}) {
    if (!rows.length) return;
    const size = 8.2;
    const lineHeight = 11.3;
    const padding = compact ? 3 : 6;
    const widths = columns.map((column) => column.width);
    const textX = (x, index) => x + (columns[index].align === "center" ? widths[index] / 2 : padding);
    const cellLines = (value, column) => {
      textStyle(doc, size);
      return printableText(value).split("\n")
        .flatMap((line) => doc.splitTextToSize(line || " ", widths[column] - padding * 2));
    };
    textStyle(doc, size, true);
    const headers = columns.map((column) => doc.splitTextToSize(printableText(column.label), column.width - padding * 2));
    const headerHeight = Math.max(...headers.map((lines) => lines.length)) * lineHeight + padding * 2;
    textStyle(doc, 9.5, true);
    const captionLines = caption ? doc.splitTextToSize(printableText(caption), WIDTH) : [];
    const captionHeight = captionLines.length ? captionLines.length * 13 + 3 : 0;
    function tableHeader() {
      ensure(captionHeight + headerHeight + lineHeight + padding * 2);
      if (captionLines.length) {
        textStyle(doc, 9.5, true);
        captionLines.forEach((line, index) => doc.text(line, PAGE.margin, y + 9.5 + index * 13));
        y += captionHeight;
      }
      doc.setFillColor(...COLOR.fill);
      doc.rect(PAGE.margin, y, WIDTH, headerHeight, "F");
      textStyle(doc, size, true, COLOR.muted);
      let x = PAGE.margin;
      headers.forEach((lines, index) => {
        lines.forEach((line, row) => doc.text(line, textX(x, index), y + padding + size + row * lineHeight, { align: columns[index].align || "left" }));
        x += widths[index];
      });
      y += headerHeight;
    }
    tableHeader();
    for (const row of rows) {
      const cells = row.map(cellLines);
      const totalLines = Math.max(1, ...cells.map((lines) => lines.length));
      const rowHeight = totalLines * lineHeight + padding * 2;
      // Move a normal row together. Oversized cells are split without losing text.
      if (y + rowHeight > PAGE.bottom && rowHeight < PAGE.bottom - 125 - headerHeight - captionHeight) {
        page(sectionTitle, true);
        tableHeader();
      }
      let offset = 0;
      while (offset < totalLines) {
        const available = Math.floor((PAGE.bottom - y - padding * 2) / lineHeight);
        if (available < 1) {
          page(sectionTitle, true);
          tableHeader();
          continue;
        }
        const count = Math.min(totalLines - offset, available);
        let x = PAGE.margin;
        cells.forEach((lines, index) => {
          textStyle(doc, size, false, resultColor(row[index]));
          lines.slice(offset, offset + count).forEach((line, lineIndex) =>
            doc.text(line, textX(x, index), y + padding + size + lineIndex * lineHeight, { align: columns[index].align || "left" }));
          x += widths[index];
        });
        y += count * lineHeight + padding * 2;
        doc.setDrawColor(...COLOR.line);
        doc.setLineWidth(0.4);
        doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
        offset += count;
        if (offset < totalLines) {
          page(sectionTitle, true);
          tableHeader();
        }
      }
    }
    y += 12;
  }
  function prepareChart({ series, description, location, showInitialState }, clock, timeRange, deviceTimeRange, width, title) {
    const compact = width < WIDTH;
    const geometry = buildTestChart(series, clock, {
      width, height: compact ? 91 : 201,
      padding: compact ? { left: 49, right: 24, top: 8, bottom: 31 } : { left: 57, right: 25, top: 20, bottom: 45 },
      tickCount: width < 250 ? 3 : compact ? 4 : 5,
      timeRange, deviceTimeRange, showInitialState,
    });
    const initial = geometry.initialLabel ? ` | ${geometry.initialLabel}` : "";
    const legend = `Figure ${++figureNumber}. ${description}.${compact ? "\n" : " "}${location}${initial}`;
    const titleStyle = { size: 10, bold: true, gap: 3, lineHeight: 14.5 };
    const legendStyle = { size: 8, color: COLOR.muted, gap: 10, lineHeight: 11 };
    const heightFor = (value, style) => {
      textStyle(doc, style.size, style.bold);
      return paragraphLines(doc, value, width).length * style.lineHeight + style.gap;
    };
    const height = (title ? heightFor(title, titleStyle) : 0) + geometry.height + heightFor(legend, legendStyle);
    return { height, draw(left) {
      if (title) paragraph(title, { ...titleStyle, left, width });
      drawChart(doc, geometry, left, y, compact);
      y += geometry.height;
      paragraph(legend, { ...legendStyle, left, width });
    } };
  }
  function chartGrid(charts, clock, timeRange, deviceTimeRange) {
    const columns = charts.length === 3 || charts.length >= 5 ? 3 : charts.length >= 2 ? 2 : 1;
    const gap = 18;
    const width = (WIDTH - gap * (columns - 1)) / columns;
    for (let start = 0; start < charts.length; start += columns) {
      const row = charts.slice(start, start + columns)
        .map(chart => {
          const name = chart.series.name;
          const title = charts.length > 1 || name !== sectionTitle ? name : "";
          return prepareChart(chart, clock, timeRange, deviceTimeRange, width, title);
        });
      ensure(Math.max(...row.map(chart => chart.height)));
      const top = y;
      let rowBottom = y;
      row.forEach((chart, column) => {
        y = top;
        chart.draw(PAGE.margin + column * (width + gap));
        rowBottom = Math.max(rowBottom, y);
      });
      y = rowBottom;
    }
  }
  function drawChart(doc, geometry, left, originY, compact) {
    const { plot, points, invalidPoints, xTicks, yTicks, connections, extension, leading } = geometry;
    const unit = printableText(geometry.unit).replace(/^deg([CF])$/, "\u00b0$1");
    textStyle(doc, compact ? 7.5 : 8.5, true, COLOR.muted);
    const axisCenter = originY + plot.top + plot.height / 2;
    doc.text(unit, left + 8, axisCenter + doc.getTextWidth(unit) / 2, { angle: 90 });
    doc.setLineWidth(0.35);
    textStyle(doc, compact ? 7 : 7.5, false, COLOR.muted);
    for (const tick of yTicks) {
      doc.setDrawColor(...COLOR.line);
      doc.line(left + plot.left, originY + tick.y, left + plot.left + plot.width, originY + tick.y);
      doc.text(printableText(tick.label), left + plot.left - 7, originY + tick.y + 2.5, { align: "right" });
    }
    doc.setDrawColor(...COLOR.line);
    for (const tick of xTicks) {
      doc.line(left + tick.x, originY + plot.top, left + tick.x, originY + plot.top + plot.height);
      doc.text(tick.label, left + tick.x, originY + plot.top + plot.height + (compact ? 15 : 19), { align: "center" });
      if (tick.dateLabel) doc.text(tick.dateLabel, left + tick.x, originY + plot.top + plot.height + (compact ? 24 : 29), { align: "center" });
    }
    doc.setDrawColor(...COLOR.blue);
    doc.setLineWidth(1.1);
    doc.setLineDashPattern([], 0);
    for (const { from, to } of connections) {
      doc.line(left + from.x, originY + from.y, left + to.x, originY + to.y);
    }
    doc.setLineDashPattern([4, 3], 0);
    for (const { from, to } of [leading, extension].filter(Boolean)) {
      doc.line(left + from.x, originY + from.y, left + to.x, originY + to.y);
    }
    doc.setLineDashPattern([], 0);
    doc.setFillColor(...COLOR.blue);
    points.forEach((point) => doc.circle(left + point.x, originY + point.y, compact ? 1.4 : 1.8, "F"));
    doc.setDrawColor(...COLOR.red);
    doc.setLineWidth(0.8);
    for (const point of invalidPoints.filter((item) => item.x !== null)) {
      const x = left + point.x;
      const markerY = originY + plot.top + plot.height + 6;
      doc.line(x - 1.8, markerY - 1.8, x + 1.8, markerY + 1.8);
      doc.line(x - 1.8, markerY + 1.8, x + 1.8, markerY - 1.8);
    }
  }
  function setupPhoto(run, photo, data, properties, index, total) {
    page(`${run.name || "Test run"} - Setup`);
    paragraph(`Photo ${index + 1} of ${total} | ${photo.name}`, { size: 9, color: COLOR.muted });
    const caption = photo.caption.trim();
    textStyle(doc, 9);
    const captionHeight = caption ? printableText(caption).split("\n")
      .flatMap((line) => doc.splitTextToSize(line || " ", WIDTH)).length * 13.05 + 7 : 0;
    const boxHeight = Math.min(360, PAGE.bottom - y - Math.min(captionHeight, 78) - 12);
    const fitted = fitImageInBox(properties.width, properties.height, WIDTH, boxHeight);
    doc.addImage(data, properties.fileType,
      PAGE.margin + (WIDTH - fitted.width) / 2, y + (boxHeight - fitted.height) / 2,
      fitted.width, fitted.height);
    y += boxHeight + 12;
    if (caption) paragraph(caption, { size: 9 });
  }
  return { page, paragraph, heading, table, chartGrid, setupPhoto, diagnostics };
}

async function runSetup(writer, doc, run, backend, onProgress) {
  const photos = run.setupPhotos || [];
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    onProgress(`Adding setup photo ${index + 1} of ${photos.length} for ${run.name || "test run"}...`);
    const data = await setupImageData(photo, backend);
    let properties;
    try {
      properties = doc.getImageProperties(data);
      if (properties.width !== photo.width || properties.height !== photo.height)
        throw new Error("The image dimensions differ from the saved setup photo.");
    } catch (error) {
      throw new Error(`Setup photo "${printableText(photo.name)}" could not be decoded for the PDF: ${error.message || String(error)}`, { cause: error });
    }
    writer.setupPhoto(run, photo, data, properties, index, photos.length);
  }
}

function configuredSettings(writer, run, showRunName) {
  const { rows, differences, guide } = summarizeTestSettings(run);
  if (!rows.length) return;
  writer.page("Configured settings");
  if (showRunName) writer.paragraph(run.name || "Test run", { bold: true });
  writer.table([
    { label: "Function", width: 106 }, { label: "Location", width: 128 },
    { label: "Channels in use", width: 72, align: "center" }, { label: "Signal", width: 173 },
    { label: "Shared diagnostics", width: WIDTH - 479 },
  ], rows, { compact: guide.length > 0 });
  writer.table([
    { label: "Location", width: 254 }, { label: "Setting", width: 158 }, { label: "Selected value", width: WIDTH - 412 },
  ], differences, { caption: "Settings that differ", compact: guide.length > 0 });
  if (!guide.length) return;
  const twoColumns = guide.length > 4;
  const midpoint = twoColumns ? Math.ceil(guide.length / 2) : guide.length;
  const columns = [
    { label: "Diagnostic", width: 86 }, { label: "Purpose", width: WIDTH / (twoColumns ? 2 : 1) - 86 },
  ];
  const guideRows = twoColumns
    ? guide.slice(0, midpoint).map((entry, index) => [...entry, ...(guide[index + midpoint] || ["", ""])])
    : guide;
  writer.table(twoColumns ? [...columns, ...columns] : columns, guideRows, { caption: "What the diagnostics detect", compact: true });
}

function figureDescription(series, channel, deviceName) {
  const unit = String(series.unit ?? "").replace(/\s/g, "").toLowerCase();
  let measurement = "Recorded signal";
  if (series.kind === "digital") measurement = "Recorded state";
  else if (["a", "ma", "\u00b5a", "ua"].includes(unit)) measurement = "Measured current";
  else if (["v", "mv"].includes(unit)) measurement = "Measured voltage";
  else if (["\u00b0c", "\u00b0f", "degc", "degf", "k"].includes(unit)) measurement = "Measured temperature";
  const instruments = { DP: "differential pressure transducer", PD: "pressure transducer", POS: "positioner" };
  for (const name of [channel.symbolicName, series.name, deviceName]) {
    const tag = String(name ?? "").trim().toUpperCase();
    const match = /^(DP|PD|TH|POS)(?:[-_]|$)|[-_](POS)(?:#\d+)?$/.exec(tag);
    if (!match) continue;
    const code = match[1] || match[2];
    if (code === "TH") return `${measurement} for thermocouple tag ${tag}`;
    return `${measurement} of ${instruments[code]}`;
  }
  return channel.role ? `${measurement} for the ${channel.role.toLowerCase()}` : measurement;
}

function channelChart(series, channel, run, deviceName) {
  return { series, description: figureDescription(series, channel, deviceName),
    location: `${stationName(run, channel.stationId)} | Slot ${channel.slot ?? "unspecified"} | ${channelLabel(channel)}`,
    showInitialState: isDigitalOutputChannel(channel) };
}

function channelDetails(writer, channel, run, { heading = true, deferCharts = false, deviceName } = {}) {
  const location = `${stationName(run, channel.stationId)} | Slot ${channel.slot ?? "unspecified"} | ${channelLabel(channel)}`;
  const details = channel.role ? `${location} | ${channel.role}` : location;
  const name = channel.symbolicName || channelLabel(channel);
  const result = resultLabel(channel.status);
  const { rawStatus } = channel;
  const source = rawStatus && !/^\s*ok\s*$/i.test(rawStatus) ? ` (source: ${rawStatus})` : "";
  const wiring = `Test Result: ${result}${source}`;
  const color = resultColor(result);
  const populated = (channel.series || []).filter(series => series.points?.length);
  if (deferCharts) {
    const label = heading && name !== deviceName ? name : "";
    const location = !populated.length ? details : heading && !label ? channelLabel(channel) : "";
    writer.paragraph([label, location, wiring].filter(Boolean).join(" | "), { size: 8.5, gap: 4, lineHeight: 11, color });
  } else {
    if (heading) writer.heading(name);
    if (!populated.length) writer.paragraph(details, { color: COLOR.muted });
    writer.paragraph(wiring, { bold: true, color });
  }
  if (channel.comment) writer.paragraph(`Tester comment: ${channel.comment}`);
  if (!deferCharts) for (const series of populated) {
    writer.chartGrid([channelChart(series, channel, run, deviceName)], run.clock);
    seriesAudit(writer, series, run);
  }
}

function seriesAudit(writer, series, run) {
  const invalid = series.points.filter((point) => point.excluded !== true && (point.valid === false || !Number.isFinite(point.value) || !Number.isFinite(point.timeMs)
    || (series.kind === "digital" && point.value !== 0 && point.value !== 1)
    || (point.previousRawValue !== undefined && point.previousRawValue !== "" && point.previousValue === null)));
  if (invalid.length) {
    writer.heading(`Invalid or unplottable values - ${series.name || "Recorded values"}`, 10);
    writer.table([
      { label: "Source time", width: 142 },
      { label: "Before / after (original tokens)", width: 220 },
      { label: "Source", width: WIDTH - 362 },
    ], invalid.map((point) => [
      point.time || formatSourceTime(point.timeMs, true),
      `${point.previousRawValue ?? "Not recorded"} -> ${point.rawValue ?? "Not recorded"}`,
      sourceLabel(run, point),
    ]), { compact: true });
  }
}

function runSummary(writer, run) {
  writer.page(run.name || "Test run");
  reportComment(writer, "Overall test run comment", run.comment);
  writer.table([
    { label: "Device name", width: WIDTH - 378 },
    { label: "Slot", width: 118 },
    { label: "Channels", width: 80 },
    { label: "Test Result", width: 180 },
  ], run.devices.map((device) => [
    device.name,
    [...new Set(device.channels.map((channel) => channel.slot).filter(Number.isInteger))]
      .sort((a, b) => a - b).join(", ") || "Unspecified",
    device.channels.length, resultLabel(device.status),
  ]));
}

function runAppendices(writer, run) {
  if (run.unassignedChannels?.length) {
    writer.page(`${run.name || "Test run"} - Unassigned channels`);
    writer.table([
      { label: "Station", width: 135 }, { label: "Slot / channel", width: 130 },
      { label: "Symbolic name", width: 180 }, { label: "Test Result", width: WIDTH - 445 },
    ], run.unassignedChannels.map((channel) => [stationName(run, channel.stationId),
      `${channel.slot ?? "?"} / ${channelLabel(channel)}`, channel.symbolicName || "Unassigned", resultLabel(channel.status)]));
    for (const channel of run.unassignedChannels) {
      if (channel.series?.some((series) => series.points?.length)) channelDetails(writer, channel, run);
      else if (channel.comment) {
        writer.heading(`${stationName(run, channel.stationId)} | Slot ${channel.slot ?? "?"} | ${channelLabel(channel)} | ${channel.symbolicName || "Unassigned"}`, 9);
        writer.paragraph(`Tester comment: ${channel.comment}`, { size: 8 });
      }
    }
  }
}

function drawFooters(doc, project, closedAt) {
  const count = doc.getNumberOfPages();
  drawReportFooter(doc, project, closedAt, 1, count);
  for (let page = 2; page <= count; page += 1) {
    doc.setPage(page);
    textStyle(doc, 7.5, false, COLOR.muted);
    const label = `Page ${page} of ${count}`;
    const lines = doc.splitTextToSize(printableText(`Revision ${project.revision} | Skid: ${project.skidName}`), WIDTH - doc.getTextWidth(label) - 20);
    if (lines.length > 2) throw new Error("Skid name is too long to fit in the report footer.");
    doc.text(`Approved: ${dateLabel(closedAt)}`, PAGE.margin, 589 - lines.length * 10);
    lines.forEach((line, index) => doc.text(line, PAGE.margin, 599 - (lines.length - index - 1) * 10));
    doc.text(label, PAGE.width - PAGE.margin, 599, { align: "right" });
  }
}

/** Export only the supplied closed QC revision. Never reads newer live run data. */
export async function createTestReportPdf({ state, runId = null, backend, timeRanges = {}, graphOrders = {}, onProgress = () => {} } = {}) {
  // Capture before the first await, so later UI edits cannot alter an in-flight export.
  const snapshot = structuredClone({ project: state?.project, testRuns: state?.testRuns, timeRanges, graphOrders });
  const closedAt = approvedReportDate(snapshot);
  const project = { ...snapshot.project, revision: revisionNumber(snapshot.project) };
  if (typeof project.skidName !== "string" || !project.skidName.trim())
    throw new Error("Name this skid before exporting its I/O test report.");
  if (!Array.isArray(snapshot.testRuns)) throw new Error("The closed revision's test runs are missing. Reload the revision before exporting.");
  const runs = runId === null ? snapshot.testRuns : snapshot.testRuns.filter((run) => run.id === runId);
  if (!runs.length) throw new Error("No saved test run was found in this closed revision.");
  if (runId !== null && runs.length !== 1) throw new Error("The closed revision contains duplicate test run identifiers.");
  if (!isRunDeviceMap(snapshot.timeRanges)) throw new Error("Manual graph time ranges must be grouped by test run and device.");
  if (!isRunDeviceMap(snapshot.graphOrders)) throw new Error("Graph orders must be grouped by test run and device.");
  const deviceRanges = new Map();
  const sourceDevices = new Map();
  const deviceGraphs = new Map();
  for (const run of runs) {
    if (run.walkdownId && run.walkdownId !== project.walkdownId)
      throw new Error("The test report contains data from another skid.");
    if (typeof run.software?.name !== "string" || !run.software.name.trim()
      || typeof run.software?.version !== "string" || !run.software.version.trim())
      throw new Error("The saved test run is missing its software name or version.");
    if (!Array.isArray(run.devices) || run.devices.some((device) => !device.name || !Array.isArray(device.channels)))
      throw new Error("The saved test run has incomplete device data.");
    run.devices = run.devices.flatMap(device => {
      if (isNotApplicable(device.name) || isNotApplicable(device.status)) return [];
      const channels = device.channels.filter(applicableChannel);
      if (!channels.length && device.channels.length) return [];
      const filtered = { ...device, channels };
      sourceDevices.set(filtered, device);
      return [filtered];
    });
    run.unassignedChannels = (run.unassignedChannels || []).filter(applicableChannel);
    validateReportComment(run.comment, "overall test run comment");
    for (const device of run.devices) validateReportComment(device.comment, "device comment");
    validateSetupPhotos(run, project);
    const ranges = Object.hasOwn(snapshot.timeRanges, run.id) ? snapshot.timeRanges[run.id] : {};
    if (!isRunDeviceMap(ranges)) throw new Error("Manual graph time ranges must be grouped by test run and device.");
    const orders = Object.hasOwn(snapshot.graphOrders, run.id) ? snapshot.graphOrders[run.id] : {};
    if (!isRunDeviceMap(orders)) throw new Error("Graph orders must be grouped by test run and device.");
    for (const device of run.devices) {
      const timeRange = Object.hasOwn(ranges, device.id) ? ranges[device.id] : undefined;
      if (Object.hasOwn(ranges, device.id) && !isTestTimeRange(timeRange, run.clock))
        throw new Error(`The manual graph time range for "${device.name}" is invalid. Select a start before the end within this test run.`);
      const deviceTimeRange = deviceChartTimeRange(device, run.clock);
      deviceRanges.set(device, { timeRange, deviceTimeRange });
      const graphOrder = Object.hasOwn(orders, device.id) ? orders[device.id] : undefined;
      if (Object.hasOwn(orders, device.id) && !isGraphOrder(graphOrder))
        throw new Error(`The graph order for "${device.name}" is invalid. Choose a list of graph identifiers.`);
      // Resolve keys against the original snapshot before removing N/A channels.
      // Filtering cannot shift legacy or repeated graph identities.
      deviceGraphs.set(device, orderDeviceGraphs(sourceDevices.get(device), graphOrder)
        .filter(({ channel }) => applicableChannel(channel)));
      for (const channel of device.channels)
        for (const series of channel.series || [])
          if (series.points?.length) buildTestChart(series, run.clock, { timeRange, deviceTimeRange });
    }
    for (const channel of run.unassignedChannels || [])
      for (const series of channel.series || [])
        if (series.points?.length) buildTestChart(series, run.clock);
  }
  if (runs.some((run) => run.setupPhotos?.length)) {
    if (typeof backend?.getPhotoUrl !== "function")
      throw new Error("Connect to the private photo storage before exporting test setup photos.");
    if (backend.walkdownId && backend.walkdownId !== project.walkdownId)
      throw new Error("The photo connection belongs to another skid.");
  }
  onProgress("Loading test report assets...");
  const [regular, bold, logo] = await Promise.all([
    reportFont("NotoSans-Regular.ttf"), reportFont("NotoSans-Bold.ttf"), loadReportLogo(),
  ]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter", compress: true });
  doc.addFileToVFS("NotoSans-Regular.ttf", regular);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", bold);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  doc._reportBoldFont = true;
  doc.setCreationDate(`D:${closedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14)}+00'00'`);
  doc.setProperties({
    title: `I/O test report - ${printableText(project.skidName)} - Revision ${project.revision}`,
    subject: `Approved QC revision ${project.revision}; recorded I/O wiring results and logged observations`,
    author: "Jeevy Fabrication", creator: "Jeevy DCS QC Report",
  });
  const cover = { ...project, skidName: project.skidName.trim().replace(/\s+/g, " ") };
  const coverStyle = { size: 10, lineHeight: 14, gap: 3 };
  const coverDetails = [];
  if (runs.length === 1) {
    const [run] = runs;
    coverDetails.push(
      { text: `Software: ${run.software.name} | Version: ${run.software.version}`, bold: true },
      { text: `Run time span: ${rangeLabel(run.clock)}` },
      { text: `Clock: ${clockLabel(run.clock)}` },
    );
  }
  if (project.closedByName) {
    const approver = [project.closedByName, project.closedByTitle].filter(Boolean).join(", ");
    coverDetails.push({ text: `Approved by: ${approver}` });
  }
  const detailsHeight = coverDetails.reduce((height, { text, bold }) => {
    textStyle(doc, coverStyle.size, bold);
    return height + paragraphLines(doc, text).length * coverStyle.lineHeight + coverStyle.gap;
  }, 0);
  const revisionBottom = 425;
  const detailGap = 20;
  const titleOffset = Math.max(-58, Math.min(0, PAGE.bottom - revisionBottom - detailGap - detailsHeight));
  const revisionY = drawCover(doc, cover, closedAt, logo, "Test Result",
    { revisionBottom: revisionBottom + titleOffset, titleOffset });
  const writer = reportWriter(doc, revisionY + detailGap);
  for (const { text, bold } of coverDetails) writer.paragraph(text, { ...coverStyle, bold });
  if (runs.length > 1) {
    writer.table([
      { label: "Test run", width: 167 }, { label: "Software / version", width: 156 },
      { label: "Run time span", width: 180 }, { label: "Clock", width: WIDTH - 565 },
      { label: "Named devices", width: 62 },
    ], runs.map((run) => [
      run.name || "Test run", `${run.software.name}\n${run.software.version}`,
      rangeLabel(run.clock), clockLabel(run.clock), run.devices.length,
    ]), { compact: true });
  }
  for (const run of runs) {
    onProgress(`Building ${run.name || "test run"}...`);
    configuredSettings(writer, run, runs.length > 1);
    runSummary(writer, run);
    await runSetup(writer, doc, run, backend, onProgress);
    for (const device of run.devices) {
      writer.page(device.name);
      if (device.channels.length > 1) {
        const result = resultLabel(device.status);
        writer.paragraph(`Device Test Result: ${result}`, { bold: true, color: resultColor(result) });
      }
      for (const channel of device.channels) channelDetails(writer, channel, run, {
        heading: device.channels.length > 1 || channel.symbolicName !== device.name,
        deferCharts: true, deviceName: device.name,
      });
      const charts = deviceGraphs.get(device).map(({ series, channel }) => channelChart(series, channel, run, device.name));
      const { timeRange, deviceTimeRange } = deviceRanges.get(device);
      writer.chartGrid(charts, run.clock, timeRange, deviceTimeRange);
      reportComment(writer, "Device comment", device.comment);
      for (const { series } of charts) seriesAudit(writer, series, run);
    }
    runAppendices(writer, run);
  }
  drawFooters(doc, project, closedAt);
  onProgress("Test report ready");
  return doc.output("blob");
}
