import { createClient } from "@supabase/supabase-js";

const BUCKET = "qa-evidence";
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
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
    async renameWalkdown(id, name) {
      return requestRpc(
        "qa_rename_walkdown",
        {
          p_walkdown_id: validateWalkdownId(id),
          p_skid_name: validateSkidName(name),
        },
        "Could not rename the skid walkdown",
      );
    },
    forWalkdown,
    subscribeWalkdowns(onChange) {
      return subscribeChanges(onChange);
    },
  };

  function forWalkdown(id) {
    const walkdownId = validateWalkdownId(id);
    const rpc = (name, args, action) =>
      requestRpc(name, { ...args, p_walkdown_id: walkdownId }, action);
    return Object.freeze({
      walkdownId,
      getSession,
      async loadState() {
        return rpc("qa_load_state", {}, "Could not load this skid inspection");
      },

      async addPhoto(
        recordKey,
        { blob, width, height, name = "Inspection photo" } = {},
      ) {
        validateRecordKey(recordKey);
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
        const session = await getSession();
        if (!session?.user?.id)
          throw new Error("Sign in before adding evidence.");
        const id = crypto.randomUUID();
        const path = `${session.user.id}/${id}.${PHOTO_TYPES[blob.type]}`;
        const storage = client.storage.from(BUCKET);
        // Reserve evidence before upload. Storage policies deny deleting a reserved
        // or ready photo until the checked cancellation/removal RPC allows it.
        await rpc(
          "qa_prepare_photo",
          {
            p_id: id,
            p_record_key: recordKey,
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
        const { data, error } = await client.rpc("qa_add_photo", {
          p_walkdown_id: walkdownId,
          p_id: id,
        });
        if (error) {
          // Recover a lost RPC response without deleting an already registered photo.
          const result = await client
            .from("qa_photos")
            .select(PHOTO_COLUMNS)
            .eq("id", id)
            .eq("walkdown_id", walkdownId)
            .eq("upload_state", "ready")
            .is("deleted_at", null)
            .maybeSingle();
          if (!result.error && result.data) return photoFromRow(result.data);
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
        return photoFromRow(data);
      },

      async addComment(recordKey, text) {
        if (recordKey !== "walkdown:general") validateRecordKey(recordKey);
        const comment = String(text ?? "").trim();
        if (!comment || comment.length > 4000)
          throw new Error("Write a comment between 1 and 4,000 characters.");
        return rpc(
          "qa_add_comment",
          { p_record_key: recordKey, p_text: comment },
          "Could not add the comment",
        );
      },

      async setComplete(recordKey, complete) {
        validateRecordKey(recordKey);
        if (typeof complete !== "boolean")
          throw new Error("Completion must be true or false.");
        return rpc(
          "qa_set_complete",
          { p_record_key: recordKey, p_complete: complete },
          "Could not update completion",
        );
      },

      async setQuality(recordKey, quality) {
        validateRecordKey(recordKey);
        if (quality !== null && quality !== "good" && quality !== "bad") {
          throw new Error("Quality must be Good, Bad, or unrated.");
        }
        return rpc(
          "qa_set_quality",
          { p_record_key: recordKey, p_quality: quality },
          "Could not update quality",
        );
      },

      async deletePhoto(photoId) {
        if (
          typeof photoId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            photoId,
          )
        ) {
          throw new Error("Select an existing photo to remove.");
        }
        // Reopen inspection first. Storage RLS forbids deleting active evidence directly.
        const path = await rpc(
          "qa_delete_photo",
          { p_id: photoId },
          "Could not remove the photo",
        );
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
