# Shared inspection setup



The static GitHub Pages app uses Supabase Auth, PostgreSQL, private Storage, and Realtime. Every signed-in, allowlisted inspector sees the same named skid walkdowns. Each skid has independent evidence, notes, quality, completion, and revisions, based on the shared revision-3 source schedule. Project data and inspection photos are protected by database policies; the browser receives only a public publishable/anon key.



## 1. Install the database



Use a dedicated Supabase project. In its SQL Editor, run the entire [`schema.sql`](./schema.sql), then [`VERIFY.sql`](./VERIFY.sql). The schema seeds 28 devices, terminals A–H, and three equipment targets: Control Box, Solenoid Box, and Transducer Panel. Running it again preserves existing inspection records, photos, and comments.



To upgrade an existing named-walkdown deployment, install [`equipment-inspections.sql`](./equipment-inspections.sql) if the equipment catalog is not already present, then run [`qc-revisions.sql`](./qc-revisions.sql), [`proneta-test-reports.sql`](./proneta-test-reports.sql), and `VERIFY.sql`. The revision migration preserves all inspection data and current revision numbers, leaves previously unapproved reports as editable drafts, and adds approval, closeout, immutable revision history, and comment removal. The test-report migration adds private PRONETA runs to that same revision lifecycle. No existing report is approved automatically. Rerunning the migrations preserves closed revisions, including old snapshots that have no test runs. The current `schema.sql` includes the same changes for new installations.

