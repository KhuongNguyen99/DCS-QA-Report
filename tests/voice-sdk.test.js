import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSdkClient } from '../supabase/functions/transcribe-comment/sdk-client.js';

test('SDK evaluation is deferred until an authorized pipeline invokes conversion', async () => {
  let loads = 0;
  const client = createVoiceSdkClient('mock-key', {
    async loadSdk() {
      loads++;
      return { AudioIsolationClient: class { convert(request) { return request.audio; } } };
    },
  });
  assert.equal(loads, 0);
  assert.equal(await client.audioIsolation.convert({ audio: 'fake-audio' }), 'fake-audio');
  assert.equal(loads, 1);
});

test('bundled official SDK preserves isolation and Scribe v2 multipart requests and responses', async () => {
  const requests = [];
  const client = createVoiceSdkClient('mock-key-not-a-secret', {
    async fetchImpl(url, init) {
      const path = new URL(url).pathname;
      requests.push({ path, init });
      if (path === '/v1/audio-isolation') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
      return Response.json({ text: 'Check terminal tightness.', language_code: 'en', language_probability: 1,
        words: [{ type: 'word', text: 'Check', start: 0, end: 1, logprob: -0.1 }] });
    },
  });
  const options = { maxRetries: 0, timeoutInSeconds: 2, abortSignal: new AbortController().signal };
  const stream = await client.audioIsolation.convert({ audio: new File([new Uint8Array(256)], 'recording.webm', { type: 'audio/webm' }), fileFormat: 'other' }, options);
  const isolated = await new Response(stream).blob();
  const result = await client.speechToText.convert({ file: new File([isolated], 'isolated.mp3', { type: 'audio/mpeg' }),
    modelId: 'scribe_v2', tagAudioEvents: false, diarize: false, useMultiChannel: false, webhook: false }, options);
  assert.deepEqual(requests.map(request => request.path), ['/v1/audio-isolation', '/v1/speech-to-text']);
  assert.equal(requests[0].init.body.get('file_format'), 'other');
  assert.equal(requests[1].init.body.get('model_id'), 'scribe_v2');
  assert.equal(requests[1].init.body.get('file').name, 'isolated.mp3');
  assert.equal(isolated.size, 3);
  assert.equal(result.text, 'Check terminal tightness.');
});
