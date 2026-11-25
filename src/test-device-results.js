const MANUAL_STATUSES = new Set(["Passed", "Failed"]);
const RECORDED_STATUSES = new Set(["Passed", "Failed", "Not tested"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" && value.trim().length > 0
  && Array.from(value).length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

export const isManualTestStatus = value => MANUAL_STATUSES.has(value);

export const hasManualTestStatus = device => object(device) && Object.hasOwn(device, "manualStatus")
  && isManualTestStatus(device.manualStatus);

export function getDeviceTestStatus(device) {
  if (hasManualTestStatus(device)) return device.manualStatus;
  return RECORDED_STATUSES.has(device?.status) ? device.status : "Not tested";
}

export function assertManualTestStatuses(devices) {
  if (!Array.isArray(devices)) throw new Error("The test device list is invalid.");
  for (const device of devices)
    if (object(device) && Object.hasOwn(device, "manualStatus") && !isManualTestStatus(device.manualStatus))
      throw new Error("A manual device result must be Passed or Failed. Remove the manual result to use the recorded result.");
  return devices;
}

// Drafts use null to remember a pending reset; persisted devices omit the field.
export function validManualStatuses(value) {
  if (!object(value) || Object.prototype.toString.call(value) !== "[object Object]") return false;
  const entries = Object.entries(value);
  return entries.length <= 250 && entries.every(([id, status]) => validId(id)
    && (status === null || isManualTestStatus(status)));
}
