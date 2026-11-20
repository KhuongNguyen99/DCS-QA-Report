# Jeevy DCS Field QC

Shared field inspection for **450k Skid x7 - DCS**. The app is a mobile-friendly static website on GitHub Pages with a private Supabase workspace and the revision-3 device schedule.

## Inspection workflow

1. Sign in with an approved inspector email. Open the email's sign-in link, or enter its code if one is included.
2. Create a **New skid report** and enter its skid name, or select an existing report. Each skid has separate photos, comments, quality, completion, and revision. Existing pre-skid data is preserved as **Unassigned skid** and must be named before continuing.
3. Tap A–H or **Control Box**, **Solenoid Box**, or **Transducer Panel** on the conduit layout, or use **QC overview** for all 39 inspection items: 28 field devices, 8 terminals, and 3 equipment items. Equipment also has its own cards below the map and an **Equipment only** overview filter.
4. Scan a device label, use **Enter device name** to search and choose a scheduled device, or open its row. Manual entry is also available inside the scanner. Label matching tolerates surrounding text such as `OV-3541F` and `*V-3541#`; ambiguous matches need your selection.
5. Capture or upload evidence photos and add comments. Each terminal also has its own evidence record. Use **Flashlight** in the camera to toggle the rear-camera torch when your phone/browser supports it; closing the camera turns it off.
6. Choose **Passed** or **Failed** in the camera, record, or overview table. Quality saves immediately and stays in sync across those screens. The checkboxes are mutually exclusive; clicking the selected choice clears it.
7. Review evidence and mark QC complete. A terminal turns green after its own evidence and all its devices are complete. On its terminal page, **Mark complete** below **Inspect terminal** saves terminal QC directly once those prerequisites are met.
8. Open **Report**, review the saved inspection, then select **Approve & close**. This locks that revision and enables its PDF export. Use **New revision** to continue editing a draft based on the closed revision. Earlier approved revisions remain available for download.

**Documented** in the overview means at least one saved photo. It is separate from quality and completed QC review. Comments are optional. In an open draft, a comment’s author or the administrator can select **Remove**, then confirm **Remove comment**. Closed revisions preserve their approved comments. Unposted comment drafts stay with their skid when switching reports and survive camera navigation until posted, the page is reloaded, or the inspector signs out.

Each equipment inspection has its own photos, typed/voice comments, quality, and completion for the selected skid. Completing equipment requires its own saved photo and does not complete any field device or terminal. Overall progress and **Complete inspection** include all 39 items. Equipment appears in PDF coverage and gets the same compact evidence pages as devices and terminals.

Use **General walkdown comments** on the layout or report screen for notes about the whole inspection. Typed and voice notes are shared with the team and included in their own PDF section.

## Approve, close, and revise

Each skid has an editable **Draft** or a locked **Closed** revision. New reports begin at revision 1. Existing reports keep their current number when upgraded and remain drafts until an inspector explicitly approves them. Saving photos, comments, quality, completion, test runs, or a skid name does not advance the revision.

1. Finish uploads and save any comments you want included. Review the current shared report.
2. Select **Approve & close**. The server saves an immutable snapshot of the skid name, inspection catalog, evidence, comments, quality, completion, and imported test runs, together with the approving inspector and approval time. Test runs include software details, recorded results, selected parameters, source identifiers, import notes, and graph observations. The report becomes read-only. Approval is an explicit report-level decision; unfinished inspection items remain visible in the report. Save or discard local test-import changes before approving.
3. Export the closed revision as a PDF. Draft reports cannot be exported. Repeated downloads use the same approved content, revision number, and approval date.
4. Select **New revision** to advance the number once and continue with the existing inspection content in an editable draft. Close that draft when it is ready to become the next approved revision. Previous approved revisions remain available for export; removing a photo or comment from a later draft does not change them.

The QC PDF matches the landscape wiring document's cover, header, and footer, with the cover title **450k skid x7 - DCS** and subtitle **QC Report - <Skid name>**. Every page footer places the skid name beside its locked revision number and includes **Approved date**. The cover date, PDF creation metadata, footer date, and filename use the approval timestamp in UTC, so downloading the same revision later does not change its date.

