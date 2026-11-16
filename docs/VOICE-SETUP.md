# Voice comments

An inspector can record between 5 and 90 seconds for a device, terminal, or the whole walkdown, listen to the recording, and choose **Transcribe recording**. The server first removes background noise with ElevenLabs Audio Isolation, then transcribes the isolated audio with Scribe v2. If noise removal fails, transcription stops. The result fills the editable comment draft; the inspector must review it and explicitly add the comment.

## Deploy

1. For an existing single-report deployment, run [`supabase/named-walkdowns.sql`](../supabase/named-walkdowns.sql). Fresh projects use the current main schema. Both include general comments and scoped voice authorization. Existing evidence is preserved in **Unassigned skid** until manually renamed. The quota stores inspector IDs, skid IDs, and attempt times, permitting up to 10 attempts per five minutes and 120 per rolling day per inspector **across all skids**. Failed provider attempts still count.
2. In GitHub, open **Settings → Environments → QA-Report**. Add these environment secrets using these exact names:

   | GitHub environment secret | Purpose                                                                             |
   | ------------------------- | ----------------------------------------------------------------------------------- |
   | `ELEVEN_LABS_API_KEY`     | ElevenLabs key with Audio Isolation and Speech to Text access and available credits |
   | `SUPABASE_ACCESS_TOKEN`   | Supabase personal access token authorized to deploy to this project                 |

3. Open **Actions → Deploy voice comments → Run workflow**. This workflow runs only when manually requested. It tests the app, maps the GitHub `ELEVEN_LABS_API_KEY` value to the Supabase server secret **`ELEVENLABS_API_KEY`**, and deploys `transcribe-comment` to project `ybeinufetluekswsulvj`.
4. Confirm the workflow succeeded and the function appears in Supabase Edge Functions. Test from the signed-in production app with a short comment, then review the transcript before saving.

No ElevenLabs secret belongs in a `VITE_*` variable, browser configuration, source file, public GitHub Pages file, or transcript request. The browser sends its Supabase user access token and the project's public API key. GitHub Actions transfers the ElevenLabs secret to Supabase; the frontend cannot read it. Do not rename the existing GitHub environment secret—the workflow deliberately maps the two different names.

As an alternative to GitHub Actions, deploy all files from `supabase/functions/transcribe-comment/` (including the bundled SDK and its loader) through the Supabase dashboard and set `ELEVENLABS_API_KEY` under Edge Function secrets. Supabase supplies `SUPABASE_URL` and `SUPABASE_ANON_KEY`; this function uses the caller's JWT with that public key and does not use a service-role key. [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets), [deployment guide](https://supabase.com/docs/guides/functions/deploy).

## Authentication and request handling

- `verify_jwt = true` remains enabled in [`supabase/config.toml`](../supabase/config.toml). The frontend's Authorization header must contain the **signed-in user's access token**, not the publishable key.
- The handler independently calls `auth.getUser()`, requires a UUID `walkdown_id` multipart field, calls `qa_load_state({ p_walkdown_id })` with the same user session, verifies the returned skid ID and that it has been manually named, and checks that the requested device/terminal exists or that the scope is exactly `walkdown:general`. This extra scope is for comments only and adds no inspection target. The handler then checks the database quota before invoking ElevenLabs. Authentication and membership checks remain required even if gateway configuration changes.
- Allowed browser origins are `https://khuongnguyen99.github.io` and HTTP localhost/127.0.0.1 development ports. Origin checks supplement user authentication.
- Multipart audio is limited to 10 MB, with bounded request reading. Audio WebM, MP4, and Ogg cover the browser recorder formats. The browser stops recording at 90 seconds; the server also checks the submitted duration metadata. File byte limits and the database quota apply independently of that client metadata.
- The pipeline has a 115-second overall deadline and disables automatic provider retries. No raw audio, transcript, token, or API key is logged by this code. The app does not save the audio recording to its database or Storage.
- Audio is sent to ElevenLabs when the inspector chooses Transcribe. Provider processing/history is subject to the ElevenLabs account's settings. This implementation does not claim zero retention: ElevenLabs documents its transcription zero-retention option as enterprise-only. [Audio Isolation](https://elevenlabs.io/docs/api-reference/audio-isolation/convert), [Scribe transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

## Verify before field use

1. Record a short comment containing background noise. Stop, play it back, and transcribe. Confirm the editable draft receives text and no shared comment appears until **Add comment** is chosen.
2. Cancel while recording or transcribing; change devices or skid walkdowns while recording. Confirm the microphone indicator stops and no late result appears in another record's draft.
3. Test an iPhone/Safari or another MP4-recording browser and an Android/Chrome WebM browser. Microphone access requires HTTPS or localhost and browser permission.
4. Check that a missing/expired session and a non-allowlisted user cannot invoke paid processing. Confirm the named-walkdown schema is installed; otherwise authenticated requests return a setup error before calling ElevenLabs.
5. Remove or leave unset the server ElevenLabs key in a test environment. The app should show a readable setup message and still allow typed comments. Do not remove production secrets to run this check.

Run `node --test tests/voice*.test.js` for mocked browser capture/request and server pipeline tests. These check cleanup, authentication/membership, limits, correct processing order, error handling, and refusal to skip isolation. They make no paid API calls. Deno type checking and the official SDK's mock-fetch pipeline can validate integration shape; successful live transcription still requires configured credentials and a real recording.

If the gateway returns 401 before the handler, first check that the request carries a current user JWT and the correct project API key. Do not disable JWT checks as a generic fix. The handler's `getUser()` and allowlist checks must always remain in place. [Supabase Edge Function authentication headers](https://supabase.com/docs/guides/functions/auth-headers).

The **Diagnose voice service** workflow sends only the included six-second synthetic speech fixture through the deployed SDK adapter and real Audio Isolation/Scribe APIs. It runs manually and uses ElevenLabs credits. It never uploads QA evidence or comments.
