// Supabase Edge Function — deletes old briefing data from Storage (bucket
// "khabar") to free up quota: briefings/YYYY-MM-DD.json,
// logs/YYYY-MM-DD.log, and audio/YYYY-MM-DD-<storyId>-<lang>.mp3, for every
// date older than a cutoff. Same logic as scripts/cleanup-storage.mjs, ported
// to run inside Supabase itself so SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// never have to be copied into a local terminal — Edge Functions get both
// injected automatically as environment variables.
//
// Deploy (needs the Supabase CLI installed + `supabase login` once):
//   supabase functions deploy cleanup-storage --no-verify-jwt
//
// Invoke from the Supabase dashboard's Edge Functions → cleanup-storage →
// "Invoke" panel, or via curl:
//   curl -X POST "https://<project-ref>.functions.supabase.co/cleanup-storage" \
//     -H "Authorization: Bearer <anon-or-service-role-key>" \
//     -H "Content-Type: application/json" \
//     -d '{"keepDays": 3, "dryRun": true}'
//
// --no-verify-jwt is used because this is triggered manually by you, not by
// an authenticated app user — otherwise every call needs a valid Supabase
// JWT. If you'd rather keep JWT verification on, drop that flag and always
// pass a valid Authorization header from a logged-in admin session instead.
//
// SECURITY (2026-07-09 fix): --no-verify-jwt means Supabase's platform-level
// auth check is OFF for this function — the Authorization/apikey headers in
// the curl examples above are accepted by the edge runtime but were NEVER
// actually checked by this function's own code, so ANYONE with the function
// URL could trigger real deletion of Storage data with just the public
// anon/publishable key (or arguably no header at all). This function now
// requires a shared secret in an x-admin-key header, checked against the
// ADMIN_KEY secret already used to gate this app's other admin routes
// (server.mjs/handlers.ts) — set it once with:
//   supabase secrets set ADMIN_KEY=<same value as Render's ADMIN_KEY>
// and pass it as `-H "x-admin-key: <value>"` on every invocation from now on.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "khabar";

interface FileEntry {
  name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const adminKey = Deno.env.get("ADMIN_KEY");
  if (!adminKey || req.headers.get("x-admin-key") !== adminKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let keepDays = 2; // today + yesterday, by default
  let dryRun = false;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (typeof body.keepDays === "number") keepDays = body.keepDays;
      if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
    } else {
      const url = new URL(req.url);
      const kd = url.searchParams.get("keepDays");
      if (kd) keepDays = Number(kd);
      dryRun = url.searchParams.get("dryRun") === "true";
    }
  } catch {
    // fall through with defaults
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in function env" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Keep the last `keepDays` calendar days (today counts as day 0).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  async function listAll(prefix: string): Promise<FileEntry[]> {
    const all: FileEntry[] = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
      if (error) throw new Error(`list(${prefix}) failed: ${error.message}`);
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }

  async function removeBatched(paths: string[]) {
    if (dryRun || paths.length === 0) return;
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) throw new Error(`remove() failed: ${error.message}`);
    }
  }

  // briefings/YYYY-MM-DD.json and logs/YYYY-MM-DD.log — date is the whole
  // filename (minus extension); plain string prefix compare works.
  async function pruneDatedFolder(folder: string) {
    const files = await listAll(folder);
    const toDelete = files.filter((f) => f.name < cutoffStr).map((f) => `${folder}/${f.name}`);
    await removeBatched(toDelete);
    return { total: files.length, deleted: toDelete.length };
  }

  // Extracts a YYYY-MM-DD date from a filename regardless of which naming
  // scheme it uses — the current per-story convention embeds it at the very
  // start (YYYY-MM-DD-<storyId>-<lang>.mp3), but older, no-longer-produced
  // combined-per-section .wav files from before this refactor instead embed
  // it after a "briefing-" prefix (briefing-YYYY-MM-DD-<oldSection>.wav).
  // Both are matched here so a stale, differently-named leftover doesn't
  // silently escape pruning just because it predates the current filename
  // format (2026-07-09 fix — these accounted for 312MB of files that never
  // got caught by the plain first-10-chars check below).
  function extractDate(name: string): string | null {
    const m = name.match(/^(?:briefing-)?(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  // audio/YYYY-MM-DD-<storyId>-<lang>.mp3 (current) or
  // audio/briefing-YYYY-MM-DD-<oldSection>.wav (legacy, dead weight — the
  // pipeline hasn't produced this format in a long time).
  async function pruneAudio() {
    const files = await listAll("audio");
    const toDelete = files
      .filter((f) => {
        const d = extractDate(f.name);
        return d !== null && d < cutoffStr;
      })
      .map((f) => `audio/${f.name}`);
    await removeBatched(toDelete);
    return { total: files.length, deleted: toDelete.length };
  }

  try {
    const briefings = await pruneDatedFolder("briefings");
    const logs = await pruneDatedFolder("logs");
    const audio = await pruneAudio();

    return new Response(
      JSON.stringify({ dryRun, keepDays, cutoff: cutoffStr, briefings, logs, audio }, null, 2),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
