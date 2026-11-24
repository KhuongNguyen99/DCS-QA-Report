import { createClient } from "@supabase/supabase-js";

const BUCKET = "qa-evidence";
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_TEST_RUN_BYTES = 4 * 1024 * 1024;
export const MAX_TEST_RUNS = 20;
const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PHOTO_COLUMNS =
  "id,walkdown_id,record_key,path,name,width,height,created_at,created_by";

function fail(error, action) {
  if (error)
    throw new Error(`${action}: ${error.message || String(error)}`, {
      cause: error,
    });
}

function validateEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("Enter a valid inspector email address.");
  }
  return email;
}

function validateRecordKey(value) {
  if (
    typeof value !== "string" ||
    !/^(terminal:[A-H]|device:[A-Z]{1,4}-\d{4}(?:#[1-9]\d*|-Y)?|equipment:(?:control-box|solenoid-box|transducer-panel))$/.test(value)
  ) {
    throw new Error("Choose an inspection target from the project schedule.");
  }
  return value;
}

function validateWalkdownId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Choose a named skid walkdown first.");
  }
  return value.toLowerCase();
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Refresh the report and select its current revision before making changes.");
  return value;
}

function validateCheckedBy(value) {
  if (typeof value !== "string")
    throw new Error("Enter a name for Checked by between 1 and 120 characters.");
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    throw new Error("Enter a name for Checked by between 1 and 120 characters, without line breaks or control characters.");
  return name;
}

function validateTestRunId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Choose a valid imported test run.");
  return value.toLowerCase();
}

function validateSetupPhotoCaption(caption) {
  if (typeof caption !== "string" || caption.length > 1000 || caption.includes("\u0000"))
    throw new Error("Keep the setup photo caption within 1,000 characters.");
  return caption.trim();
}

