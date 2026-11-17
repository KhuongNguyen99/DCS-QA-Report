export function photosFor(key, state) {
  return state.photos.filter((photo) => photo.recordKey === key);
}

export function commentsFor(key, state) {
  return state.comments.filter((comment) => comment.recordKey === key);
}

export function recordStatus(key, state) {
  const photos = photosFor(key, state);
  if (
    photos.length &&
    state.records.some((record) => record.key === key && record.complete)
  )
    return "complete";
  return photos.length || commentsFor(key, state).length
    ? "in-progress"
    : "not-started";
}

export function terminalProgress(terminal, devices, state) {
  const members = devices.filter((device) => device.terminal === terminal);
  const complete = members.filter(
    (device) => recordStatus(`device:${device.id}`, state) === "complete",
  ).length;
  const terminalPhotos = photosFor(`terminal:${terminal}`, state).length;
  const terminalReviewed =
    recordStatus(`terminal:${terminal}`, state) === "complete";
  return {
    total: members.length,
    complete,
    terminalPhotos,
    terminalReviewed,
    done: members.length > 0 && complete === members.length && terminalReviewed,
    started:
      complete > 0 ||
      members.some(
        (device) =>
          recordStatus(`device:${device.id}`, state) !== "not-started",
      ) ||
      terminalPhotos > 0 ||
      commentsFor(`terminal:${terminal}`, state).length > 0,
  };
}

export function inspectionProgress(devices, groups, state, equipment = []) {
  return {
    devices: devices.filter(
      (device) => recordStatus(`device:${device.id}`, state) === "complete",
    ).length,
    terminals: groups.filter(
      (group) => terminalProgress(group.id, devices, state).done,
    ).length,
    equipment: equipment.filter(
      (item) => recordStatus(`equipment:${item.id}`, state) === "complete",
    ).length,
    photos: state.photos.length,
  };
}
