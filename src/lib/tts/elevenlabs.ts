/**
 * ElevenLabs TTS — per-story synthesis.
 *
 * Model: eleven_flash_v2_5 — cheapest multilingual model, supports EN/HI.
 * language_code: set for Hindi. English omitted (no "en-IN").
 * Voice: configured via ELEVENLABS_VOICE_ID_* env vars per language.
 * Output: MP3 @ 44.1 kHz / 128 kbps.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ── Quota guard ────────────────────────────────────────────────────────────────
let _quotaExhausted = false;
export const isQuotaExhausted = () => _quotaExhausted;
export const resetQuota       = () => { _quotaExhausted = false; };

// ── Config ─────────────────────────────────────────────────────────────────────

const MODEL_ID   = "eleven_flash_v2_5";
const OUTPUT_FMT = "mp3_44100_128";

// Language codes supported by Flash v2.5. English is omitted (use model default).
const LANG_CODES: Record<string, string> = {
  hi: "hi",
};

function getLangFromFilename(filename: string): string {
  if (filename.endsWith("-hi")) return "hi";
  return "en";
}

function getKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set");
  return k;
}

function getVoiceId(lang: string): string {
  if (lang === "hi") return process.env.ELEVENLABS_VOICE_ID_HI ?? process.env.ELEVENLABS_VOICE_ID ?? "WuePGPKIAIKI8COZpzce";
  return process.env.ELEVENLABS_VOICE_ID ?? "nwj0s2LU9bDWRKND5yzA";
}

// ── Core synthesis ─────────────────────────────────────────────────────────────

async function synthesize(text: string, filename: string): Promise<Buffer> {
  if (_quotaExhausted) throw new Error("ElevenLabs quota exhausted — skipping API call");

  const lang    = getLangFromFilename(filename);
  const voiceId = getVoiceId(lang);
  const url     = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FMT}`;

  const payload: Record<string, unknown> = {
    text,
    model_id: MODEL_ID,
    voice_settings: {
      stability:         0.38,  // lower = more expressive/dynamic delivery
      similarity_boost:  0.75,
      style:             0.45,  // adds energy and emphasis
      use_speaker_boost: true,
    },
  };

  // Set language_code for all non-English languages.
  // English is omitted entirely — "en-IN" is invalid and returns 400.
  if (LANG_CODES[lang]) payload.language_code = LANG_CODES[lang];

  // Timeout (2026-07-09 audit fix) — unlike the LLM script calls (90s) and
  // Edge TTS (25s), this fetch had no bound at all: a hung ElevenLabs
  // connection could stall an entire generation run indefinitely, since
  // nothing here would ever move on to the next story.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key":   getKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
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

function estimateDurationSec(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return (words / 150) * 60;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function elevenLabsTTS(
  text: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const mp3         = await synthesizeWithRetry(text, filename);
  const durationSec = estimateDurationSec(text);
  const kb          = (mp3.length / 1024).toFixed(0);
  const lang        = getLangFromFilename(filename).toUpperCase();

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
