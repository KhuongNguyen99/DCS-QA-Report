import { jsPDF } from "jspdf";
import { approvedReportDate, fitImageInBox, printableText } from "./report.js";
import { buildTestChart, formatSourceTime } from "./test-chart.js";
import { importNoteClarification } from "./proneta-notes.js";

const PAGE = { width: 792, height: 612, margin: 43.2, bottom: 548 };
const WIDTH = PAGE.width - PAGE.margin * 2;
const COLOR = {
  ink: [30, 43, 54], muted: [83, 101, 116], line: [213, 222, 229],
  fill: [242, 246, 248], blue: [24, 108, 161], green: [31, 105, 57], red: [170, 49, 43],
};
const RESULT_LABELS = new Set(["Passed", "Failed", "Not tested", "Not applicable"]);
const MAX_SETUP_PHOTO_BYTES = 12 * 1024 * 1024;
const SETUP_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

function resultLabel(value) {
  return RESULT_LABELS.has(value) ? value : "Not tested";
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
    ? "UTC (normalized from source timestamps; original event timestamps retain their offsets)"
    : clock?.timeZone || "Source clock (unspecified)";
}

function selectedValue(parameter) {
  let value = String(parameter.value ?? parameter.rawValue ?? "");
  if (parameter.enumId && value === String(parameter.rawValue) && /^[-+]?\d+(?:\.\d+)?$/.test(value))
    value += " (encoded selection)";
  if (parameter.unit && !value.includes(parameter.unit)) value += ` ${parameter.unit}`;
  return value || "Not specified";
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
function reportWriter(doc) {
  let y = 54;
  let sectionTitle = "I/O test report";
  function header() {
    textStyle(doc, 7.9, false, COLOR.muted);
    doc.text("Jeevy Fabrication", PAGE.margin, 16);
    doc.text("I/O test report", PAGE.width - PAGE.margin, 16, { align: "right" });
  }
  function page(title = sectionTitle, first = false, continuation = false) {
    if (!first) doc.addPage();
    sectionTitle = title;
    header();
    y = 55;
    textStyle(doc, first ? 27 : 20, true);
    const lines = doc.splitTextToSize(printableText(`${title}${continuation ? " (continued)" : ""}`), WIDTH);
    for (const line of lines) {
      doc.text(line, PAGE.margin, y);
      y += first ? 34 : 26;
    }
    y += 8;
  }
  function ensure(height) {
    if (y + height > PAGE.bottom) page(sectionTitle, false, true);
  }
  function paragraph(value, { size = 9, bold = false, color = COLOR.ink, gap = 7, lineHeight = size * 1.45 } = {}) {
    textStyle(doc, size, bold, color);
    const lines = printableText(value).split("\n").flatMap((line) => doc.splitTextToSize(line || " ", WIDTH));
    for (const line of lines) {
      ensure(lineHeight);
      textStyle(doc, size, bold, color);
      doc.text(line, PAGE.margin, y + size);
      y += lineHeight;
    }
    y += gap;
  }
  function heading(value, size = 12) {
    ensure(size * 1.5 + 28);
    paragraph(value, { size, bold: true, gap: 7 });
  }
  function table(columns, rows, { compact = false } = {}) {
    if (!rows.length) return;
    const size = 8.2;
    const lineHeight = 11.3;
    const padding = compact ? 3 : 6;
    const widths = columns.map((column) => column.width);
    const cellLines = (value, column) => {
      textStyle(doc, size);
      return printableText(value).split("\n")
        .flatMap((line) => doc.splitTextToSize(line || " ", widths[column] - padding * 2));
    };
    textStyle(doc, size, true);
    const headers = columns.map((column) => doc.splitTextToSize(printableText(column.label), column.width - padding * 2));
    const headerHeight = Math.max(...headers.map((lines) => lines.length)) * lineHeight + padding * 2;
    function tableHeader() {
      ensure(headerHeight + lineHeight + padding * 2);
      doc.setFillColor(...COLOR.fill);
      doc.rect(PAGE.margin, y, WIDTH, headerHeight, "F");
      textStyle(doc, size, true, COLOR.muted);
      let x = PAGE.margin;
      headers.forEach((lines, index) => {
        lines.forEach((line, row) => doc.text(line, x + padding, y + padding + size + row * lineHeight));
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
      if (y + rowHeight > PAGE.bottom && rowHeight < PAGE.bottom - 125 - headerHeight) {
        page(sectionTitle, false, true);
        tableHeader();
      }
      let offset = 0;
      while (offset < totalLines) {
        const available = Math.floor((PAGE.bottom - y - padding * 2) / lineHeight);
        if (available < 1) {
          page(sectionTitle, false, true);
          tableHeader();
          continue;
        }
        const count = Math.min(totalLines - offset, available);
        let x = PAGE.margin;
        cells.forEach((lines, index) => {
          textStyle(doc, size, false, row[index] === "Passed" ? COLOR.green : row[index] === "Failed" ? COLOR.red : COLOR.ink);
          lines.slice(offset, offset + count).forEach((line, lineIndex) =>
            doc.text(line, x + padding, y + padding + size + lineIndex * lineHeight));
          x += widths[index];
        });
        y += count * lineHeight + padding * 2;
        doc.setDrawColor(...COLOR.line);
        doc.setLineWidth(0.4);
        doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
        offset += count;
        if (offset < totalLines) {
          page(sectionTitle, false, true);
          tableHeader();
        }
      }
    }
    y += 12;
  }
  function chart(series, clock) {
    const geometry = buildTestChart(series, clock, {
      width: WIDTH, height: 201, padding: { left: 57, right: 25, top: 20, bottom: 45 },
    });
    const title = `${series.name || "Recorded values"} - ${geometry.unit}`;
    const observationNote = `${geometry.observedCount} observed change(s)${geometry.invalidCount ? `; ${geometry.invalidCount} invalid reading(s), marked below the plot when dated` : ""}. ${series.kind === "digital" ? "Steps" : "Lines"} connect recorded changes; dashed tail holds the last value to the run end.`;
    const rangeNote = `Shared run span: ${rangeLabel(clock)}. ${clockLabel(clock)}.`;
    const heightFor = (value, size, lineHeight, gap) => {
      textStyle(doc, size);
      return doc.splitTextToSize(printableText(value), WIDTH).length * lineHeight + gap;
    };
    ensure(geometry.height + heightFor(title, 10, 14.5, 7)
      + heightFor(observationNote, 7.8, 11, 5) + heightFor(rangeNote, 7.8, 11, 12));
    heading(title, 10);
    const originY = y;
    const { plot, points, invalidPoints, xTicks, yTicks, connections, extension } = geometry;
    doc.setLineWidth(0.35);
    textStyle(doc, 7.5, false, COLOR.muted);
    for (const tick of yTicks) {
      doc.setDrawColor(...COLOR.line);
      doc.line(PAGE.margin + plot.left, originY + tick.y, PAGE.margin + plot.left + plot.width, originY + tick.y);
      doc.text(printableText(tick.label), PAGE.margin + plot.left - 7, originY + tick.y + 2.5, { align: "right" });
    }
    doc.setDrawColor(...COLOR.line);
    for (const tick of xTicks) {
      doc.line(PAGE.margin + tick.x, originY + plot.top, PAGE.margin + tick.x, originY + plot.top + plot.height);
      doc.text(tick.label, PAGE.margin + tick.x, originY + plot.top + plot.height + 19, { align: "center" });
      if (tick.dateLabel) doc.text(tick.dateLabel, PAGE.margin + tick.x, originY + plot.top + plot.height + 29, { align: "center" });
    }
    doc.setDrawColor(...COLOR.blue);
    doc.setLineWidth(1.1);
    doc.setLineDashPattern([], 0);
    for (const { from, to } of connections) {
      doc.line(PAGE.margin + from.x, originY + from.y, PAGE.margin + to.x, originY + to.y);
    }
    if (extension) {
      doc.setLineDashPattern([4, 3], 0);
      doc.line(PAGE.margin + extension.from.x, originY + extension.from.y,
        PAGE.margin + extension.to.x, originY + extension.to.y);
      doc.setLineDashPattern([], 0);
    }
    doc.setFillColor(...COLOR.blue);
    points.forEach((point) => doc.circle(PAGE.margin + point.x, originY + point.y, 1.8, "F"));
    doc.setDrawColor(...COLOR.red);
    doc.setLineWidth(0.8);
    for (const point of invalidPoints.filter((item) => item.x !== null)) {
      const x = PAGE.margin + point.x;
      const markerY = originY + plot.top + plot.height + 6;
      doc.line(x - 1.8, markerY - 1.8, x + 1.8, markerY + 1.8);
      doc.line(x - 1.8, markerY + 1.8, x + 1.8, markerY - 1.8);
    }
    y += geometry.height;
    paragraph(observationNote,
      { size: 7.8, color: COLOR.muted, gap: 5, lineHeight: 11 });
    paragraph(rangeNote,
      { size: 7.8, color: COLOR.muted, gap: 12, lineHeight: 11 });
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
  return { page, paragraph, heading, table, chart, ensure, setupPhoto };
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

function parameterTable(writer, parameters, { heading = true } = {}) {
  if (!parameters?.length) return;
  if (heading) writer.heading("Set parameters", 10);
  // A record/group is common to many settings. Print it once and place two
  // independent parameter/value pairs per row instead of repeating it per cell.
  const groups = new Map();
  for (const parameter of parameters) {
    const label = [parameter.group, parameter.recordIndex == null ? "" : `Record ${parameter.recordIndex}`].filter(Boolean).join(" | ");
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(parameter);
  }
  for (const [label, group] of groups) {
    if (label) writer.heading(label, 8.5);
    const rows = [];
    for (let index = 0; index < group.length; index += 2) {
      const first = group[index];
      const second = group[index + 1];
      rows.push([first.name, selectedValue(first), second?.name || "", second ? selectedValue(second) : ""]);
    }
    writer.table([
      { label: "Parameter", width: 218 }, { label: "Selected value", width: WIDTH / 2 - 218 },
      { label: "Parameter", width: 218 }, { label: "Selected value", width: WIDTH / 2 - 218 },
    ], rows, { compact: true });
  }
}

function channelDetails(writer, channel, run, { heading = true } = {}) {
  if (heading) writer.heading(channel.symbolicName || channelLabel(channel));
  writer.paragraph(`${stationName(run, channel.stationId)} | Slot ${channel.slot ?? "unspecified"} | ${channelLabel(channel)}${channel.role ? ` | ${channel.role}` : ""}`, { color: COLOR.muted });
  const result = resultLabel(channel.status);
  writer.paragraph(`Recorded wiring result: ${result}${channel.rawStatus ? ` (source: ${channel.rawStatus})` : ""}`, {
    bold: true, color: result === "Failed" ? COLOR.red : result === "Passed" ? COLOR.green : COLOR.ink,
  });
  if (channel.comment) writer.paragraph(`Tester comment: ${channel.comment}`);
  parameterTable(writer, channel.parameters);
  if (!channel.series?.some((series) => series.points?.length)) {
    writer.paragraph("No dated observations were imported for this channel.", { color: COLOR.muted });
  }
  for (const series of channel.series || []) {
    if (!series.points?.length) continue;
    writer.chart(series, run.clock);
    const invalid = series.points.filter((point) => point.valid === false || !Number.isFinite(point.value) || !Number.isFinite(point.timeMs)
      || (series.kind === "digital" && point.value !== 0 && point.value !== 1)
      || (point.previousRawValue !== undefined && point.previousRawValue !== "" && point.previousValue === null));
    if (invalid.length) {
      writer.heading(`Invalid or unplottable values - ${series.name || "Recorded values"}`, 10);
      writer.paragraph("Original tokens are retained below. Invalid after-values are excluded from the vertical scale; an invalid previous token does not invalidate a valid recorded after-value.", { size: 8, color: COLOR.muted });
      writer.table([
        { label: "Source time", width: 142 },
        { label: "Before / after (original tokens)", width: 220 },
        { label: "Source", width: WIDTH - 362 },
      ], invalid.map((point) => [
        point.time || formatSourceTime(point.timeMs, true),
        `${point.previousRawValue ?? "Not recorded"} -> ${point.rawValue ?? "Not recorded"}`,
        sourceLabel(run, point),
      ]));
    }
  }
}

function runSummary(writer, run) {
  writer.page(run.name || "Test run");
  writer.paragraph(`Software: ${run.software.name} | Version: ${run.software.version}`, { size: 11, bold: true });
  writer.paragraph(`Run time span: ${rangeLabel(run.clock)}`);
  writer.paragraph(`Clock: ${clockLabel(run.clock)}. All graphs in this run use these same start and end times.`, { color: COLOR.muted });
  writer.paragraph("Recorded wiring results are the tester's entries in PRONETA. Logged values alone do not establish a functional pass.", { color: COLOR.muted });
  writer.table([
    { label: "Device name", width: 300 },
    { label: "Recorded wiring result", width: 160 },
    { label: "Channels", width: 80 },
    { label: "Logged changes", width: WIDTH - 540 },
  ], run.devices.map((device) => [
    device.name, resultLabel(device.status), device.channels.length,
    device.channels.reduce((sum, channel) => sum + (channel.series || []).reduce((count, series) => count + (series.points?.length || 0), 0), 0),
  ]));
  writer.paragraph(`${run.unassignedChannels?.length || 0} channel(s) without an assigned device name are retained in the unassigned-channel appendix.`, { size: 8, color: COLOR.muted });
}

function runAppendices(writer, run) {
  if (run.unassignedChannels?.length) {
    writer.page(`${run.name || "Test run"} - Unassigned channels`);
    writer.paragraph("Channels marked N/A or without a device name remain separate from named-device results.");
    writer.table([
      { label: "Station", width: 135 }, { label: "Slot / channel", width: 130 },
      { label: "Symbolic name", width: 180 }, { label: "Recorded wiring result", width: WIDTH - 445 },
    ], run.unassignedChannels.map((channel) => [stationName(run, channel.stationId),
      `${channel.slot ?? "?"} / ${channelLabel(channel)}`, channel.symbolicName || "Unassigned", resultLabel(channel.status)]));
    for (const channel of run.unassignedChannels) {
      if (channel.series?.some((series) => series.points?.length)) channelDetails(writer, channel, run);
      else if (channel.parameters?.length || channel.comment) {
        writer.heading(`${stationName(run, channel.stationId)} | Slot ${channel.slot ?? "?"} | ${channelLabel(channel)} | ${channel.symbolicName || "Unassigned"}`, 9);
        if (channel.comment) writer.paragraph(`Tester comment: ${channel.comment}`, { size: 8 });
        parameterTable(writer, channel.parameters, { heading: false });
      }
    }
  }
  writer.page(`${run.name || "Test run"} - Stations and module parameters`);
  writer.paragraph("Parameter tables show the selections saved in the imported parameter files. Encoded selections remain labeled when no readable value label was supplied.", { color: COLOR.muted });
  for (const station of run.stations || []) {
    writer.heading(station.name || station.id);
    writer.paragraph([station.macAddress && `MAC: ${station.macAddress}`, station.serialNumber && `Serial: ${station.serialNumber}`].filter(Boolean).join(" | "), { color: COLOR.muted });
    writer.table([
      { label: "Slot", width: 50 }, { label: "Module", width: 295 },
      { label: "Order number", width: 205 }, { label: "Serial number", width: WIDTH - 550 },
    ], (station.modules || []).map((module) => [module.slot, module.name, module.orderNumber || "", module.serialNumber || ""]));
    const parameters = (station.modules || []).flatMap((module) => (module.parameters || []).map((parameter) => ({ ...parameter, slot: module.slot })));
    if (parameters.length) {
      writer.heading(`${station.name || station.id} - Module-wide parameters`, 11);
      writer.table([
        { label: "Slot", width: 40 }, { label: "Parameter", width: 278 },
        { label: "Selected value", width: 184 }, { label: "Group / record", width: WIDTH - 502 },
      ], parameters.map((parameter) => [parameter.slot, parameter.name, selectedValue(parameter),
        [parameter.group, parameter.recordIndex == null ? "" : `Record ${parameter.recordIndex}`].filter(Boolean).join(" | ")]),
      { compact: true });
    }
  }
  writer.page(`${run.name || "Test run"} - Sources and import notes`);
  writer.paragraph("Source fingerprints identify the exact imported file contents. The approved report uses the saved run data from this QC revision.", { color: COLOR.muted });
  writer.table([
    { label: "File / type", width: 210 }, { label: "Station / bytes", width: 160 },
    { label: "SHA-256", width: WIDTH - 370 },
  ], (run.sources || []).map((source) => [
    `${source.name}\n${source.kind}`, `${stationName(run, source.stationId)}\n${source.size ?? "Unknown"} bytes`,
    source.sha256 || "Not recorded",
  ]));
  writer.heading("Import notes");
  const clarification = importNoteClarification(run.warnings);
  if (clarification) writer.paragraph(clarification, { size: 8.5 });
  if (!run.warnings?.length) writer.paragraph("No import warnings recorded.");
  else run.warnings.forEach((warning) => writer.paragraph(warning, { size: 8.5 }));
  if (run.unparsedEvents?.length) {
    writer.heading("Events retained without a parsed value");
    writer.table([
      { label: "Source time / station", width: 155 }, { label: "Description / reason", width: 345 },
      { label: "Source", width: WIDTH - 500 },
    ], run.unparsedEvents.map((event) => [
      `${event.time || "Unknown time"}\n${stationName(run, event.stationId)} | Slot ${event.slot ?? "?"}`,
      `${event.description || ""}\n${event.reason || "No parsed value"}`, sourceLabel(run, event),
    ]));
  }
}

function drawFooters(doc, project, closedAt) {
  const count = doc.getNumberOfPages();
  for (let page = 1; page <= count; page += 1) {
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
export async function createTestReportPdf({ state, runId = null, backend, onProgress = () => {} } = {}) {
  // Capture before the first await, so later UI edits cannot alter an in-flight export.
  const snapshot = structuredClone({ project: state?.project, testRuns: state?.testRuns });
  const closedAt = approvedReportDate(snapshot);
  const project = snapshot.project;
  if (typeof project.skidName !== "string" || !project.skidName.trim())
    throw new Error("Name this skid before exporting its I/O test report.");
  if (!Array.isArray(snapshot.testRuns)) throw new Error("The closed revision's test runs are missing. Reload the revision before exporting.");
  const runs = runId === null ? snapshot.testRuns : snapshot.testRuns.filter((run) => run.id === runId);
  if (!runs.length) throw new Error("No saved test run was found in this closed revision.");
  if (runId !== null && runs.length !== 1) throw new Error("The closed revision contains duplicate test run identifiers.");
  for (const run of runs) {
    if (run.walkdownId && run.walkdownId !== project.walkdownId)
      throw new Error("The test report contains data from another skid.");
    if (typeof run.software?.name !== "string" || !run.software.name.trim()
      || typeof run.software?.version !== "string" || !run.software.version.trim())
      throw new Error("The saved test run is missing its software name or version.");
    if (!Array.isArray(run.devices) || run.devices.some((device) => !device.name || !Array.isArray(device.channels)))
      throw new Error("The saved test run has incomplete device data.");
    validateSetupPhotos(run, project);
    for (const channel of [...run.devices.flatMap((device) => device.channels), ...(run.unassignedChannels || [])])
      for (const series of channel.series || [])
        if (series.points?.length) buildTestChart(series, run.clock);
  }
  if (runs.some((run) => run.setupPhotos?.length)) {
    if (typeof backend?.getPhotoUrl !== "function")
      throw new Error("Connect to the private photo storage before exporting test setup photos.");
    if (backend.walkdownId && backend.walkdownId !== project.walkdownId)
      throw new Error("The photo connection belongs to another skid.");
  }
  onProgress("Loading test report fonts...");
  const [regular, bold] = await Promise.all([reportFont("NotoSans-Regular.ttf"), reportFont("NotoSans-Bold.ttf")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter", compress: true });
  doc.addFileToVFS("NotoSans-Regular.ttf", regular);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", bold);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  doc.setCreationDate(`D:${closedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14)}+00'00'`);
  doc.setProperties({
    title: `I/O test report - ${printableText(project.skidName)} - Revision ${project.revision}`,
    subject: `Approved QC revision ${project.revision}; recorded I/O wiring results and logged observations`,
    author: "Jeevy Fabrication", creator: "Jeevy DCS QC Report",
  });
  const writer = reportWriter(doc);
  writer.page("I/O test report", true);
  writer.paragraph(`QC report - ${project.skidName}`, { size: 21, bold: true, gap: 14 });
  writer.paragraph(`Revision ${project.revision} - Approved and closed`, { size: 13, bold: true });
  writer.paragraph(`Approved: ${dateLabel(closedAt)}${project.closedByName ? ` | By: ${project.closedByName}` : ""}`);
  writer.paragraph(`${runs.length} saved test run(s) included. This export reflects the locked QC revision.`, { color: COLOR.muted, gap: 18 });
  writer.table([
    { label: "Test run", width: 260 }, { label: "Software / version", width: 290 },
    { label: "Named devices", width: WIDTH - 550 },
  ], runs.map((run) => [run.name || "Test run", `${run.software.name}\n${run.software.version}`, run.devices.length]));
  writer.paragraph("Results, parameter selections, and logged changes are grouped by device name. Each run uses one common graph time span. Passed and Failed refer to the tester-recorded wiring result; a plotted value does not create a pass result.", { color: COLOR.muted });
  for (const run of runs) {
    onProgress(`Building ${run.name || "test run"}...`);
    runSummary(writer, run);
    await runSetup(writer, doc, run, backend, onProgress);
    for (const device of run.devices) {
      writer.page(device.name);
      writer.paragraph(`Test run: ${run.name || "Test run"} | Software: ${run.software.name} ${run.software.version}`, { size: 8.5, color: COLOR.muted });
      if (device.channels.length > 1) writer.paragraph(`Recorded wiring result: ${resultLabel(device.status)}`, { bold: true });
      for (const channel of device.channels) channelDetails(writer, channel, run, {
        heading: device.channels.length > 1 || channel.symbolicName !== device.name,
      });
    }
    runAppendices(writer, run);
  }
  drawFooters(doc, project, closedAt);
  onProgress("Test report ready");
  return doc.output("blob");
}
