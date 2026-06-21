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
  const { error } = await client().storage.from(BUCKET).upload(path, data, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage audio upload failed: ${error.message}`);
  const { data: urlData } = client().storage.from(BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

export async function saveBriefingToStorage(date: string, briefing: unknown): Promise<void> {
  const json = Buffer.from(JSON.stringify(briefing, null, 2));
  const { error } = await client().storage
    .from(BUCKET)
    .upload(`briefings/${date}.json`, json, {
      contentType: "application/json",
      upsert: true,
    });
  if (error) throw new Error(`Storage briefing save failed: ${error.message}`);
}

export async function loadBriefingFromStorage(date: string): Promise<unknown | null> {
  const { data, error } = await client().storage
    .from(BUCKET)
    .download(`briefings/${date}.json`);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
