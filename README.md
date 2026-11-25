# Jeevy DCS Field QC

Shared field inspection for **450k Skid x7 - DCS**. The app is a mobile-friendly static website on GitHub Pages with a private Supabase workspace and the revision-3 device schedule.

## Inspection workflow

1. Sign in with an approved inspector email. Open the email's sign-in link, or enter its code if one is included.
2. Create a **New skid report** and enter its skid name, or select an existing report. Each skid has separate photos, comments, quality, completion, and revision. Existing pre-skid data is preserved as **Unassigned skid** and must be named before continuing.
3. In the opened report, enter **Checked by** and select **Save checked by**. This is a separate required step after creation; the new-report dialog asks only for the skid name. Photos, comments, quality/completion changes, and test-run entry remain unavailable until the checker is saved.
4. Tap A–H or **Control Box**, **Solenoid Box**, or **Transducer Panel** on the conduit layout, or use **QC overview** for all 39 inspection items: 28 field devices, 8 terminals, and 3 equipment items. Equipment also has its own cards below the map and an **Equipment only** overview filter.
5. Scan a device label, use **Enter device name** to search and choose a scheduled device, or open its row. Manual entry is also available inside the scanner. Label matching tolerates surrounding text such as `OV-3541F` and `*V-3541#`; ambiguous matches need your selection.
6. Capture or upload evidence photos and add comments. Each terminal also has its own evidence record. Use **Flashlight** in the camera to toggle the rear-camera torch when your phone/browser supports it; closing the camera turns it off.
7. Choose **Passed** or **Failed** in the camera, record, or overview table. Quality saves immediately and stays in sync across those screens. The checkboxes are mutually exclusive; clicking the selected choice clears it.
8. Review evidence and mark QC complete. A terminal turns green after its own evidence and all its devices are complete. On its terminal page, **Mark complete** below **Inspect terminal** saves terminal QC directly once those prerequisites are met.
9. Open **Report**, review the saved inspection, then select **Approve & close**. This locks that revision and enables its PDF export. Use **New revision** to continue editing a draft based on the closed revision. Earlier approved revisions remain available for download.

**Documented** in the overview means at least one saved photo. It is separate from quality and completed QC review. Comments are optional. In an open draft, a comment’s author or the administrator can select **Remove**, then confirm **Remove comment**. Closed revisions preserve their approved comments. Unposted comment drafts stay with their skid when switching reports and survive camera navigation until posted, the page is reloaded, or the inspector signs out.

Each equipment inspection has its own photos, typed/voice comments, quality, and completion for the selected skid. Completing equipment requires its own saved photo and does not complete any field device or terminal. Overall progress and **Complete inspection** include all 39 items. Equipment appears in PDF coverage and gets the same compact evidence pages as devices and terminals.

Use **General walkdown comments** on the layout or report screen for notes about the whole inspection. Typed and voice notes are shared with the team and included in their own PDF section.

## Approve, close, and revise

Each skid has an editable **Draft** or a locked **Closed** revision. New reports begin at revision 1. Existing reports keep their current number when upgraded and remain drafts until an inspector explicitly approves them. Saving photos, comments, quality, completion, test runs, or a skid name does not advance the revision.

**Checked by** is a manually entered name, required for each draft revision. It can be corrected on the **Report** screen before approval. The database enforces the requirement for evidence writes and approval, records which signed-in inspector saved the name and when, and rejects conflicting name changes. **Signed off by** is filled automatically from the inspector who approves and closes the revision, including their job title when available. Both fields appear on the QC and Test Result PDF covers. Existing approved reports keep their original snapshots; if no checker was recorded, their cover says **Not recorded**. Existing draft evidence and pending local test changes are retained while the checker requirement is completed.

