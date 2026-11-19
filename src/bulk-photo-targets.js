import { findManualDevices, matchDeviceLabels } from "./domain.js";

const DASHES = /[‐‑‒–—―−﹣－]/g;

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").replace(DASHES, "-");
}

function compact(value) {
  return normalizedText(value).toUpperCase().replace(/[\s-]/g, "");
}

/** Resolve deliberately entered names only; search/OCR guesses need selection. */
export function resolveBulkTarget(query, targets) {
  const name = compact(query);
  if (!name) return null;
  const matches = targets.filter(
    (target) =>
      compact(target.name) === name ||
      (target.kind === "terminal" && compact(target.id) === name),
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Search every existing inspection target, putting an entered full name first. */
export function findBulkTargets(query, targets) {
  const name = compact(query);
  if (!name) return targets;
  const exact = resolveBulkTarget(query, targets);
  const devices = targets.filter((target) => target.kind === "device");
  const recognized = new Set(
    findManualDevices(query, devices).map((device) => device.key),
  );
  const results = targets.filter(
    (target) =>
      target === exact ||
      compact(target.name).includes(name) ||
      recognized.has(target.key),
  );
  return exact
    ? [exact, ...results.filter((target) => target !== exact)]
    : results;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return reviewed-name suggestions, never an assigned target.
 *
 * Scores rank the strength of text evidence, not statistical OCR confidence.
 * Numeric edits are limited to common letter-shaped OCR errors in a tag's
 * number. A different actual digit, prefix, or explicit suffix is not guessed.
 */
export function suggestBulkTargets(text, targets) {
  const source = normalizedText(text);
  if (!source.trim()) return [];
  const devices = targets.filter((target) => target.kind === "device");
  const byDeviceId = new Map(devices.map((target) => [target.id, target]));
  const matches = new Map();

  function add(target, confidence, matchedText, score) {
    if (!target) return;
    const previous = matches.get(target.key);
    if (!previous || score > previous.score)
      matches.set(target.key, { target, confidence, matchedText, score });
  }

  for (const match of matchDeviceLabels(source, devices)) {
    add(
      byDeviceId.get(match.deviceId),
      match.confidence,
      match.matchedText,
      match.confidence === "exact" ? 100 : 70,
    );
  }

  // Extend the existing O/I/L handling to S/5 and B/8, only inside a complete
  // tag-shaped numeric run. Keep the entire source (including unknown suffixes
  // and long numbers) so the existing matcher can still reject invalid tags.
  const corrections = [];
  const corrected = source.replace(
    /(TH|V|PD|DP)([\s-]*)([0-9OILSB]{4,})/gi,
    (whole, prefix, spacing, number, offset) => {
      if (!/[SB]/i.test(number)) return whole;
      const start = offset + prefix.length + spacing.length;
      corrections.push({ start, end: start + number.length });
      return prefix + spacing + number.replace(/S/gi, "5").replace(/B/gi, "8");
    },
  );
  if (corrections.length) {
    for (const match of matchDeviceLabels(corrected, devices)) {
      let start = corrected.indexOf(match.matchedText);
      while (start !== -1) {
        const end = start + match.matchedText.length;
        if (corrections.some((edit) => edit.start < end && edit.end > start)) {
          add(
            byDeviceId.get(match.deviceId),
            "possible",
            source.slice(start, end),
            60,
          );
          break;
        }
        start = corrected.indexOf(match.matchedText, start + 1);
      }
    }
  }

  for (const target of targets) {
    if (target.kind === "terminal") {
      const id = escapeRegExp(String(target.id));
      const label = new RegExp(
        `(?:^|[^A-Z0-9])(TERMINAL[\\s-]+(?:BLOCK[\\s-]+)?${id})(?=$|[^A-Z0-9])`,
        "gi",
      );
      for (const found of source.matchAll(label))
        add(target, "exact", found[1], 100);
    } else if (target.kind === "equipment") {
      const words = normalizedText(target.name).trim().split(/[\s-]+/);
      const label = new RegExp(
        `(?:^|[^A-Z0-9])(${words.map(escapeRegExp).join("[\\s-]*")})(?=$|[^A-Z0-9])`,
        "gi",
      );
      for (const found of source.matchAll(label))
        add(target, "exact", found[1], 100);
    }
  }

  return [...matches.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.target.name.localeCompare(right.target.name, "en"),
  );
}

/** A tie means the inspector must choose; catalog order must not decide. */
export function getBulkSuggestion(matches) {
  if (!matches.length) return null;
  const highestScore = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === highestScore);
  return best.length === 1 ? best[0].target : null;
}
