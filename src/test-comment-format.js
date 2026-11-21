export function testCommentBlocks(value) {
  const blocks = [];
  for (const line of value.split(/\r?\n/)) {
    const diagnostic = /^- (\S.*?) — Passed$/.exec(line)?.[1];
    const kind = diagnostic ? "diagnostics" : "text";
    const previous = blocks.at(-1);
    if (previous?.kind === kind) previous.lines.push(diagnostic ?? line);
    else blocks.push({ kind, lines: [diagnostic ?? line] });
  }
  return blocks;
}