1. Finish uploads and save any comments you want included. Review the current shared report.
2. Select **Approve & close**. The server saves an immutable snapshot of the skid name, checker, inspection catalog, evidence, comments, quality, completion, and imported test runs, together with the approving inspector and approval time. Test runs include software details, recorded results, selected parameters, source identifiers, import notes, and graph observations. The report becomes read-only. Approval is an explicit report-level decision; unfinished inspection items remain visible in the report. Save or discard local test-import changes before approving.
3. Export the closed revision as a PDF. Draft reports cannot be exported. Repeated downloads use the same approved content, revision number, and approval date.
4. Select **New revision** to advance the number once and continue with the existing inspection content in a draft. Enter **Checked by** for the new revision before making changes, then close it when it is ready to become the next approved revision. Previous approved revisions retain their checker and sign-off and remain available for export; removing a photo or comment from a later draft does not change them.

The QC PDF matches the landscape wiring document's cover, header, and footer, with the cover title **450k skid x7 - DCS** and subtitle **QC Report - <Skid name>**. Every page footer places the skid name beside its locked revision number and includes **Approved date**. The cover date, PDF creation metadata, footer date, and filename use the approval timestamp in UTC, so downloading the same revision later does not change its date.

Each documented device, terminal, or equipment item starts on its own page with its name, photos, a large Passed/Failed stamp, and bold red comments. Up to six photos with brief comments fit on one page when space permits; longer records continue without cropping or omitting evidence. The overview lists all 39 names and ratings, including unfinished items.

Photos, comments, quality, and completion are shared across signed-in devices. OCR runs locally using the bundled Tesseract English model. Failed saves show an error and retain the capture for retry; a network connection is required to save shared evidence.

## PRONETA I/O test reports

Open **Test reports** after choosing a named skid and saving **Checked by** for the draft. This view imports Siemens PRONETA Basic test-result CSV files, I/O event-log CSV files, and `.mpr` parameter exports. The software name is editable metadata; the importer still expects supported PRONETA file formats.

1. Select **Import test run**. Enter a run name, the software name, and the exact software version used. The default name is Siemens PRONETA Basic; the version starts blank and must be entered before saving. Module firmware is recorded separately and is never substituted for the software version. **Source clock / timezone** offers a compact list of UTC offsets such as **UTC-06:00**, **UTC+00:00**, and **UTC+05:30**, including half-hour and quarter-hour offsets. New imports automatically select this computer's current offset; choose the offset used during the test if it was recorded elsewhere or under a different daylight-saving setting. Saved runs and recovered drafts keep their existing selection, including older descriptive timezone labels. Selecting an offset describes the source clock and does not shift timestamps or graphs.
2. Choose all exports from the same run in one file selection, including every RIO station. Files are identified from their contents. Result headers establish station identity, while parameter hardware serial numbers and filename stems connect associated files. For renamed log files that cannot be matched, enter the recorded station name beside the file and select **Read files again**.
3. Review the device list. Matching uses station, module slot, physical channel, and symbolic name. Explicit feedback/position/open/close suffixes group supported device tags while preserving distinct `-Y` and `#1/#2` identities. Unassigned channels and unmatched events remain available for review rather than disappearing from the report.
4. Expand **Set parameters** and **Shared module parameters**. The importer reads active configuration records and their selected `Value` fields. It does not substitute `DefaultValue` or duplicate nested submodule copies. Where the export provides an encoded selection without a label dictionary, the exact code is shown and marked as encoded; range or mode descriptions are not guessed.
5. Select **Save test run**. The importing inspector or an administrator can edit or remove it while the skid revision is a draft. Save failures preserve the preview and metadata for retry. Navigation between Test reports and Report retains the local import; save or discard it before switching skids, signing out, or changing the connection.
6. In the saved run's **Setup** section, select **Bulk upload photos** to choose or drop several images of the wiring, instruments, air supply, and other test equipment. Review each image, enter an optional caption, and select **Save & next**. The image and caption are saved together to the selected run. Rotate or enlarge an image, skip it, or return to skipped photos before closing the queue. **Add setup photos** remains available for quick uploads; captions can also be added or edited afterward.
7. Open **Report**, review the saved content, and **Approve & close**. The same revision locks QC evidence, test runs, setup photos, and captions. **Export test PDF** is then available for the selected run. Its Setup section places the photos and captions before device results, with uncropped images and the skid/revision footer. The closed-revision history also exports all test runs from any approved revision. **New revision** carries the current runs and setup photos into an editable draft; later edits and removals preserve earlier approved reports.