Each documented device, terminal, or equipment item starts on its own page with its name, photos, a large Passed/Failed stamp, and bold red comments. Up to six photos with brief comments fit on one page when space permits; longer records continue without cropping or omitting evidence. The overview lists all 39 names and ratings, including unfinished items.

Photos, comments, quality, and completion are shared across signed-in devices. OCR runs locally using the bundled Tesseract English model. Failed saves show an error and retain the capture for retry; a network connection is required to save shared evidence.

## PRONETA I/O test reports

Open **Test reports** after choosing a named skid. This view imports Siemens PRONETA Basic test-result CSV files, I/O event-log CSV files, and `.mpr` parameter exports. The software name is editable metadata; the importer still expects supported PRONETA file formats.

1. Select **Import test run**. Enter a run name, the software name, and the exact software version used. The default name is Siemens PRONETA Basic; the version starts blank and must be entered before saving. Module firmware is recorded separately and is never substituted for the software version.
2. Choose all exports from the same run in one file selection, including every RIO station. Files are identified from their contents. Result headers establish station identity, while parameter hardware serial numbers and filename stems connect associated files. For renamed log files that cannot be matched, enter the recorded station name beside the file and select **Read files again**.
3. Review the device list. Matching uses station, module slot, physical channel, and symbolic name. Explicit feedback/position/open/close suffixes group supported device tags while preserving distinct `-Y` and `#1/#2` identities. Unassigned channels and unmatched events remain available for review rather than disappearing from the report.
4. Expand **Set parameters** and **Shared module parameters**. The importer reads active configuration records and their selected `Value` fields. It does not substitute `DefaultValue` or duplicate nested submodule copies. Where the export provides an encoded selection without a label dictionary, the exact code is shown and marked as encoded; range or mode descriptions are not guessed.
5. Select **Save test run**. The importing inspector or an administrator can edit or remove it while the skid revision is a draft. Save failures preserve the preview and metadata for retry. Navigation between Test reports and Report retains the local import; save or discard it before switching skids, signing out, or changing the connection.
6. In the saved run's **Setup** section, select **Add setup photos** and choose one or several images of the wiring, instruments, air supply, and other test equipment. Each uploaded photo is saved to that run immediately. Add an optional caption and save it, open a photo to view it larger, or remove an unwanted photo while the revision is a draft.
7. Open **Report**, review the saved content, and **Approve & close**. The same revision locks QC evidence, test runs, setup photos, and captions. **Export test PDF** is then available for the selected run. Its Setup section places the photos and captions before device results, with uncropped images and the skid/revision footer. The closed-revision history also exports all test runs from any approved revision. **New revision** carries the current runs and setup photos into an editable draft; later edits and removals preserve earlier approved reports.

### Test comments

Add an **Overall test run comment** for the selected run, and a **Device comment** beneath each device's graph. Each field supports up to 4,000 Unicode characters and multiple lines. Typing starts a pending edit; select **Save test run** to apply the comments or **Discard changes** to restore the saved text. The importing inspector or an administrator can edit comments while the revision is a draft. Save failures retain them for retry, and source-file rereads preserve comments for matching device identifiers. Comments remain separate from imported tester comments, wiring results, and measurements.

The overall comment belongs only to its test run. Approved snapshots lock both run and device comments, and the test PDF includes them with their respective run summary or device. A new revision allows later changes without altering earlier approved reports.

### Setup photos

A saved test run supports up to 30 setup photos, with captions of up to 1,000 characters. JPEG, PNG, WebP, and browser-decodable HEIC/HEIF files up to 20 MB each use the same image normalization and private storage as inspection photos. Image bytes are stored separately from the normalized CSV/parameter payload. The importing inspector or an administrator can add photos, change captions, or remove photos from a draft. Finish uploads and save or cancel caption edits before approving, switching skids, or signing out. If a batch stops on an error, successful uploads remain saved.

Approved snapshots retain the exact setup-photo references and captions. Archived images remain available even if a later draft removes a photo or its entire test run. Reports created before this feature continue to export without an empty Setup section.

### Results and graphs