For database deployment through GitHub Actions, `SUPABASE_ACCESS_TOKEN` needs **Database: Read-write** on this project. A token limited to Edge Functions/Secrets cannot apply this migration. Replace the GitHub environment secret with a newly scoped token if Supabase returns `403` with `database_read` missing; existing token scopes cannot be edited. See [Supabase token permissions](https://supabase.com/docs/guides/platform/personal-access-tokens).

To upgrade the older single-report deployment, run [`named-walkdowns.sql`](./named-walkdowns.sql), then `equipment-inspections.sql`, `qc-revisions.sql`, `proneta-test-reports.sql`, and `VERIFY.sql`. The first migration atomically moves all existing inspection data into **Unassigned skid**, preserving IDs, photo paths, timestamps, status, and its previous revision. An inspector must manually rename that skid before adding evidence, comments, quality, completion, or voice drafts. New skids require unique names of 1–120 characters and start with 39 empty inspection rows at report revision 1 after the revision migration. Names are unique without regard to case; IDs remain stable after renaming.



The named-walkdowns migration revokes every old unscoped RPC overload. Deploy the updated frontend and voice function with these migrations; stale browser tabs must refresh. After this upgrade, use the current main schema or `qc-revisions.sql` for maintenance. Do not rerun earlier migrations after installing revision closeout. The older `report-revisions.sql`, `walkdown-comments.sql`, and `voice-rate-limit.sql` stop with an error if named skids already exist, preventing accidental reintroduction of unscoped access.



Check the verification output: 28 catalog devices, 8 terminals, 3 equipment targets with NULL terminals, 39 records **per walkdown**, positive revision numbers, draft/closed status, preserved closed snapshots, a private evidence bucket, enabled admin, RLS enabled, and all browser write/anonymous access columns false. A fresh installation has no walkdowns until an inspector creates one. Current `qa_*` functions must have an empty `search_path`; old unscoped overloads must show no authenticated execute privilege. Review unexpected Storage policies: permissive policies are combined, so a broad older policy can bypass this project's restrictions.



The initial administrator is `khuong@jeevyfabrication.com`. Add each inspector using the SQL Editor, replacing the example address and display name:



```sql

insert into public.qa_inspectors (email, display_name)

values ('inspector@example.com', 'Inspector Name')

on conflict (email) do update

set display_name = excluded.display_name, active = true;

```



To revoke an inspector:



```sql

update public.qa_inspectors

set active = false

where email = 'inspector@example.com';

```



An existing signed-in session loses database and Storage access on its next request. A previously issued photo URL can remain usable for at most 10 minutes. Signed URLs should be treated as temporary access links. [Supabase private Storage documentation](https://supabase.com/docs/guides/storage/serving/downloads).



## 2. Enable email sign-in



In Authentication settings:



1. Enable the Email provider, email confirmation, and new user registration. Unlisted users can verify their own email but cannot read or modify this workspace.

2. Set the Authentication Site URL and an allowed redirect URL to `https://khuongnguyen99.github.io/DCS-QA-Report/`. The app accepts the default email sign-in links. If your SMTP setup permits template editing and you prefer codes, optionally set **Confirm signup** and **Magic Link** email templates to show `{{ .Token }}`. For example:



   ```html

   <h2>DCS inspection sign-in</h2>

   <p>Enter this code in the inspection app:</p>

   <p style="font-size:28px;font-weight:bold">{{ .Token }}</p>

   <p>If you did not request this code, ignore this email.</p>

   ```



3. Configure a custom SMTP provider for inspector email delivery. Supabase's built-in mail service only sends to addresses belonging to the Supabase project team and has restrictive rate limits. An allowlist entry in `qa_inspectors` does not make that address a Supabase project-team member. [SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).

4. Test both a new and returning inspector. The app automatically reads the authenticated session after following a sign-in link. It also accepts numeric codes with `verifyOtp({ type: 'email' })` when a code is included. [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [email OTP flow](https://supabase.com/docs/guides/auth/auth-email-passwordless).



The app accepts 6–10 digit OTP codes. Keep Supabase's configured OTP length in that range. Do not put SMTP credentials or a Supabase secret/service-role key in the app or repository.



## 3. Connect the static app



Copy the project's HTTPS URL and **publishable key** from Supabase Project Settings. A legacy **anon** key also works. Set the public app configuration, either through its setup screen or at build time:



```dotenv

VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co

VITE_SUPABASE_ANON_KEY=sb_publishable_YOUR_PUBLIC_KEY

```



For a local build, put these values in `.env.local` and run `npm run build`. GitHub Actions builds need the same public values in their build environment. Vite variables are embedded in the downloaded JavaScript; their access is intentionally limited by the database policies. The adapter rejects secret and service-role keys.



All inspectors must use the same project URL. With no configuration, the app can show the schedule but cannot save shared inspections. Authentication, uploads, and synchronization require an internet connection.



## 4. Verify with two inspectors before field use



Sign in with two allowlisted accounts on separate devices. Use a test inspection photo, then remove it after the checks:



1. Create two explicitly named test skids. Select the same skid on both devices, add a photo and a comment, and confirm the other skid stays empty. Confirm both appear on the other device after refresh/synchronization. Each comment must retain its author and timestamp.

2. Confirm a device cannot be completed without a photo. Complete a device with its own evidence.

3. Confirm a terminal requires its own photo plus every assigned device completed.

4. Remove evidence as its photographer or the administrator. Confirm the device and its parent terminal reopen on both devices. Another inspector cannot delete someone else's photo.

5. Sign in with an email absent from the allowlist. Access must be denied. Test the public Storage URL for a real photo in a signed-out browser; it must not return the image. A time-limited signed URL is a different, intentionally authorized link.

6. Revoke a test inspector with the SQL above. Confirm the next refresh and new photo requests fail, then restore their allowlist entry if appropriate.



Run `npm test` for adapter and executable PostgreSQL-compatible PGlite migration tests. These use minimal Auth/Storage stubs to verify preservation of legacy evidence, two-skid isolation, independent revisions, immutable approval snapshots, locked-write rejection, stale-revision rejection, comment removal permissions, unnamed/invalid write rejection, old RPC privilege revocation, nonmember access denial, completion dependencies, deletion reopening, and safe schema reruns. That local check does not replace hosted Auth, SMTP, Storage upload, Realtime, or two-device verification.



## Operating behavior



- New skid reports start at revision 1; existing reports retain their revision number during the upgrade. Changes within an editable draft do not advance its number. **Approve & close** saves an immutable snapshot with approval metadata and locks all report edits. **New revision** advances the number once and carries the current content into an editable draft. Earlier approved revisions remain exportable. The source schedule/reference PDF remains revision 3.

- A comment’s author or the administrator can remove it while the report is a draft. Removal preserves the database audit record and does not alter comments captured in an approved revision. Closed revisions cannot be edited.

- Imported test runs live in `qa_test_runs` under RLS and have no direct browser write grants. `qa_save_test_run` and `qa_delete_test_run` require the selected skid, expected report revision, and expected run version. The importing inspector or an administrator can edit/remove a run. Identical save retries with the same stable ID are idempotent. Soft removal preserves audit metadata and does not alter archived snapshots. Software name/version are required; normalized payloads are limited to 4 MiB and 20 active runs per skid.

- The test-report importer stores selected parameter values, recorded wiring results, source provenance, warnings, and event series. Approval freezes the complete normalized payload in the existing `qa_report_revisions` snapshot. `qa_list_revisions` exposes a test-run count so historical test PDFs remain accessible after later edits/removals. No separate revision counter or automatic pass evaluation is introduced.

- Each equipment item, device, and terminal has one shared Quality value: Passed, Failed, or unrated. The stored values remain `good`, `bad`, or `null` for compatibility. Selecting one excludes the other; clearing it returns to unrated. The latest change, including a clear, records the inspector and server timestamp. Quality changes preserve evidence completion.

- Any active inspector can add evidence/comments and complete or reopen an item. Only the photographer or administrator can remove a photo.

- Uploads reserve metadata before sending bytes, then finalize after the server finds the private object. Pending uploads never count as evidence.

- Removing a saved photo from a draft reopens its record and, for field devices, its parent terminal. Objects used by an approved revision remain in private Storage; only unreferenced objects are eligible for deletion. Equipment remains independent of terminal completion. If cleanup fails, the app reports the failure; retry removal by the same photo ID or ask the administrator to remove the tombstoned file in Storage.

- Completion and evidence changes are serialized by a database transaction lock for that skid. Different skids can be edited independently. Terminal completion checks the server's canonical device catalog.

- Approval checks the revision and content version being reviewed. New revisions and writes reject stale revision numbers, and the database serializes changes with approval so a closed snapshot cannot change. Only closed snapshots can be exported.

- Realtime sends refresh notifications; periodic and focus/reconnect refreshes recover missed notifications. Concurrent comments/photos append instead of overwriting another inspector's work.



After an interrupted upload, an administrator can inspect old pending or removed uploads:



```sql

select id, walkdown_id, record_key, path, upload_state, created_at, created_by, deleted_at

from public.qa_photos

where (upload_state = 'pending' and created_at < now() - interval '1 day')

   or deleted_at is not null

order by created_at;

```



Do not delete active evidence or objects referenced by an approved revision directly in the dashboard. Use the app removal action so completion is reopened. Storage deletes done with administrative credentials bypass the application's policies; [`VERIFY.sql`](./VERIFY.sql) detects completed records whose evidence is missing. Never delete rows directly from `storage.objects`; use the Storage UI/API for physical object cleanup.

