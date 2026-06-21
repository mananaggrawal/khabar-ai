/**
 * ElevenLabs TTS — per-story synthesis.
 *
 * Model: eleven_flash_v2_5 — cheapest multilingual model (50% lower cost vs v2),
 *        supports both English and Hindi.
 * Accent: language_code steers accent — "en-IN" for Indian English, "hi" for Hindi.
 * Voice:  configured via ELEVENLABS_VOICE_ID env var.
 * Output: MP3 @ 44.1 kHz / 128 kbps.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ── Quota guard ────────────────────────────────────────────────────────────────
// ElevenLabs uses character-based credits. On exhaustion flip this flag so we
// skip the API entirely for the rest of the run.
let _quotaExhausted = false;

/** True once an insufficient_credits / quota error has been seen this run. */
export const isQuotaExhausted = () => _quotaExhausted;

// ── Config ─────────────────────────────────────────────────────────────────────

// Flash v2.5: cheapest multilingual model (32 languages incl. Hindi), 50% cheaper per char
const MODEL_ID   = "eleven_flash_v2_5";
const OUTPUT_FMT = "mp3_44100_128";

function getKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set");
  return k;
}

function getVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID ?? "nPczCjzI2devNBz1zQrb";
}

/** Detect language from filename suffix (-en → Indian English, -hi → Hindi). */
function languageCode(filename: string): string {
  return filename.endsWith("-hi") ? "hi" : "en-IN";
}

// ── Core synthesis ─────────────────────────────────────────────────────────────

async function synthesize(text: string, filename: string): Promise<Buffer> {
  if (_quotaExhausted) throw new Error("ElevenLabs quota exhausted — skipping API call");

  const voiceId  = getVoiceId();
  const langCode = languageCode(filename);
  const url      = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FMT}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key":   getKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id:      MODEL_ID,
      language_code: langCode,   // "en-IN" → Indian English accent; "hi" → Hindi
      voice_settings: {
        stability:         0.5,
        similarity_boost:  0.75,
        style:             0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    const isFatal =
      res.status === 401 ||
      body.includes("insufficient_credits") ||
      body.includes("quota_exceeded");
    if (isFatal) {
      _quotaExhausted = true;
      console.warn("[tts/elevenlabs] quota/credits exhausted — all further TTS calls skipped");
    }
    throw new Error(`ElevenLabs TTS ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Retry wrapper — bails immediately on quota/auth errors. */
async function synthesizeWithRetry(
  text: string,
  filename: string,
  maxAttempts = 3,
): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await synthesize(text, filename);
    } catch (err: any) {
      lastErr = err;
      const msg: string = err.message ?? "";
      const isFatal =
        _quotaExhausted ||
        msg.includes("quota") ||
        msg.includes("401") ||
        msg.includes("insufficient");
      console.warn(
        `[tts/elevenlabs] ${filename} attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 120)}`,
      );
      if (isFatal) break;
      if (attempt < maxAttempts) {
        const delay = msg.includes("429") ? 10_000 * attempt : 2_000 * attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr!;
}

// ── Duration estimation ────────────────────────────────────────────────────────
// ElevenLabs doesn't return duration in the response — estimate from word count.

function estimateDurationSec(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return (words / 150) * 60; // ~150 wpm
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function elevenLabsTTS(
  text: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const mp3         = await synthesizeWithRetry(text, filename);
  const durationSec = estimateDurationSec(text);
  const kb          = (mp3.length / 1024).toFixed(0);
  const lang        = filename.endsWith("-hi") ? "HI" : "EN-IN";

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.mp3`), mp3);
    console.log(`[tts/elevenlabs] ${lang} saved ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.mp3`, durationSec };
  }

  const url = await uploadAudio(`${filename}.mp3`, mp3, "audio/mpeg");
  console.log(`[tts/elevenlabs] ${lang} uploaded ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}