function validatePhotoOrder(value, kind, max) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Provide the complete ${kind} order, with at most ${max} photos.`);
  const ids = Array.from(value, id => validateEvidenceId(id, kind).toLowerCase());
  if (new Set(ids).size !== ids.length)
    throw new Error(`Include each ${kind} exactly once in the order.`);
  return ids;
}

function testRunPayload(run) {
  if (!run || typeof run !== "object" || Array.isArray(run))
    throw new Error("Import the test files before saving a run.");
  const { id, walkdownId, runVersion, createdAt, createdBy, updatedAt, updatedBy, deletedAt, deletedBy, setupPhotos, ...data } = run;
  if (data.schemaVersion !== 1 || typeof data.name !== "string" || !data.name.trim() || data.name.length > 160)
    throw new Error("Enter a test run name between 1 and 160 characters.");
  if (typeof data.software?.name !== "string" || !data.software.name.trim() || data.software.name.length > 120
    || typeof data.software?.version !== "string" || !data.software.version.trim() || data.software.version.length > 80)
    throw new Error("Enter the test software name and version before saving the test run.");
  for (const item of [data, ...(Array.isArray(data.devices) ? data.devices : [])]) {
    if (item && Object.hasOwn(item, "comment") && (typeof item.comment !== "string"
      || Array.from(item.comment).length > 4000 || item.comment.includes("\u0000")))
      throw new Error("Keep test run and device comments to text of at most 4,000 characters.");
  }
  const seen = new WeakSet();
  function check(value) {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Test measurements must use finite numbers or explicit missing values.");
    if (value && typeof value === "object") {
      if (seen.has(value)) throw new Error("The test run contains a circular data reference.");
      seen.add(value);
      for (const child of Object.values(value)) check(child);
      seen.delete(value);
    }
  }
  check(data);
  const channels = [
    ...(Array.isArray(data.devices) ? data.devices.flatMap(device => Array.isArray(device?.channels) ? device.channels : []) : []),
    ...(Array.isArray(data.unassignedChannels) ? data.unassignedChannels : []),
  ];
  for (const channel of channels)
    for (const series of Array.isArray(channel?.series) ? channel.series : [])
      for (const point of Array.isArray(series?.points) ? series.points : [])
        if (point && Object.hasOwn(point, "excluded") && typeof point.excluded !== "boolean")
          throw new Error("A recorded event's excluded flag must be true or false.");
  let serialized;
  try { serialized = JSON.stringify(data); }
  catch { throw new Error("The test run could not be serialized. Import the files again."); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TEST_RUN_BYTES)
    throw new Error("The normalized test run exceeds 4 MB. Import a smaller set of files.");
  return data;
}

function validateEvidenceId(value, kind) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`Select an existing ${kind} to remove.`);
  }
  return value;
}

function validateSkidName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (
    !name ||
    name.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.toLowerCase() === "unassigned skid"
  ) {
    throw new Error(
      "Enter a unique skid name between 1 and 120 characters. ‘Unassigned skid’ is reserved.",
    );
  }
  return name;
}

export function validateBackendConfig({ url, key } = {}) {
  const normalizedUrl = String(url || "")
    .trim()
    .replace(/\/$/, "");
  const normalizedKey = String(key || "").trim();
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error("Enter the Supabase project URL.");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" &&
      !(isLocal && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "Use the HTTPS Supabase project URL, without a path or credentials.",
    );
  }
  let isPublicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(normalizedKey);
  if (!isPublicKey && normalizedKey.split(".").length === 3) {
    try {
      const payload = normalizedKey
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      isPublicKey = JSON.parse(atob(payload)).role === "anon";
    } catch {
      /* Reject malformed or privileged keys below. */
    }
  }
  if (!isPublicKey)
    throw new Error(
      "Use a Supabase publishable key or legacy anon key. Never enter a secret or service_role key.",
    );
  return { url: normalizedUrl, key: normalizedKey };
}

function photoFromRow(row) {
  return {
    id: row.id,
    walkdownId: row.walkdown_id,
    recordKey: row.record_key,
    path: row.path,
    name: row.name,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function setupPhotoFromRow(row) {
  return {
    id: row.id, walkdownId: row.walkdown_id, testRunId: row.test_run_id,
    path: row.path, name: row.name, width: row.width, height: row.height,
    caption: row.caption || "", createdAt: row.created_at, createdBy: row.created_by,
  };
}

/** Shared inspection data. The injectable factory is used only by local adapter tests. */
export function createBackend(
  config = {},
  { clientFactory = createClient } = {},
) {
  const { url, key } = validateBackendConfig({
    url: config.url ?? import.meta.env?.VITE_SUPABASE_URL,
    key: config.key ?? import.meta.env?.VITE_SUPABASE_ANON_KEY,
  });
  const client = clientFactory(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  const signedUrls = new Map();

  async function requestRpc(name, args, action) {
    const { data, error } = await client.rpc(name, args);
    fail(error, action);
    return data;
  }

  async function getSession() {
    const { data, error } = await client.auth.getSession();
    fail(error, "Could not read your sign-in session");
    return data.session;
  }

  async function listWalkdowns() {
    return requestRpc("qa_list_walkdowns", {}, "Could not load skid walkdowns");
  }

  function subscribeChanges(onChange, walkdownId) {
    if (typeof onChange !== "function")
      throw new Error("A change handler is required.");
    let active = true;
    const changed = () => {
      if (active) onChange();
    };
    const channel = client.channel(`qa-shared-${crypto.randomUUID()}`);
    const watched = walkdownId
      ? ["qa_records", "qa_photos", "qa_comments"]
          .map((table) => ({ table, filter: `walkdown_id=eq.${walkdownId}` }))
          .concat({ table: "qa_walkdowns", filter: `id=eq.${walkdownId}` })
      : [{ table: "qa_walkdowns" }];
    for (const item of watched)
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", ...item },
        changed,
      );
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") changed();
    });
    const { data } = client.auth.onAuthStateChange(() => {
      signedUrls.clear();
      setTimeout(changed, 0);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
      void client.removeChannel(channel);
    };
  }

  const workspace = {
    async requestCode(email) {
      const { error } = await client.auth.signInWithOtp({
        email: validateEmail(email),
        options: {
          shouldCreateUser: true,
          ...(globalThis.location?.origin
            ? {
                emailRedirectTo:
                  globalThis.location.origin + globalThis.location.pathname,
              }
            : {}),
        },
      });
      fail(error, "Could not send the sign-in code");
    },

    async verifyCode(email, token) {
      const code = String(token || "").trim();
      if (!/^\d{6,10}$/.test(code))
        throw new Error("Enter the numeric code from your sign-in email.");
      const { data, error } = await client.auth.verifyOtp({
        email: validateEmail(email),
        token: code,
        type: "email",
      });
      fail(error, "Could not verify the sign-in code");
      // Auth registration does not grant access: the database allowlist is authoritative.
      try {
        await listWalkdowns();
      } catch (accessError) {
        await client.auth.signOut({ scope: "local" });
        throw accessError;
      }
      return data.session;
    },

    getSession,

    async signOut() {
      signedUrls.clear();
      const { error } = await client.auth.signOut({ scope: "local" });
      fail(error, "Could not sign out");
    },

    listWalkdowns,
    async createWalkdown(name) {
      return requestRpc(
        "qa_create_walkdown",
        { p_skid_name: validateSkidName(name) },
        "Could not create the skid walkdown",
      );
    },
    async renameWalkdown(id, name, expectedRevision) {
      return requestRpc(
        "qa_rename_walkdown",
        {
          p_walkdown_id: validateWalkdownId(id),
          p_skid_name: validateSkidName(name),
          p_expected_revision: validateRevision(expectedRevision),
        },
        "Could not rename the skid walkdown",
      );
    },
    forWalkdown,
    subscribeWalkdowns(onChange) {
      return subscribeChanges(onChange);
    },
  };

  function forWalkdown(id, expectedRevision = null) {
    const walkdownId = validateWalkdownId(id);
    if (expectedRevision !== null) validateRevision(expectedRevision);
    const rpc = (name, args, action) =>
      requestRpc(name, { ...args, p_walkdown_id: walkdownId }, action);
    const writeRpc = (name, args, action) => rpc(name, {
      ...args, p_expected_revision: validateRevision(expectedRevision),
    }, action);
    async function uploadPhoto(recordKey, testRunId, { blob, width, height, name = "Inspection photo", caption = "" } = {}) {
      const setup = Boolean(testRunId);
      if (setup) validateTestRunId(testRunId);
      else validateRecordKey(recordKey);
      const setupCaption = setup ? validateSetupPhotoCaption(caption) : "";
      if (
        !blob ||
        typeof blob.arrayBuffer !== "function" ||
        !PHOTO_TYPES[blob.type]
      ) {
        throw new Error("Choose a JPEG, PNG, or WebP image.");
      }
      if (
        !Number.isFinite(blob.size) ||
        blob.size <= 0 ||
        blob.size > MAX_PHOTO_BYTES
      ) {
        throw new Error(
          "The photo must be nonempty and no larger than 12 MB.",
        );
      }
      if (
        ![width, height].every(
          (value) => Number.isInteger(value) && value > 0 && value <= 24000,
        )
      ) {
        throw new Error("The photo has invalid image dimensions.");
      }
      validateRevision(expectedRevision);
      const session = await getSession();
      if (!session?.user?.id)
        throw new Error("Sign in before adding evidence.");
      const id = crypto.randomUUID();
      const path = `${session.user.id}/${id}.${PHOTO_TYPES[blob.type]}`;
      const storage = client.storage.from(BUCKET);
      // Reserve evidence before upload. Storage policies deny deleting a reserved
      // or ready photo until the checked cancellation/removal RPC allows it.
      await writeRpc(
        setup ? "qa_prepare_test_setup_photo" : "qa_prepare_photo",
        {
          p_id: id,
          ...(setup ? { p_run_id: testRunId, p_caption: setupCaption } : { p_record_key: recordKey }),
          p_path: path,
          p_name: String(name).trim().slice(0, 180) || "Inspection photo",
          p_width: width,
          p_height: height,
        },
        "Could not prepare the photo upload",
      );
      async function cancelUpload() {
        const cancelled = await client.rpc("qa_cancel_photo", {
          p_walkdown_id: walkdownId,
          p_id: id,
        });
        if (cancelled.error) return cancelled;
        return storage
          .remove([path])
          .catch((cleanupError) => ({ error: cleanupError }));
      }
      const { error: uploadError } = await storage
        .upload(path, blob, { contentType: blob.type, upsert: false })
        .catch((error) => ({ error }));
      if (uploadError) {
        // A network failure may occur after storage accepted the upload.
        await cancelUpload().catch(() => {});
        fail(uploadError, "Could not upload the photo");
      }
      let registration;
      try {
        registration = await client.rpc(setup ? "qa_add_test_setup_photo" : "qa_add_photo", {
          p_walkdown_id: walkdownId,
          ...(setup ? { p_run_id: testRunId } : {}),
          p_id: id,
          p_expected_revision: expectedRevision,
        });
      } catch (error) {
        if (!setup) throw error;
        // A transport exception can hide a committed image and caption, just
        // like a returned RPC error. Recover that reservation before retrying.
        registration = { data: null, error };
      }
      const { data, error } = registration;
      if (error) {
        // Recover a lost RPC response without deleting an already registered photo.
        let query = client
          .from("qa_photos")
          .select(setup ? `${PHOTO_COLUMNS},test_run_id,caption` : PHOTO_COLUMNS)
          .eq("id", id)
          .eq("walkdown_id", walkdownId)
          .eq("upload_state", "ready")
          .is("deleted_at", null);
        if (setup) query = query.eq("test_run_id", testRunId);
        const result = await query.maybeSingle();
        if (!result.error && result.data) return setup ? setupPhotoFromRow(result.data) : photoFromRow(result.data);
        const cleanup = await cancelUpload().catch((cleanupError) => ({
          error: cleanupError,
        }));
        const suffix = cleanup.error
          ? " The upload may remain in storage; refresh before retrying and ask the project administrator to check orphaned uploads."
          : "";
        throw new Error(
          `Could not register the photo: ${error.message}.${suffix}`,
          { cause: error },
        );
      }
      return setup ? data : photoFromRow(data);
    }
    return Object.freeze({
      walkdownId,
      expectedRevision,
      getSession,
      forRevision(revision) {
        return forWalkdown(walkdownId, validateRevision(revision));
      },
      async loadState() {
        return rpc("qa_load_state", {}, "Could not load this skid inspection");
      },
      async listRevisions() {
        return rpc("qa_list_revisions", {}, "Could not load closed revisions");
      },
      async loadRevision(revision) {
        return rpc("qa_load_revision", { p_revision: validateRevision(revision) },
          "Could not load the closed revision");
      },
      async setCheckedBy(name, expectedName = null) {
        const checkedByName = validateCheckedBy(name);
        if (expectedName !== null && (typeof expectedName !== "string"
          || !expectedName.trim() || expectedName.length > 120
          || /[\u0000-\u001f\u007f-\u009f]/.test(expectedName)))
          throw new Error("Refresh the report before updating Checked by.");
        return writeRpc("qa_set_checked_by", {
          p_name: checkedByName, p_expected_name: expectedName,
        }, "Could not save Checked by");
      },
      async approveRevision(contentVersion) {
        if (!Number.isSafeInteger(contentVersion) || contentVersion < 0)
          throw new Error("Refresh the report before approving and closing it.");
        return writeRpc("qa_approve_revision", { p_expected_version: contentVersion },
          "Could not approve and close this revision");
      },
      async newRevision() {
        return writeRpc("qa_new_revision", {}, "Could not open a new revision");
      },

      async saveTestRun(run) {
        const id = validateTestRunId(run?.id);
        if (run.walkdownId && run.walkdownId !== walkdownId)
          throw new Error("This test run belongs to another skid.");
        const version = run.runVersion ?? null;
        if (version !== null && (!Number.isSafeInteger(version) || version < 1))
          throw new Error("Refresh the test run before saving changes.");
        return writeRpc("qa_save_test_run", {
          p_id: id, p_data: testRunPayload(run), p_expected_run_version: version,
        }, "Could not save the test run");
      },

      async deleteTestRun(id, runVersion) {
        validateTestRunId(id);
        if (!Number.isSafeInteger(runVersion) || runVersion < 1)
          throw new Error("Refresh the test run before removing it.");
        return writeRpc("qa_delete_test_run", { p_id: id, p_expected_run_version: runVersion },
          "Could not remove the test run");
      },

      async addPhoto(recordKey, photo) {
        return uploadPhoto(recordKey, null, photo);
      },

      async reorderPhotos(recordKey, orderedPhotoIds, expectedPhotoIds) {
        validateRecordKey(recordKey);
        const ordered = validatePhotoOrder(orderedPhotoIds, "inspection photo", 1000);
        const expected = validatePhotoOrder(expectedPhotoIds, "inspection photo", 1000);
        const expectedSet = new Set(expected);
        if (ordered.length !== expected.length || ordered.some(photoId => !expectedSet.has(photoId)))
          throw new Error("Include every current inspection photo exactly once in the order.");
        return writeRpc("qa_reorder_photos", {
          p_record_key: recordKey, p_ordered_photo_ids: ordered, p_expected_photo_ids: expected,
        }, "Could not save the inspection photo order");
      },

      async addTestSetupPhoto(runId, photo) {
        validateTestRunId(runId);
        return uploadPhoto(null, runId, photo);
      },

      async updateTestSetupPhoto(runId, photoId, caption) {
        validateTestRunId(runId);
        validateEvidenceId(photoId, "setup photo");
        return writeRpc("qa_update_test_setup_photo", {
          p_run_id: runId, p_id: photoId, p_caption: validateSetupPhotoCaption(caption),
        }, "Could not save the setup photo caption");
      },

      async reorderTestSetupPhotos(runId, orderedPhotoIds, expectedPhotoIds) {
        const id = validateTestRunId(runId);
        const ordered = validatePhotoOrder(orderedPhotoIds, "setup photo", 30);
        const expected = validatePhotoOrder(expectedPhotoIds, "setup photo", 30);
        const expectedSet = new Set(expected);
        if (ordered.length !== expected.length || ordered.some(photoId => !expectedSet.has(photoId)))
          throw new Error("Include every current setup photo exactly once in the order.");
        return writeRpc("qa_reorder_test_setup_photos", {
          p_run_id: id, p_ordered_photo_ids: ordered, p_expected_photo_ids: expected,
        }, "Could not save the setup photo order");
      },

      async deleteTestSetupPhoto(runId, photoId) {
        validateTestRunId(runId);
        validateEvidenceId(photoId, "setup photo");
        const path = await writeRpc("qa_delete_test_setup_photo", {
          p_run_id: runId, p_id: photoId,
        }, "Could not remove the setup photo");
        if (path === null) return;
        if (typeof path !== "string" || !path)
          throw new Error("The setup photo was removed, but its storage cleanup response was invalid.");
        signedUrls.delete(path);
        const { error } = await client.storage.from(BUCKET).remove([path]);
        fail(error, "The setup photo was removed from this draft, but storage cleanup failed. Retry removal or contact the project administrator");
      },

      async addComment(recordKey, text) {
        if (recordKey !== "walkdown:general") validateRecordKey(recordKey);
        const comment = String(text ?? "").trim();
        if (!comment || comment.length > 4000)
          throw new Error("Write a comment between 1 and 4,000 characters.");
        return writeRpc(
          "qa_add_comment",
          { p_record_key: recordKey, p_text: comment },
          "Could not add the comment",
        );
      },

      async deleteComment(commentId) {
        return writeRpc("qa_delete_comment", {
          p_id: validateEvidenceId(commentId, "comment"),
        }, "Could not remove the comment");
      },

      async setComplete(recordKey, complete) {
        validateRecordKey(recordKey);
        if (typeof complete !== "boolean")
          throw new Error("Completion must be true or false.");
        return writeRpc(
          "qa_set_complete",
          { p_record_key: recordKey, p_complete: complete },
          "Could not update completion",
        );
      },

      async setQuality(recordKey, quality) {
        validateRecordKey(recordKey);
        if (quality !== null && quality !== "good" && quality !== "bad") {
          throw new Error("Quality must be Passed, Failed, or unrated.");
        }
        return writeRpc(
          "qa_set_quality",
          { p_record_key: recordKey, p_quality: quality },
          "Could not update quality",
        );
      },

      async deletePhoto(photoId) {
        validateEvidenceId(photoId, "photo");
        // Reopen inspection first. Storage RLS forbids deleting active evidence directly.
        const path = await writeRpc(
          "qa_delete_photo",
          { p_id: photoId },
          "Could not remove the photo",
        );
        // Closed revisions retain their original evidence even after a later
        // draft removes the photo. The server protects these storage objects.
        if (path === null) return;
        if (typeof path !== "string" || !path)
          throw new Error("The photo was removed, but its storage cleanup response was invalid.");
        signedUrls.delete(path);
        const { error } = await client.storage.from(BUCKET).remove([path]);
        fail(
          error,
          "The photo was removed from the inspection and completion was reopened, but storage cleanup failed. Retry removal or contact the project administrator",
        );
      },

      async getPhotoUrl(photo) {
        if (photo?.walkdownId && photo.walkdownId !== walkdownId)
          throw new Error("This photo belongs to another skid walkdown.");
        if (!photo?.path || typeof photo.path !== "string")
          throw new Error("The photo storage path is missing.");
        const cached = signedUrls.get(photo.path);
        if (cached && cached.expiresAt > Date.now()) return cached.url;
        const { data, error } = await client.storage
          .from(BUCKET)
          .createSignedUrl(photo.path, 600);
        fail(error, "Could not open the private photo");
        signedUrls.set(photo.path, {
          url: data.signedUrl,
          expiresAt: Date.now() + 540_000,
        });
        return data.signedUrl;
      },

      subscribe(onChange) {
        return subscribeChanges(onChange, walkdownId);
      },
    });
  }
  return Object.freeze(workspace);
}