### Test comments

Add an **Overall test run comment** for the selected run, and one **Device comment** beneath each device's graphs. Each field supports up to 4,000 Unicode characters and multiple lines. Typing starts a pending edit; select **Save test run** to apply the comments or **Discard changes** to restore the saved text. The importing inspector or an administrator can edit comments while the revision is a draft. Save failures retain them for retry, and source-file rereads preserve comments for matching device identifiers. Comments remain separate from imported tester comments, wiring results, and measurements.

Pending comments are cached in this browser for the signed-in inspector, backend project, skid, revision, and test run. Refreshing or reopening the browser restores them as unsaved edits. **Save test run** applies them to the shared report; **Discard changes** clears the local draft. Failed saves keep the cache. If the saved run or revision has changed, the recovered text stays available for review and copying without overwriting newer evidence. Comments on a new or replaced import can also be recovered; reselect the original source files to restore its evidence before saving. The app reports when browser storage is blocked or full.

The overall comment belongs only to its test run. Approved snapshots lock both run and device comments, and the test PDF includes them with their respective run summary or device. A new revision allows later changes without altering earlier approved reports.

### Setup photos

A saved test run supports up to 30 setup photos, with captions of up to 1,000 characters. JPEG, PNG, WebP, and browser-decodable HEIC/HEIF files up to 20 MB each use the same image normalization and private storage as inspection photos. Image bytes are stored separately from the normalized CSV/parameter payload. The importing inspector or an administrator can add photos, change captions, or remove photos from a draft. Finish uploads and save or cancel caption edits before approving, switching skids, or signing out. If a batch stops on an error, successful uploads remain saved.

The bulk review queue works like Conduit layout's photo review, with a manually entered caption for each test image. Only **Save & next** uploads the current image. Captions stay with their images when rotating, skipping, reviewing skipped photos, or retrying a failed save. A failed image can be skipped so the rest of the batch can continue. The queue stays attached to its opening skid, test run, and revision; closing with unsaved or skipped photos requires an explicit discard. The same saved captions and photo order appear in the test PDF after approval.

Drag a photo onto another photo. The app saves each move immediately and uses the saved order in the PDF. This works in test setup and in the inspection galleries for devices, terminals, and equipment. To change the order after a report is approved, start a new revision.

Approved snapshots retain the exact setup-photo references and captions. Archived images remain available even if a later draft removes a photo or its entire test run. Reports created before this feature continue to export without an empty Setup section.

### Results and graphs

