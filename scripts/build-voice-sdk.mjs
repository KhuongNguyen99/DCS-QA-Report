// Rebuild with: node scripts/build-voice-sdk.mjs
// The exact SDK and esbuild versions below are devDependencies. The generated
// server-only ESM avoids evaluating thousands of npm/CommonJS modules at startup.
import { build, version as esbuildVersion } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SDK_VERSION = '2.78.0';
const ESBUILD_VERSION = '0.28.2';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const sdkPackage = require.resolve('@elevenlabs/elevenlabs-js/package.json');
const sdkRequire = createRequire(sdkPackage);
const sdk = JSON.parse(await readFile(sdkPackage, 'utf8'));
if (sdk.version !== SDK_VERSION || esbuildVersion !== ESBUILD_VERSION) {
  throw new Error(`Use @elevenlabs/elevenlabs-js ${SDK_VERSION} and esbuild ${ESBUILD_VERSION} to rebuild the voice bundle.`);
}
const directory = join(root, 'supabase/functions/transcribe-comment');
const result = await build({
  stdin: {
    contents: `export { AudioIsolationClient } from '@elevenlabs/elevenlabs-js/api/resources/audioIsolation/client/Client.js';
export { SpeechToTextClient } from '@elevenlabs/elevenlabs-js/api/resources/speechToText/client/Client.js';`,
    resolveDir: root, sourcefile: 'voice-sdk-entry.js',
  },
  outfile: join(directory, 'eleven-sdk.js'), write: false,
  bundle: true, minify: true, treeShaking: true, platform: 'browser', format: 'esm', target: 'es2022',
  metafile: true, legalComments: 'none',
  banner: { js: `// Generated from official @elevenlabs/elevenlabs-js ${SDK_VERSION} by scripts/build-voice-sdk.mjs (esbuild ${ESBUILD_VERSION}).
// Server-only ESM bundle for Deno. Do not edit; see eleven-sdk.LICENSE.txt for licenses.` },
});
const output = result.outputFiles[0];
if (output.contents.byteLength > 5 * 1024 * 1024) throw new Error('Voice SDK bundle exceeded its reviewed 5 MB size budget.');
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll('\\', '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match && !input.startsWith('(disabled):')) packages.add(match[1]);
}
const notices = [];
for (const name of [...packages].sort()) {
  const packagePath = sdkRequire.resolve(`${name}/package.json`);
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  let license;
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try { license = await readFile(join(dirname(packagePath), candidate), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error(`No license text found for bundled package ${name}.`);
  notices.push(`${name}@${metadata.version}\n${'='.repeat(60)}\n${license.trim()}\n`);
}
await writeFile(join(directory, 'eleven-sdk.LICENSE.txt'), notices.join('\n'));
await writeFile(output.path, output.contents);
console.log(`Voice SDK: ${output.contents.byteLength} bytes; SHA-256 ${createHash('sha256').update(output.contents).digest('hex')}`);
