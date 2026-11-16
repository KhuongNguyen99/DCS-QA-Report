let bundle;
const loadBundle = () => (bundle ??= import('./eleven-sdk.js'));

// Creating this adapter is cheap. The official SDK is evaluated only on the
// first convert call, after the handler has checked user, membership and quota.
export function createVoiceSdkClient(apiKey, { fetchImpl, loadSdk = loadBundle } = {}) {
  const options = {
    apiKey, maxRetries: 0, timeoutInSeconds: 50, logging: { silent: true },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  return {
    audioIsolation: {
      async convert(request, requestOptions) {
        const { AudioIsolationClient } = await loadSdk();
        return new AudioIsolationClient(options).convert(request, requestOptions);
      },
    },
    speechToText: {
      async convert(request, requestOptions) {
        const { SpeechToTextClient } = await loadSdk();
        return new SpeechToTextClient(options).convert(request, requestOptions);
      },
    },
  };
}
