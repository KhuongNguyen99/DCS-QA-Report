# Jeevy DCS Field QA

Shared field inspection for **450k Skid x7 - DCS**. The app is a mobile-friendly static website on GitHub Pages with a private Supabase workspace and the revision-3 device schedule.

## Inspection workflow

1. Sign in with an approved inspector email. Open the email's sign-in link, or enter its code if one is included.
2. Tap A–H on the conduit layout to open that terminal group, or use **QA overview** for all 28 devices and 8 terminals.
3. Scan a device label or open its row. Label matching tolerates surrounding text such as `OV-3541F` and `*V-3541#`; ambiguous matches need your selection.
4. Capture or upload evidence photos and add comments. Each terminal also has its own evidence record.
5. Choose **Good** or **Bad** in the Quality column. The checkboxes are mutually exclusive; clicking the selected choice clears it.
6. Review evidence and mark QA complete. A terminal turns green after its own evidence and all its devices are complete.
7. Export the whole inspection from **Report**. The PDF includes unfinished items, quality, photos, comments, authors, and timestamps.

**Documented** in the overview means at least one saved photo. It is separate from quality and completed QA review. Comments are optional. Draft comments survive camera navigation until posted or signed out.

Use **General walkdown comments** on the layout or report screen for notes about the whole inspection. Typed and voice notes are shared with the team and included in their own PDF section.

The QA PDF matches the landscape wiring document's cover, header, and footer, with the subtitle **QA Report**. Its shared revision starts at 3 and advances once for each saved change to evidence, comments, quality, or completion. Reading, scanning, recording a draft, and exporting unchanged data do not advance it. All pages and the downloaded filename use the same snapshot revision.

Photos, comments, quality, and completion are shared across signed-in devices. OCR runs locally using the bundled Tesseract English model. Failed saves show an error and retain the capture for retry; a network connection is required to save shared evidence.

## Voice comments

The microphone tool records up to 90 seconds. After you review the recording, the private voice function sends it to ElevenLabs Audio Isolation, then Scribe v2. The transcript fills the editable comment draft; it is never posted automatically. Audio is not retained by this app.

The [voice setup guide](docs/VOICE-SETUP.md) describes the GitHub environment secrets and deployment. The ElevenLabs key belongs only in server secrets and never in a `VITE_` variable or browser code.

## Project setup

The current public browser configuration points to `ybeinufetluekswsulvj.supabase.co`. Only the project's publishable key is included in the source. Private tables, storage policies, membership checks, and checked database functions control access.

- [Supabase setup and inspector access](supabase/SETUP.md)
- [Database schema](supabase/schema.sql)
- [Read-only deployment verification](supabase/VERIFY.sql)
- [Voice attempt limits](supabase/voice-rate-limit.sql)

The initial administrator is `khuong@jeevyfabrication.com`. Add each inspector to `qa_inspectors` as described in the setup guide. Supabase's default email service has recipient restrictions; configure custom SMTP for a team rollout. The app supports the default sign-in link as well as numeric codes, so custom OTP templates are optional.

GitHub hosts the application and its device catalog. Inspection photos, audio, comments, and secret keys are not committed to GitHub.

## Develop and verify

Requires Node.js 22.12 or newer. Node.js 24 is used for the website build.

```sh
npm ci
npm test
npm run dev
npm run build
npm run preview
```

The build copies the OCR worker, WASM cores, and English language data into `public/ocr`. These generated files and `node_modules` are ignored by Git. The relative Vite base works at the repository's GitHub Pages subpath.

Automated tests cover schedule integrity, conservative label matching, shared data calls, quality, completion prerequisites, photo handling, microphone cleanup, voice validation/order, and PDF coverage/pagination. Browser checks additionally exercise real OCR, mobile layout, capture, comments, shared updates, and PDF downloads. Physical phone cameras, noisy field audio, and actual two-inspector use should be checked on site.

## Update the cable schedule

The current catalog was extracted from the latest revision-3 Word document, preserving cable 21 for V-3541 and cable 22 for V-3511. The reproducible extraction helper is `scripts/extract-schedule.py`. Review `src/data/schedule.json` and the server's `qa_targets` catalog together when changing devices or terminal groups; stable record keys preserve the evidence associations.

Noto Sans fonts are distributed under the included [SIL Open Font License](public/assets/NotoSans-OFL.txt).
