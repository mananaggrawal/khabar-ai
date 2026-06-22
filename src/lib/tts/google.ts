/**
 * Gemini TTS — section-level synthesis.
 *
 * One API call per section per language.
 * Per-story start times are estimated from word-count proportions × total duration.
 *
 * Voice: Algieba (Smooth — Indian English)
 * Output: 16-bit signed LE PCM @ 24 kHz → WAV
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ── Daily quota guard ─────────────────────────────────────────────────────────
let _dailyQuotaExhausted = false;
export const isDailyQuotaExhausted = () => _dailyQuotaExhausted;
export const resetDailyQuota       = () => { _dailyQuotaExhausted = false; };

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL       = "gemini-2.5-flash-preview-tts";
const VOICE       = "Algieba";
const SAMPLE_RATE = 24_000; // Hz — Gemini TTS always outputs 24 kHz PCM

const STYLE_EN =
  "Indian English male voice. Warm, clear, conversational news delivery. " +
  "Speak like an informed friend — not a broadcaster. " +
  "Natural pacing, brief pauses between stories.";

const STYLE_HI =
  "Indian Hindi male voice. Warm, clear delivery. Conversational, not formal. " +
  "Natural pauses between stories. Keep English names and brands in original pronunciation.";

const GEMINI_TTS_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

function getKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// ── Core synthesis ────────────────────────────────────────────────────────────

async function synthesizeRaw(script: string, style?: string): Promise<Buffer> {
  if (_dailyQuotaExhausted) {
    throw new Error("Gemini TTS daily quota exhausted — skipping API call");
  }
  // Gemini TTS models don't support system_instruction — embed style in the user text.
  const text = style ? `${style}\n\n${script}` : script;
  const body = {
    contents: [{ parts: [{ text }], role: "user" }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  };
  const res = await fetch(GEMINI_TTS_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    throw new Error(`Gemini TTS ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error(
      `Gemini TTS: no audio in response. Finish reason: ${data.candidates?.[0]?.finishReason}`,
    );
  }
  return Buffer.from(part.inlineData.data, "base64");
}

async function synthesizeWithRetry(
  prompt: string,
  tag: string,
  style?: string,
  maxAttempts = 4,
): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await synthesizeRaw(prompt, style);
    } catch (err: any) {
      lastErr = err;
      const msg: string = err.message ?? "";
      const isDaily   = msg.includes("per_day") || msg.includes("per_model_per_day");
      const isBilling = msg.includes("prepayment") || msg.includes("credits are depleted");
      const is429     = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      console.warn(`[tts/google] ${tag} attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 120)}`);
      if (isDaily || isBilling) {
        _dailyQuotaExhausted = true;
        console.warn(`[tts/google] fatal quota/billing error — all further TTS calls skipped`);
        break;
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, is429 ? 10_000 * attempt : 1_500 * attempt));
      }
    }
  }
  throw lastErr!;
}

// ── PCM → WAV ─────────────────────────────────────────────────────────────────

function pcmToWav(pcm: Buffer): Buffer {
  const dataSize   = pcm.length;
  const byteRate   = SAMPLE_RATE * 1 * 2;
  const blockAlign = 1 * 2;
  const wav        = Buffer.alloc(44 + dataSize);
  wav.write("RIFF",  0, "ascii"); wav.writeUInt32LE(36 + dataSize,  4);
  wav.write("WAVE",  8, "ascii"); wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1,  20); wav.writeUInt16LE(1,  22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign,  32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function saveWav(wav: Buffer, filename: string): Promise<{ url: string; durationSec: number }> {
  const durationSec = (wav.length - 44) / 2 / SAMPLE_RATE;
  const kb = (wav.length / 1024).toFixed(0);
  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.wav`), wav);
    console.log(`[tts/google] saved ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.wav`, durationSec };
  }
  const url = await uploadAudio(`${filename}.wav`, wav);
  console.log(`[tts/google] uploaded ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesise a single story script → WAV file.
 * Returns { url, durationSec }. audioStartSec is always 0.
 */
export async function googleTTS(
  script: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const lang  = filename.endsWith("-hi") ? "hi" : "en";
  const style = lang === "hi" ? STYLE_HI : STYLE_EN;

  try {
    const pcm = await synthesizeWithRetry(script, filename, style, 3);
    return saveWav(pcmToWav(pcm), filename);
  } catch (err: any) {
    // If styled attempt fails with 5xx, retry bare (no style prefix) — last resort
    if (err.message?.includes("500") || err.message?.includes("503")) {
      console.warn(`[tts/google] ${filename}: styled attempt failed, retrying bare…`);
      const pcm = await synthesizeWithRetry(script, filename, undefined, 3);
      return saveWav(pcmToWav(pcm), filename);
    }
    throw err;
  }
}
