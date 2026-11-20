// Siemens ET 200SP GSDML record 243 and the parameter data-record tables
// for the listed module order numbers. Ex-BaseUnit uses a separate value list.
const potentialGroup = { 0: "Continue left power group", 1: "Start new power group" };
const smoothing = { 0: "None", 1: "Weak", 2: "Medium", 3: "Strong" };
const standardSuppression = { 1: "60 Hz", 2: "50 Hz" };

const selections = {
  "6ES7155-6AU01-0CN0": {
    "configuration control": { 0: "Disabled", 1: "Enabled" },
  },
  "6ES7132-6BF01-0CA0": { BaseUnit: potentialGroup },
  "6ES7134-6FF00-0AA1": {
    BaseUnit: potentialGroup,
    "Measurement type/-area": { 0: "Input deactivated", 265: "Voltage, \u00b110 V" },
    Smoothing: smoothing,
    "Integration time - Standard": standardSuppression,
  },
  "6ES7134-6GF00-0AA1": {
    BaseUnit: potentialGroup,
    "Measurement type/-area": {
      0: "Input deactivated",
      770: "2-wire current, 0-20 mA",
      771: "2-wire current, 4-20 mA",
    },
    Smoothing: smoothing,
    "Integration time - Standard": standardSuppression,
  },
  "6ES7134-6JD00-0CA1": {
    BaseUnit: potentialGroup,
    "Measurement type/-area": { 0: "Input deactivated", 1794: "4-wire Pt100 RTD, standard range" },
    Smoothing: smoothing,
    "Integration time - Standard": standardSuppression,
    "Temperature coefficient": { 0: "Pt 0.00385055", 4: "Pt 0.00385" },
    "Temperature unit": { 0: "Celsius" },
    "Reference temperature RTD": { 0: "No reference channel mode" },
    "Changeable measuring range resolution": { 2: "2 decimal places" },
  },
  "6DL1134-6TB00-0HX1": {
    "Measurement type/-area HART 2": { 0: "Input deactivated", 771: "2-wire current, 4-20 mA" },
    Smoothing: smoothing,
    "Interference frequency suppression HART": { 3: "10 Hz" },
  },
};

export function pronetaSelectionLabel(orderNumber, enumId, value) {
  const part = String(orderNumber ?? "").replace(/\s+/g, "").toUpperCase();
  const fields = Object.hasOwn(selections, part) ? selections[part] : undefined;
  const choices = fields && Object.hasOwn(fields, enumId) ? fields[enumId] : undefined;
  const code = String(value ?? "").trim();
  return choices && Object.hasOwn(choices, code) ? choices[code] : undefined;
}
