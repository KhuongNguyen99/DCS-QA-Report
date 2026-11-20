export const REPEATED_IO_CHANGE_NOTE = 'repeated I/O change at the same recorded timestamp; all observations retained (duplicate event not established).';

const LEGACY_REPEAT_SUFFIX = ': duplicate I/O event retained; no observations were removed.';

/** Explain earlier wording without rewriting notes frozen in an approved run. */
export function importNoteClarification(warnings = []) {
  return warnings.some((note) => typeof note === 'string' && note.endsWith(LEGACY_REPEAT_SUFFIX))
    ? 'Earlier import notes use “duplicate I/O event” for matching channel, timestamp, and change text. This does not establish a duplicate physical event; multiple changes can share a timestamp. All observations were retained.'
    : '';
}
