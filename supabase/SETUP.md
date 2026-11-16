# Shared inspection setup

The static GitHub Pages app uses Supabase Auth, PostgreSQL, private Storage, and Realtime. Every signed-in, allowlisted inspector sees the same shared report, based on the revision-3 source schedule. Project data and inspection photos are protected by database policies; the browser receives only a public publishable/anon key.

## 1. Install the database

Use a dedicated Supabase project. In its SQL Editor, run the entire [`schema.sql`](./schema.sql), then [`VERIFY.sql`](./VERIFY.sql). The schema seeds 28 devices and terminals A–H from the revision-3 schedule. Running it again preserves existing inspection records, photos, and comments.

To upgrade an existing deployment, run [`report-revisions.sql`](./report-revisions.sql). It preserves current data as baseline report revision 3 and installs the revision counter and triggers. Subsequent saves advance the shared report revision. Run this migration before the current [`walkdown-comments.sql`](./walkdown-comments.sql) if upgrading an older installation; rerunning either migration preserves the current revision.

Check the verification output: 28 devices, 8 terminals, 36 records, one project metadata row with revision at least 3, five revision triggers, private bucket, enabled admin, RLS enabled, and all browser write/anonymous access columns false. The `qa_*` public functions must have an empty `search_path`. Check for unexpected existing Storage policies; permissive policies are combined, so a broad older policy can bypass this project's restrictions.

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

1. Add a photo and a comment on one device. Confirm both appear on the other device after refresh/synchronization. Each comment must retain its author and timestamp.
2. Confirm a device cannot be completed without a photo. Complete a device with its own evidence.
3. Confirm a terminal requires its own photo plus every assigned device completed.
4. Remove evidence as its photographer or the administrator. Confirm the device and its parent terminal reopen on both devices. Another inspector cannot delete someone else's photo.
5. Sign in with an email absent from the allowlist. Access must be denied. Test the public Storage URL for a real photo in a signed-out browser; it must not return the image. A time-limited signed URL is a different, intentionally authorized link.
6. Revoke a test inspector with the SQL above. Confirm the next refresh and new photo requests fail, then restore their allowlist entry if appropriate.

Local adapter tests run with `npm test`. The schema logic was also executed with PostgreSQL-compatible PGlite and minimal Auth/Storage table stubs, including nonmember access, mutation privileges, evidence requirements, completion dependencies, append-only comments, and deletion reopening. That local check does not replace hosted Auth, SMTP, Storage upload, Realtime, or two-device verification.

## Operating behavior

- The shared report starts at revision 3. Saving a comment, finalized photo, photo removal, completion/reopen, or quality assessment advances it once per database transaction. A photo removal that also reopens its device and terminal advances once. Pending or canceled uploads, drafts, OCR, voice processing, refreshes, and exporting an unchanged report do not advance it. The source schedule/reference PDF remains revision 3.
- Comments are append-only. Corrections are new comments, preserving author and server timestamp.
- Each device and terminal has one shared Quality value: Good, Bad, or unrated. Selecting one excludes the other; clearing it returns to unrated. The latest change, including a clear, records the inspector and server timestamp. Quality changes preserve evidence completion.
- Any active inspector can add evidence/comments and complete or reopen an item. Only the photographer or administrator can remove a photo.
- Uploads reserve metadata before sending bytes, then finalize after the server finds the private object. Pending uploads never count as evidence.
- Removing a saved photo reopens the record and parent terminal before Storage deletion. If cleanup fails, the app reports the failure; retry removal by the same photo ID or ask the administrator to remove the tombstoned file in Storage.
- Completion and evidence changes are serialized by a database transaction lock for this small shared workspace. Terminal completion checks the server's canonical device catalog.
- Realtime sends refresh notifications; periodic and focus/reconnect refreshes recover missed notifications. Concurrent comments/photos append instead of overwriting another inspector's work.

After an interrupted upload, an administrator can inspect old pending or removed uploads:

```sql
select id, record_key, path, upload_state, created_at, created_by, deleted_at
from public.qa_photos
where (upload_state = 'pending' and created_at < now() - interval '1 day')
   or deleted_at is not null
order by created_at;
```

Do not delete active evidence objects directly in the dashboard. Use the app removal action so completion is reopened. Storage deletes done with administrative credentials bypass the application's policies; [`VERIFY.sql`](./VERIFY.sql) detects completed records whose evidence is missing. Never delete rows directly from `storage.objects`; use the Storage UI/API for physical object cleanup.
