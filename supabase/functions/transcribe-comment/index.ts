import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createVoiceHandler } from "./handler.js";
import { createVoiceSdkClient } from "./sdk-client.js";

Deno.serve(
  createVoiceHandler({
    getEnv: (name: string) => Deno.env.get(name),
    createSupabaseClient: ({
      url,
      key,
      authorization,
      signal,
    }: {
      url: string;
      key: string;
      authorization: string;
      signal: AbortSignal;
    }) =>
      createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          headers: { Authorization: authorization },
          fetch: (input, init) => fetch(input, { ...init, signal }),
        },
      }),
    createElevenLabsClient: createVoiceSdkClient,
  }),
);
