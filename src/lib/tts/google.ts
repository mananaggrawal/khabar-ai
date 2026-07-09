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

// ── Model rotation — three models, 250 RPD total (enough for one full run) ──
// All available Gemini TTS models — rotated through when one hits its daily RPD limit.
// Combined RPD: 100 + 100 + 50 = 250/day (enough for a full run of ~100 stories × 2 langs).
// If a model string is wrong you'll see a 404 — check AI Studio for the exact name.
const MODELS = [
  "gemini-2.5-flash-preview-tts",  // 100 RPD
  "gemini-2.5-pro-preview-tts",    //  50 RPD — last resort
] as const;

const _modelExhausted: Record<string, boolean> = {};
let _activeModelIdx = 0;

function getActiveModel(): string {
  // Find first non-exhausted model
  for (let i = 0; i < MODELS.length; i++) {
    const idx = (_activeModelIdx + i) % MODELS.length;
    if (!_modelExhausted[MODELS[idx]]) return MODELS[idx];
  }
  return MODELS[0]; // all exhausted — return primary so caller gets the right error
}

function markModelExhausted(model: string) {
  _modelExhausted[model] = true;
  console.warn(`[tts/google] ${model} daily quota hit — rotating to next model`);
  // Advance active index past exhausted model
  _activeModelIdx = (_activeModelIdx + 1) % MODELS.length;
}

// ── Daily quota guard ─────────────────────────────────────────────────────────
export const isDailyQuotaExhausted = () => MODELS.every(m => _modelExhausted[m]);
export const resetDailyQuota = () => {
  MODELS.forEach(m => { _modelExhausted[m] = false; });
  _activeModelIdx = 0;
};

// ── RPM rate limiter — Tier 1 cap is 10 RPM ──────────────────────────────────
// Space calls at least 6.5s apart so we never exceed 10/min even under bursts.
const RPM_GAP_MS = 6_500;
let _lastCallAt = 0;

async function waitForRpmSlot(): Promise<void> {
  const now  = Date.now();
  const wait = _lastCallAt + RPM_GAP_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallAt = Date.now();
}

// ── Config ────────────────────────────────────────────────────────────────────

const VOICE       = "Algieba";
const SAMPLE_RATE = 24_000; // Hz — Gemini TTS always outputs 24 kHz PCM

const STYLE_EN =
  "Indian English male voice. Energetic, engaging news delivery — excited about the stories. " +
  "Vary your pace: slow down on key facts, punch through on big moments. " +
  "Warm but sharp. Like a smart friend who just heard breaking news and can't wait to tell you.";

const STYLE_HI =
  "Hindi male voice. Energetic, engaging delivery — excited about the stories, not monotone. " +
  "Let important facts land with weight and emphasis. " +
  "Keep English names, numbers, and brand names in their original pronunciation.";

const GEMINI_TTS_URL = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

function getKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// ── Core synthesis ────────────────────────────────────────────────────────────

async function synthesizeRaw(script: string, style?: string, embedStyle = false): Promise<Buffer> {
  if (isDailyQuotaExhausted()) {
    throw new Error("Gemini TTS daily quota exhausted — skipping API call");
  }
  await waitForRpmSlot(); // enforce ≤10 RPM (Tier 1 limit)
  const model = getActiveModel();
  // Primary: pass style as system_instruction (better voice quality).
  // Fallback (embedStyle=true): prepend style in user text when system_instruction causes 500.
  const text = (embedStyle && style) ? `[Voice style: ${style}]\n\n${script}` : script;
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text }], role: "user" }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  };
  if (style && !embedStyle) body.system_instruction = { parts: [{ text: style }] };
  // Timeout (2026-07-09 audit fix) — same gap as elevenlabs.ts had: no bound
  // meant a hung Gemini connection could stall an entire generation run.
  const res = await fetch(GEMINI_TTS_URL(model, getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    throw new Error(`Gemini TTS ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const part         = data.candidates?.[0]?.content?.parts?.[0];
  const finishReason = data.candidates?.[0]?.finishReason as string | undefined;
  if (!part?.inlineData?.data) {
    const err = new Error(`Gemini TTS: no audio in response. Finish reason: ${finishReason}`);
    (err as any).finishReason = finishReason;
    throw err;
  }
  return Buffer.from(part.inlineData.data, "base64");
}

async function synthesizeWithRetry(
  prompt: string,
  tag: string,
  style?: string,
  maxAttempts = 3,
  embedStyle = false,
): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await synthesizeRaw(prompt, style, embedStyle);
    } catch (err: any) {
      lastErr = err;
      const msg: string = err.message ?? "";
      const isDaily   = msg.includes("per_day") || msg.includes("per_model_per_day");
      const isBilling = msg.includes("prepayment") || msg.includes("credits are depleted");
      const is429     = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      console.warn(`[tts/google] ${tag} attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 120)}`);
      const isOther   = err.finishReason === "OTHER" || msg.includes("Finish reason: OTHER");
      if (isBilling) {
        // Billing failure — nothing we can do, stop everything
        MODELS.forEach(m => { _modelExhausted[m] = true; });
        console.warn(`[tts/google] billing error — all TTS skipped`);
        break;
      }
      if (isDaily) {
        // This model hit its daily RPD limit — rotate to next and retry immediately
        markModelExhausted(getActiveModel());
        if (isDailyQuotaExhausted()) {
          console.warn(`[tts/google] all models daily quota exhausted`);
          break;
        }
        // Don't count this as an attempt — retry with new model right away
        attempt--;
        continue;
      }
      // Safety-filter hit: retrying won't help — break immediately so caller can try bare synthesis
      if (isOther) break;
      if (attempt < maxAttempts) {
        // 429 = RPM limit hit — wait 65s to clear the 1-minute window, then retry
        const delay = is429 ? 65_000 : 2_000 * attempt;
        if (is429) console.warn(`[tts/google] ${tag} rate-limited — waiting 65s for window to reset…`);
        await new Promise(r => setTimeout(r, delay));
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

  const isOtherErr = (e: any) =>
    e?.finishReason === "OTHER" || (e?.message as string | undefined)?.includes("Finish reason: OTHER");
  const is5xxErr   = (e: any) =>
    (e?.message as string | undefined)?.includes("500") ||
    (e?.message as string | undefined)?.includes("503");

  // Attempt 1: system_instruction (best voice quality)
  try {
    const pcm = await synthesizeWithRetry(script, filename, style, 3, false);
    return saveWav(pcmToWav(pcm), filename);
  } catch (err: any) {
    if (!isOtherErr(err) && !is5xxErr(err)) throw err;
    console.warn(`[tts/google] ${filename}: system_instruction failed (${isOtherErr(err) ? "OTHER" : "5xx"}), trying embedded style…`);
  }

  // Attempt 2: style embedded in text — always keep Indian English style, never go bare
  const pcm = await synthesizeWithRetry(script, filename, style, 3, true);
  return saveWav(pcmToWav(pcm), filename);
}
