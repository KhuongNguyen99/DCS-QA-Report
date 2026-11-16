import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const modules = join(projectRoot, "node_modules");
const output = join(projectRoot, "public", "ocr");

function requireFile(path) {
  if (!existsSync(path))
    throw new Error(`Missing OCR asset: ${path}. Run npm install first.`);
  return path;
}

mkdirSync(output, { recursive: true });
copyFileSync(
  requireFile(join(modules, "tesseract.js", "dist", "worker.min.js")),
  join(output, "worker.min.js"),
);

const coreDirectory = join(modules, "tesseract.js-core");
const coreFiles = readdirSync(coreDirectory).filter((file) =>
  /^tesseract-core.*\.wasm(?:\.js)?$/.test(file),
);
const requiredCoreNames = [
  "tesseract-core.wasm.js",
  "tesseract-core-simd.wasm.js",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
];
for (const file of requiredCoreNames) requireFile(join(coreDirectory, file));
for (const file of coreFiles)
  copyFileSync(join(coreDirectory, file), join(output, file));

const languageRoot = join(modules, "@tesseract.js-data", "eng");
const languageCandidates = ["4.0.0_fast", "4.0.0_best_int", "4.0.0_best"];
const languagePath = languageCandidates
  .map((folder) => join(languageRoot, folder, "eng.traineddata.gz"))
  .find(existsSync);
if (!languagePath)
  throw new Error(
    `Missing English OCR data in ${languageRoot}. Run npm install first.`,
  );
copyFileSync(languagePath, join(output, "eng.traineddata.gz"));

for (const [directory, name] of [
  [join(modules, "tesseract.js"), "tesseract-js"],
  [coreDirectory, "tesseract-core"],
  [languageRoot, "english-data"],
]) {
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE"]) {
    if (existsSync(join(directory, file)))
      copyFileSync(join(directory, file), join(output, `${name}-${file}`));
  }
}

console.log(`Copied ${coreFiles.length + 2} OCR assets to public/ocr`);