`Status Wiring` is the tester-recorded result: `OK` becomes **Passed**, `Error` becomes **Failed**, and `N. a.` remains **Not applicable**, never a pass. An aggregate device fails if any applicable channel failed; otherwise every applicable channel must pass for the device to pass. Missing or unknown results remain **Not tested**. These meanings follow the [Siemens PRONETA Basic manual, Test Results and IO Event Log sections](https://cache.industry.siemens.com/dl/files/624/67460624/att_1347024/v1/PRONETA_Documentation_V3_9_en.pdf), printed pages 59–61.

Each device has one combined graph in the browser and exported PDF, with a colored legend identifying its signals. Signals with matching units share a vertical scale; different units have separate scales, including a 0–1 scale for digital states. Line patterns distinguish signals when colors repeat. Individual channel results, parameters, and original event details remain available.

Graphs show observed after-change values in the exported units, including digital states, mA, V, and temperature. Dots mark the recorded readings. Analog traces connect successive readings with straight lines; digital traces use steps that hold each state until its next recorded change. A dashed horizontal tail carries each final valid reading to the right edge of the graph. Connections and the held tail are display geometry; the original readings and event counts stay intact. Duplicate and same-second events retain their source rows and order. Invalid values break the line and remain visible as raw observations and import notes; a final invalid reading prevents holding the previous value onward. Graphs do not infer an overall functional pass or convert current to valve travel or pressure without calibration.

Positioner (`-POS`), `PD-` and `DP-` current graphs start with a **0–25 mA** vertical range. Celsius graphs start at **20–30 °C**. Valid readings outside those ranges expand the affected axis boundary with extra space; invalid readings do not change the scale. These display defaults apply to both the browser preview and exported PDF without changing saved observations.

The run retains the **earliest through latest valid timestamp across every selected station log** as its overall time span. Each device graph shares one time axis across its signals, automatically fitting their first through last dated observations with a small margin bounded by that run. Dated invalid readings stay inside the fitted range; signals without dated observations do not stretch the device's time axis. A single timestamp gets a short readable window, and short ranges use fewer time labels or milliseconds to avoid repeated labels. Browser previews and PDF graphs use the same scaling without changing recorded timestamps. Naive source timestamps stay on the original computer's clock; the browser's timezone does not shift them. The source-clock/timezone field is descriptive, not a conversion. Logs with explicit timezone offsets use a UTC graph axis, labeled UTC, and retain the original timestamps in their event details. Combining files assumes the source clocks were aligned. Timestamp formats that are ambiguous or unsupported are retained for review; timestamps with explicit offsets cannot be mixed with an unspecified source clock in one run.

### Import storage and limits

Import notes record source limitations and recovery actions. Unquoted commas in log module names are reassembled without dropping the full name or event description. Matching change text at the same channel and timestamp is described as a repeated change, since timestamp precision can conceal separate events; every observation is retained. Earlier saved notes that called these “duplicate I/O events” keep their original text and receive a clarification in the preview and PDF. This does not alter approved revision data. Missing timezone offsets and parameter enum-label dictionaries remain documented source limitations.

Parsing happens in the browser. Saving stores normalized report data privately in Supabase, together with filenames, byte counts, SHA-256 hashes, and original result/event provenance. Original CSV and parameter files are not uploaded to public GitHub or retained as separate server files. Keep the source exports if you need the original files later. Approved snapshots freeze the normalized data, so future parser changes do not reinterpret earlier reports.

Each import accepts up to 20 files, 10 MiB per file, 30 MiB in total, and 10,000 event rows. A normalized run is limited to 4 MiB, with up to 20 active runs per skid. An import belongs to its opening revision; a remote closeout or revision change retains the local preview but blocks saving it into a different revision. Conflicting saved edits require reopening the current run. Source parsing and PDF generation are covered by synthetic tests; private field exports are not committed as fixtures.

## Bulk photo review

Use **Bulk upload photos** on the layout, QC overview, or report screen after selecting a named skid report. Choose all your photos in one file selection, or drop a batch into the dialog. The queue shows one image at a time, including its filename and a zoom control.

1. Review the photo and type its device, terminal, or equipment name. The same inspection catalog is used throughout; typing `B` also selects **Terminal B**. Click a search result or use the arrow keys to choose a match.
2. If a label can be read, the closest supported match appears as an empty field's **placeholder**. Press **Tab** to fill it in, then **Enter** to save. A placeholder alone is never saved.
3. **Enter** or **Save & next** uploads the photo to that item's evidence and automatically opens the next photo with a fresh name field. The selected skid stays fixed for the entire queue.
4. Use **Skip photo** for images you want to handle later. At the end, **Review skipped photos** returns them to the queue; the completion screen distinguishes saved photos from skipped ones.

To rotate a photo, press **Ctrl + <** for 90° left or **Ctrl + >** for 90° right, or use the **Left / Right** buttons. On a US keyboard, these are **Ctrl + Shift + ,** and **Ctrl + Shift + .**. The shortcuts work while typing a name and keep the cursor in that field; Q and E are ordinary letters everywhere. Rotation updates the preview, saved evidence, and OCR orientation while preserving the name you have entered. Skipped photos retain their rotation; each new photo starts in its original orientation.

The name field remains usable while OCR runs, and late OCR results cannot replace a typed or chosen name. Similar tags, suffixes such as `-Y` and `#2`, and ambiguous labels require review. Photos without a readable label can always be assigned manually. JPEG, PNG, WebP, and browser-decodable HEIC/HEIF images are supported, up to 20 MB each. Unsupported or damaged images do not block the rest of a batch.

OCR runs on the device using the existing self-hosted Tesseract worker and English model, without a cloud OCR account or API key. It reads the original image with bounded resolution, uses sparse-label segmentation, and makes one alternate pass when no catalog label is found. Only the current photo is decoded; queued files are processed sequentially, and saved files and previews are released. Shared evidence uses the existing photo compression and upload workflow. Failed saves retain the photo and chosen name for retry; a failed report refresh after a successful upload does not upload the photo twice. Unfinished queues stay in the open dialog, so finish or explicitly discard them before closing the page.

## Voice comments

The microphone tool records between 5 and 90 seconds. After you review the recording, the private voice function sends it to ElevenLabs Audio Isolation, then Scribe v2. The transcript fills the editable comment draft; it is never posted automatically. Audio is not retained by this app.

The [voice setup guide](docs/VOICE-SETUP.md) describes the GitHub environment secrets and deployment. The ElevenLabs key belongs only in server secrets and never in a `VITE_` variable or browser code.

## Project setup

The current public browser configuration points to `ybeinufetluekswsulvj.supabase.co`. Only the project's publishable key is included in the source. Private tables, storage policies, membership checks, and checked database functions control access.

- [Supabase setup and inspector access](supabase/SETUP.md)
- [Database schema](supabase/schema.sql)
- [Closed-revision upgrade](supabase/qc-revisions.sql)
- [PRONETA test-report upgrade](supabase/proneta-test-reports.sql)
- [Read-only deployment verification](supabase/VERIFY.sql)
- [Voice attempt limits](supabase/voice-rate-limit.sql)

The initial administrator is `khuong@jeevyfabrication.com`. Add each inspector to `qa_inspectors` as described in the setup guide. Supabase's default email service has recipient restrictions; configure custom SMTP for a team rollout. The app supports the default sign-in link as well as numeric codes, so custom OTP templates are optional.

The website deployment runs the tests and build, applies the repeatable QC revision and test-report migrations with the existing deployment environment, and verifies database protections before publishing the updated app. The migrations never approve an inspection automatically and preserve existing closed snapshots.

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

Automated tests cover schedule integrity, conservative label matching, the bulk review queue and keyboard controls, OCR cancellation and cleanup, shared data calls, comment removal permissions, approval and immutable revision history, read-only controls, quality, completion prerequisites, photo handling, microphone cleanup, voice validation/order, and PDF coverage/pagination. PRONETA tests cover source parsing, status and channel matching, active parameter selection, shared time domains, invalid/duplicate events, run edit conflicts, immutable snapshots, and approved-only PDF export. Browser checks additionally exercise real OCR, mobile layout, capture, comments, shared updates, and PDF downloads. Physical phone cameras, noisy field audio, and actual two-inspector use should be checked on site.

## Update the cable schedule

The current catalog was extracted from the latest revision-3 Word document, preserving cable 21 for V-3541 and cable 22 for V-3511. The reproducible extraction helper is `scripts/extract-schedule.py`. Review `src/data/schedule.json` and the server's `qa_targets` catalog together when changing devices or terminal groups; stable record keys preserve the evidence associations.

Noto Sans fonts are distributed under the included [SIL Open Font License](public/assets/NotoSans-OFL.txt).
