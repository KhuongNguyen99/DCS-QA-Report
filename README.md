# Jeevy DCS Field QA

Shared field inspection for **450k Skid x7 - DCS**. The app is a mobile-friendly static website on GitHub Pages with a private Supabase workspace and the revision-3 device schedule.

## Inspection workflow

1. Sign in with an approved inspector email. Open the email's sign-in link, or enter its code if one is included.
2. Create a **New skid report** and enter its skid name, or select an existing report. Each skid has separate photos, comments, quality, completion, and revision. Existing pre-skid data is preserved as **Unassigned skid** and must be named before continuing.
3. Tap A–H or **Control Box**, **Solenoid Box**, or **Transducer Panel** on the conduit layout, or use **QA overview** for all 39 inspection items: 28 field devices, 8 terminals, and 3 equipment items. Equipment also has its own cards below the map and an **Equipment only** overview filter.
4. Scan a device label, use **Enter device name** to search and choose a scheduled device, or open its row. Manual entry is also available inside the scanner. Label matching tolerates surrounding text such as `OV-3541F` and `*V-3541#`; ambiguous matches need your selection.
5. Capture or upload evidence photos and add comments. Each terminal also has its own evidence record. Use **Flashlight** in the camera to toggle the rear-camera torch when your phone/browser supports it; closing the camera turns it off.
6. Choose **Good** or **Bad** in the camera, record, or overview table. Quality saves immediately and stays in sync across those screens. The checkboxes are mutually exclusive; clicking the selected choice clears it.
7. Review evidence and mark QA complete. A terminal turns green after its own evidence and all its devices are complete. On its terminal page, **Mark complete** below **Inspect terminal** saves terminal QA directly once those prerequisites are met.
8. Export the whole inspection from **Report**. Each documented device, terminal, or equipment item starts on its own page showing only its name, photos, a large Good/Bad stamp, and bold red comments. Filenames, capture times, inspector names, cable details, completion labels, and counts are omitted. Up to six photos with brief comments fit on one page when space permits; longer records continue without cropping or omitting evidence. The overview lists all 39 names and ratings, including unfinished items.

**Documented** in the overview means at least one saved photo. It is separate from quality and completed QA review. Comments are optional. Draft comments stay with their skid when switching reports and survive camera navigation until posted, the page is reloaded, or the inspector signs out.

Each equipment inspection has its own photos, typed/voice comments, quality, and completion for the selected skid. Completing equipment requires its own saved photo and does not complete any field device or terminal. Overall progress and **Complete inspection** include all 39 items. Equipment appears in PDF coverage and gets the same compact evidence pages as devices and terminals.

Use **General walkdown comments** on the layout or report screen for notes about the whole inspection. Typed and voice notes are shared with the team and included in their own PDF section.

The QA PDF matches the landscape wiring document's cover, header, and footer, with the cover title **450k skid x7 - DCS** and subtitle **QA Report - <Skid name>**. Every page footer places the skid name beside its revision number and includes **Inspected date**, using the document's creation date at export. The cover date, PDF creation metadata, footer date, and filename use the same captured export time, rather than photo or comment dates. Each skid’s shared revision starts at 3 and advances once for each saved change to its name, evidence, comments, quality, or completion. Reading, scanning, recording a draft, and exporting unchanged data do not advance it. All pages and the downloaded filename use the same snapshot revision.

Photos, comments, quality, and completion are shared across signed-in devices. OCR runs locally using the bundled Tesseract English model. Failed saves show an error and retain the capture for retry; a network connection is required to save shared evidence.

## Bulk photo review

Use **Bulk upload photos** on the layout, QA overview, or report screen after selecting a named skid report. Choose all your photos in one file selection, or drop a batch into the dialog. The queue shows one image at a time, including its filename and a zoom control.

1. Review the photo and type its device, terminal, or equipment name. The same inspection catalog is used throughout; typing `B` also selects **Terminal B**. Click a search result or use the arrow keys to choose a match.
2. If a label can be read, the closest supported match appears as an empty field's **placeholder**. Press **Tab** to fill it in, then **Enter** to save. A placeholder alone is never saved.
3. **Enter** or **Save & next** uploads the photo to that item's evidence and automatically opens the next photo with a fresh name field. The selected skid stays fixed for the entire queue.
4. Use **Skip photo** for images you want to handle later. At the end, **Review skipped photos** returns them to the queue; the completion screen distinguishes saved photos from skipped ones.

To rotate a photo, click its preview and press **Q** for 90° left or **E** for 90° right, or use the **Left / Right** buttons. While typing a name, **Escape** focuses the photo; **Tab** returns to the name field. Q and E remain normal letters in the name field. Rotation updates the preview, saved evidence, and OCR orientation while preserving the name you have entered. Skipped photos retain their rotation; each new photo starts in its original orientation.

The name field remains usable while OCR runs, and late OCR results cannot replace a typed or chosen name. Similar tags, suffixes such as `-Y` and `#2`, and ambiguous labels require review. Photos without a readable label can always be assigned manually. JPEG, PNG, WebP, and browser-decodable HEIC/HEIF images are supported, up to 20 MB each. Unsupported or damaged images do not block the rest of a batch.

OCR runs on the device using the existing self-hosted Tesseract worker and English model, without a cloud OCR account or API key. It reads the original image with bounded resolution, uses sparse-label segmentation, and makes one alternate pass when no catalog label is found. Only the current photo is decoded; queued files are processed sequentially, and saved files and previews are released. Shared evidence uses the existing photo compression and upload workflow. Failed saves retain the photo and chosen name for retry; a failed report refresh after a successful upload does not upload the photo twice. Unfinished queues stay in the open dialog, so finish or explicitly discard them before closing the page.

## Voice comments

The microphone tool records between 5 and 90 seconds. After you review the recording, the private voice function sends it to ElevenLabs Audio Isolation, then Scribe v2. The transcript fills the editable comment draft; it is never posted automatically. Audio is not retained by this app.

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

Automated tests cover schedule integrity, conservative label matching, the bulk review queue and keyboard controls, OCR cancellation and cleanup, shared data calls, quality, completion prerequisites, photo handling, microphone cleanup, voice validation/order, and PDF coverage/pagination. Browser checks additionally exercise real OCR, mobile layout, capture, comments, shared updates, and PDF downloads. Physical phone cameras, noisy field audio, and actual two-inspector use should be checked on site.

## Update the cable schedule

The current catalog was extracted from the latest revision-3 Word document, preserving cable 21 for V-3541 and cable 22 for V-3511. The reproducible extraction helper is `scripts/extract-schedule.py`. Review `src/data/schedule.json` and the server's `qa_targets` catalog together when changing devices or terminal groups; stable record keys preserve the evidence associations.

Noto Sans fonts are distributed under the included [SIL Open Font License](public/assets/NotoSans-OFL.txt).
