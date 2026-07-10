/**
 * Supabase Storage helper — server-side only (uses service role key).
 * Used in production (LOCAL_MODE=false) to persist audio + briefing JSON.
 * Bucket: "khabar" (public)
 *   audio/filename.wav
 *   briefings/YYYY-MM-DD.json
 */
import { createClient } from "@supabase/supabase-js";

const BUCKET = "khabar";

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function uploadAudio(
  filename: string,
  data: Buffer,
  contentType = "audio/wav",
): Promise<string> {
  const path = `audio/${filename}`;
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
    const { error } = await client().storage.from(BUCKET).upload(path, data, {
      contentType,
      upsert: true,
      // Regenerating same-day (e.g. after fixing a bad script) re-uploads to
      // this SAME path, since the filename is derived from a stable per-story
      // id — upsert overwrites the underlying object fine, but without this,
      // browsers/CDNs cache the response by URL and can keep serving the OLD
      // audio bytes for up to an hour after the new file is already live.
      cacheControl: "0",
    });
    if (!error) {
      const { data: urlData } = client().storage.from(BUCKET).getPublicUrl(path);
      // Cache-busting query param: guarantees a regenerated file (same path,
      // new content) gets a genuinely new URL, so no cache layer anywhere —
      // browser, Supabase's CDN, anything in between — can serve stale audio.
      return `${urlData.publicUrl}?v=${Date.now()}`;
    }
    lastErr = error.message;
  }
  throw new Error(`Storage audio upload failed: ${lastErr}`);
}

export async function saveBriefingToStorage(date: string, briefing: unknown): Promise<void> {
  const json = Buffer.from(JSON.stringify(briefing, null, 2));
  let lastErr: string | undefined;
  // Retry transient Storage failures (e.g. 504 Gateway Timeout under load)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    const { error } = await client().storage
      .from(BUCKET)
      .upload(`briefings/${date}.json`, json, {
        contentType: "application/json",
        upsert: true,
      });
    if (!error) return;
    lastErr = error.message;
  }
  throw new Error(`Storage briefing save failed: ${lastErr}`);
}

export async function loadBriefingFromStorage(date: string): Promise<unknown | null> {
  const { data, error } = await client().storage
    .from(BUCKET)
    .download(`briefings/${date}.json`);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}

// Generation run logs — plain text, one file per day, appended across
// multiple runs same day (cron + manual triggers) so the admin panel can show
// "what happened today" even for runs nobody was watching live via SSE.
export async function saveLogToStorage(date: string, text: string): Promise<void> {
  const buf = Buffer.from(text);
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
    const { error } = await client().storage
      .from(BUCKET)
      .upload(`logs/${date}.log`, buf, { contentType: "text/plain", upsert: true });
    if (!error) return;
    lastErr = error.message;
  }
  throw new Error(`Storage log save failed: ${lastErr}`);
}

export async function loadLogFromStorage(date: string): Promise<string | null> {
  const { data, error } = await client().storage
    .from(BUCKET)
    .download(`logs/${date}.log`);
  if (error || !data) return null;
  try { return await data.text(); } catch { return null; }
}

// BUG FIX (2026-07-10) — Storage hit 131% of the free-tier 1GB quota
// ("grace period" banner in the Supabase dashboard), which broke BOTH new
// audio/briefing saves above (throwing after 3 retries) AND log persistence
// itself (saveLogToStorage is the same bucket) — so a run could genuinely
// execute (LLM/TTS calls don't touch Supabase Storage) while nothing new got
// saved and even the failure message couldn't be written, looking exactly
// like "cron ran, 200 OK, but no logs and stale stories."
//
// scripts/cleanup-storage.mjs and supabase/functions/cleanup-storage/index.ts
// already contain this exact pruning logic, but BOTH are invoke-it-yourself
// only — nothing was ever scheduled to call either one automatically (the
// pg_cron migration only prunes Postgres ROWS: analytics_events and
// listened_stories, never Storage files). That gap is what let usage climb
// back to over quota after the one manual cleanup. Porting the same logic
// in here so handleCron (server/lib/api/handlers.ts) can run it itself
// before every generation, using the exact same trusted daily trigger
// (cron-job.org → /api/admin/cron) instead of needing a second, separate
// schedule to remember to set up.
const PRUNE_BUCKET = "khabar";

interface StorageFileEntry { name: string }

async function listAllStorage(prefix: string): Promise<StorageFileEntry[]> {
  const all: StorageFileEntry[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await client().storage.from(PRUNE_BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list(${prefix}) failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function removeStorageBatched(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    const { error } = await client().storage.from(PRUNE_BUCKET).remove(batch);
    if (error) throw new Error(`remove() failed: ${error.message}`);
  }
}

// Matches both the current per-story filename scheme (date at the very
// start) and the legacy combined-per-section .wav naming (date after a
// "briefing-" prefix) — see the same regex in the script/Edge Function.
function extractPruneDate(name: string): string | null {
  const m = name.match(/^(?:briefing-)?(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export interface PruneResult {
  cutoff: string;
  briefings: { total: number; deleted: number };
  logs: { total: number; deleted: number };
  audio: { total: number; deleted: number };
}

/** Deletes briefings/logs/audio older than `keepDays` calendar days (today
 * counts as day 0). Safe to call on every cron run — a day with nothing to
 * delete is just a fast no-op list-and-compare. */
export async function pruneOldStorage(keepDays = 2): Promise<PruneResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  async function pruneDatedFolder(folder: string) {
    const files = await listAllStorage(folder);
    const toDelete = files.filter((f) => f.name < cutoffStr).map((f) => `${folder}/${f.name}`);
    await removeStorageBatched(toDelete);
    return { total: files.length, deleted: toDelete.length };
  }

  async function pruneAudio() {
    const files = await listAllStorage("audio");
    const toDelete = files
      .filter((f) => {
        const d = extractPruneDate(f.name);
        return d !== null && d < cutoffStr;
      })
      .map((f) => `audio/${f.name}`);
    await removeStorageBatched(toDelete);
    return { total: files.length, deleted: toDelete.length };
  }

  const [briefings, logs, audio] = await Promise.all([
    pruneDatedFolder("briefings"),
    pruneDatedFolder("logs"),
    pruneAudio(),
  ]);

  return { cutoff: cutoffStr, briefings, logs, audio };
}
