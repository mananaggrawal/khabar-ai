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
    });
    if (!error) {
      const { data: urlData } = client().storage.from(BUCKET).getPublicUrl(path);
      return urlData.publicUrl;
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
