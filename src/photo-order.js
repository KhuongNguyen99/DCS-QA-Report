export function photoOrderKey(url, inspectorId, walkdownId, revision, targetId) {
  try {
    const origin = new URL(url);
    if (!/^https?:$/.test(origin.protocol) || ![inspectorId, walkdownId, targetId].every(id => typeof id === "string" && id)
      || !Number.isSafeInteger(revision) || revision < 1) return null;
    return `jeevy-qa-photo-order:v1:${encodeURIComponent(JSON.stringify([origin.origin, inspectorId, walkdownId, revision, targetId]))}`;
  } catch { return null; }
}

export const samePhotoOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

function valid(order) {
  const ids = value => Array.isArray(value) && value.length <= 1000
    && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 160 && !id.includes("\u0000"))
    && new Set(value).size === value.length;
  return order?.v === 1 && ids(order.expectedIds) && ids(order.orderedIds)
    && order.expectedIds.length === order.orderedIds.length
    && order.orderedIds.every(id => order.expectedIds.includes(id));
}

export function readPhotoOrder(key) {
  if (!key) return { order: null, error: "" };
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (!raw) return { order: null, error: "" };
    if (raw.length > 1_000_000) throw new Error();
    const order = JSON.parse(raw);
    if (!valid(order)) throw new Error();
    return { order, error: "" };
  } catch { return { order: null, error: "The cached photo order could not be read. Its stored data has been left untouched." }; }
}

export function writePhotoOrder(key, order) {
  try {
    if (!key || !valid(order)) throw new Error();
    const raw = JSON.stringify(order);
    if (raw.length > 1_000_000) throw new Error();
    globalThis.localStorage.setItem(key, raw);
    return "";
  } catch { return "The pending photo order could not be cached locally. Keep this tab open until Save photo order succeeds."; }
}

export function clearPhotoOrder(key) {
  try {
    if (key) globalThis.localStorage.removeItem(key);
    return "";
  } catch { return "The cached photo order could not be cleared. It may reappear after refresh."; }
}
