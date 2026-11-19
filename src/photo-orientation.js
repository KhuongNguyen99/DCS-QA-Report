/** Clockwise 90-degree turns, normalized so left turns and full turns wrap. */
export function normalizeQuarterTurns(quarterTurns = 0) {
  if (!Number.isInteger(quarterTurns))
    throw new RangeError("Photo rotation must use whole 90-degree turns.");
  return ((quarterTurns % 4) + 4) % 4;
}

export function rotatedDimensions(width, height, quarterTurns = 0) {
  return normalizeQuarterTurns(quarterTurns) % 2
    ? { width: height, height: width }
    : { width, height };
}

/** Draw into an already sized canvas without cropping any rotated corners. */
export function drawRotatedImage(context, image, width, height, quarterTurns = 0) {
  const turns = normalizeQuarterTurns(quarterTurns);
  if (!turns) {
    context.drawImage(image, 0, 0, width, height);
    return;
  }
  const [x, y] = [[0, 0], [height, 0], [width, height], [0, width]][turns];
  context.save();
  try {
    context.translate(x, y);
    context.rotate(turns * Math.PI / 2);
    context.drawImage(image, 0, 0, width, height);
  } finally {
    context.restore();
  }
}