`Status Wiring` is the tester-recorded result: `OK` becomes **Passed**, `Error` becomes **Failed**, and `N. a.` remains **Not applicable**, never a pass. An aggregate device fails if any applicable channel failed; otherwise every applicable channel must pass for the device to pass. Missing or unknown results remain **Not tested**. These meanings follow the [Siemens PRONETA Basic manual, Test Results and IO Event Log sections](https://cache.industry.siemens.com/dl/files/624/67460624/att_1347024/v1/PRONETA_Documentation_V3_9_en.pdf), printed pages 59–61.

Each device shows a separate graph for every recorded signal in the browser and exported PDF. All graphs within a device share the same horizontal time span, so command, feedback, and position changes line up in time. Each graph is labeled with its signal name and unit and keeps its own vertical scale. Digital states use a 0–1 scale. One device comment covers all of that device's graphs. Individual channel results, parameters, and original event details remain available.

The Test Result PDF uses the QC report cover layout. Each device starts on its own page, with multiple graphs arranged side by side. Longer results continue onto the next page.

Use the two handles in **Device time axis** to choose a start and end time, then select **Apply time range**. The slider and all graphs automatically share the earliest start through the latest end across the selected device's signals, including their display margins, and update together when events are removed or restored. An existing manual interval remains available until reset. A focused handle also supports the arrow keys. That range applies to every graph for the selected device and to its PDF graphs. Labels use the source clock, or UTC for logs with explicit timezone offsets. **Reset to auto** restores the shared automatic time range for the device. Other devices retain their own ranges. The view setting is cached locally for the project, inspector, skid, revision, run, and device, and can be changed on approved reports. It does not save pending comments or change the recorded evidence. Manual views show how many recorded values are visible; event details retain the complete source rows.

Open **Arrange graphs** to choose the signal order within a device. Drag a signal in the list, or use **Move up** and **Move down**. The browser and exported PDF follow that order, including when a device has multiple signals from the same channel. **Reset graph order** restores the original order. The preference is saved in this browser for the inspector, skid, revision, run, and device; it also carries into the next draft revision. Ordering is available on approved reports and does not alter measurements, event rows, or approval status. Signals added later appear after the saved order, and every graph continues to use the shared device time axis.

Use **Rename device** to change a device's display name. Open **Graph tools** on an individual graph to change its **Graph display name**, for example `V-3511-Y-FB` to `V-3511-Y_FB`. Apply the name, then select **Save test run**. Original source tags remain visible and continue to identify the recorded evidence. **Use source device name** or **Use source graph name** restores the original display name.

Each graph's **Graph style** offers **Automatic**, **Line**, **Step**, and **Smooth**. Automatic uses the existing digital/feedback step defaults; Line connects readings directly, Step holds each reading until the next change, and Smooth draws a curve through the readings without overshooting their local values. The browser and PDF use the same selected style and shared device time span. Drawing styles do not change measurements or calculation results.

To measure elapsed time, open **Graph tools** and select **Add duration calculation**:

1. Enter a **Calculation name** and choose seconds, minutes, or hours.
2. Set **Start time source** and **End time source** independently. **Picked graph point** lets you choose a source graph and select one of its original recorded dots with the mouse or keyboard. **Manual time** accepts the full source date and time, including milliseconds. **Graph threshold** lets you choose any signal in the same test run, including another device, and compare its recorded value using `>`, `>=`, `<`, or `<=`.
3. Review the resolved endpoints and duration, then select **Add calculation** and **Save test run**. For example, the start can be another graph's first reading at or above 0.3 V, and the end can be a dot selected on the current graph. Add further named calculations as needed; each graph supports up to 20.

Under **Graph threshold**, select **Pick start point from selected graph** or **Pick end point from selected graph** to choose an exact event instead of a value comparison. The preview shows that source graph within the current **Device time axis**. Choose a dot, or select an event from **Start recorded point** / **End recorded point** and use the selected point. The list includes the source row and event number so overlapping readings can be distinguished. Choosing an event switches that endpoint to **Picked graph point**; canceling the picker retains the threshold settings. The calculation stays on its original graph, and its two endpoints can reference different graphs or devices.

New or edited graph thresholds search only within the displayed **Device time axis** of the device containing the calculation, including when the selected source graph belongs to another device. Set the interval and select **Apply time range** before applying the calculation. Both time boundaries are included. A start trigger uses the first retained, valid recorded reading inside that window that satisfies the condition. An end trigger additionally requires the matching reading to occur at or after the resolved start. The calculation saves this search window so reopening the report or exporting its PDF produces the same result. To use a different window for a saved calculation, set the new device interval, edit the calculation, select **Update calculation**, then **Save test run**. Older calculations retain their original full-run search until edited and updated.

Initial display baselines, connecting lines or curves, and held tails are not recorded trigger readings or selectable points. Manual timestamps use the source clock (UTC for explicitly offset logs) and must fall within the test run. Equal start and end times produce zero; reversed intervals cannot be applied. Missing trigger matches within the saved search window, removed selected points, or unavailable source graphs show an explicit unresolved explanation. Changing a device's visible time range alone does not change saved calculations or source evidence.

Applied calculations also appear directly on the graph as a name and result, such as **Open Time: 109 s**, above a horizontal interval arrow with dashed endpoint guides. Multiple calculations have separate label rows. The automatic device time span includes their resolved endpoints, including triggers from another graph, so every graph in the device stays aligned and the full interval is visible. A manual time range remains in effect until reset; continuation marks indicate endpoints outside that view. Unresolved calculations show a compact status instead of an invented interval.

Display names, graph styles, and calculation definitions are shared test-run content. Pending applied changes are recovered with other local test edits; finish or cancel an open name/calculation editor before saving, switching runs or devices, or approving the report. **Save test run** persists the settings, approval freezes them in that revision, and a new draft revision retains them for further editing after its checker is saved. The Test Result PDF includes the graph annotations and calculation tables containing only **Name** and **Result**. Endpoint timestamps, trigger rules, and source references remain available in the app's calculation details. Re-reading source files retains settings and flags missing references; it does not silently assign calculations to different readings.

Open **View recorded events** and select **Remove** to exclude a row from its graph immediately. Removed rows retain their original values and source references under **Removed events**, where **Restore** includes them again. These edits are cached locally with pending comments and remain pending until **Save test run**. A recovered unsaved import requires its original source files before edits can be restored. Owners and administrators can edit open reports; approved revisions retain their saved exclusions. PDFs show the updated graphs and list removed events separately for review.

Graphs show observed after-change values in the exported units, including digital states, mA, V, and temperature. Dots mark the recorded readings. In Automatic style, digital traces and feedback tags ending in `_FB` or `-FB` use steps that hold each recorded value until the next reading, then change vertically; other analog traces connect successive readings with straight lines. Feedback voltage graphs start at **0.0 V** before their first valid recorded reading, with the initial level included in the vertical scale. A later manual time window carries the preceding recorded value instead of restarting at zero. Feedback graphs keep their measured values and units. This applies to the browser and exported PDF. A dashed horizontal tail carries each final valid reading to the right edge of the graph. The initial baseline, connections, and held tail affect the graph display; the original readings and event counts stay intact. Duplicate and same-second events retain their source rows and order. Invalid values break the line and remain visible as raw observations and import notes; a final invalid reading prevents holding the previous value onward. Graphs do not infer an overall functional pass or convert current to valve travel or pressure without calibration.

Positioner (`-POS`), `PD-` and `DP-` current graphs start with a **0–25 mA** vertical range. Celsius graphs start at **20–30 °C**. Valid readings outside those ranges expand the affected axis boundary with extra space; invalid readings do not change the scale. These display defaults apply to both the browser preview and exported PDF without changing saved observations.

The run retains the **earliest through latest valid timestamp across every selected station log** as its overall time span. Each device's automatic time range covers all of its signals' dated observations and their small display margins, bounded by that run. Every graph in the device uses those same start and end times. Dated invalid readings stay inside the shared range; excluded events do not enlarge it. Signals without dated observations use the device's shared range, and a device without any dated observations falls back to the run span. A single timestamp gets a short readable window, and short ranges use fewer time labels or milliseconds to avoid repeated labels. Browser previews and PDF graphs use the same scaling without changing recorded timestamps. Naive source timestamps stay on the original computer's clock; the browser's timezone does not shift them. The source-clock/timezone field is descriptive, not a conversion. Logs with explicit timezone offsets use a UTC graph axis, labeled UTC, and retain the original timestamps in their event details. Combining files assumes the source clocks were aligned. Timestamp formats that are ambiguous or unsupported are retained for review; timestamps with explicit offsets cannot be mixed with an unspecified source clock in one run.

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
