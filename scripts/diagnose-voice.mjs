// Manual service check with synthetic audio only. Never prints credentials or QA audio.
import { createVoiceSdkClient } from '../supabase/functions/transcribe-comment/sdk-client.js';

const env = name => globalThis.Deno ? Deno.env.get(name) : process.env[name];
const key = env('ELEVENLABS_API_KEY');
if (!key) throw new Error('The server voice key is missing.');

const token = env('SUPABASE_ACCESS_TOKEN');
if (token) {
  const url = new URL('https://api.supabase.com/v1/projects/ybeinufetluekswsulvj/analytics/endpoints/logs');
  url.searchParams.set('sql', "select timestamp, source, log_attributes['response.status_code'] as status from logs where source = 'function_edge_logs' order by timestamp desc limit 12");
  url.searchParams.set('iso_timestamp_end', new Date().toISOString());
  url.searchParams.set('iso_timestamp_start', new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ check: 'function-log-status', status: response.status, rows: data.result ?? [], queryError: Boolean(data.error) }));
}

const rate = 16000;
const samples = rate * 3;
const bytes = new Uint8Array(44 + samples * 2);
const view = new DataView(bytes.buffer);
const ascii = (at, value) => [...value].forEach((c, index) => { bytes[at + index] = c.charCodeAt(0); });
ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE');
ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true);
for (let n = 0; n < samples; n++) view.setInt16(44 + n * 2, Math.round(3000 * Math.sin(2 * Math.PI * 440 * n / rate)), true);

let stage = 'sdk-import';
try {
  const client = createVoiceSdkClient(key);
  stage = 'audio-isolation';
  const stream = await client.audioIsolation.convert({ audio: new File([bytes], 'synthetic-test.wav', { type: 'audio/wav' }), fileFormat: 'other' }, { maxRetries: 0, timeoutInSeconds: 50 });
  const isolated = await new Response(stream).arrayBuffer();
  console.log(JSON.stringify({ check: 'provider-isolation', ok: true, outputBytes: isolated.byteLength }));
} catch (error) {
  const detail = error?.body?.detail;
  const safe = value => typeof value === 'string' ? value.replaceAll(key, '[redacted]').replaceAll(token || '\0', '[redacted]').slice(0, 500) : undefined;
  console.log(JSON.stringify({ check: 'provider-isolation', ok: false, stage, name: safe(error?.name), status: error?.statusCode, code: safe(detail?.status), detail: safe(typeof detail === 'string' ? detail : detail?.message), message: safe(error?.message) }));
  if (globalThis.Deno) Deno.exit(1); else process.exitCode = 1;
}
