/**
 * Gemini TTS — section-level synthesis.
 *
 * One API call per section per language (20 calls for a full briefing).
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
// Once the per-model-per-day limit is hit, every subsequent API call that day
// will also fail. Flip this flag on first quota error so we skip the network
// entirely for the rest of the run — avoids burning retries on dead quota.
let _dailyQuotaExhausted = false;

/** True once a per_model_per_day quota error has been seen this process run. */
export const isDailyQuotaExhausted = () => _dailyQuotaExhausted;

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL       = "gemini-2.5-flash-preview-tts";
const VOICE       = "Algieba";
const SAMPLE_RATE = 24_000; // Hz — Gemini TTS always outputs 24 kHz PCM

const GEMINI_TTS_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

function getKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// ── Core synthesis ────────────────────────────────────────────────────────────

async function synthesizeRaw(prompt: string): Promise<Buffer> {
  if (_dailyQuotaExhausted) {
    throw new Error("Gemini TTS daily quota exhausted — skipping API call");
  }
  const res = await fetch(GEMINI_TTS_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }], role: "user" }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        },
      },
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Gemini TTS ${res.status}: ${body}`);
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

/** Retry wrapper — bails immediately on daily quota errors. */
async function synthesizeWithRetry(
  prompt: string,
  tag: string,
  maxAttempts = 4,
): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await synthesizeRaw(prompt);
    } catch (err: any) {
      lastErr = err;
      const msg: string = err.message ?? "";
      const isDaily   = msg.includes("per_day") || msg.includes("per_model_per_day");
      const isBilling = msg.includes("prepayment") || msg.includes("credits are depleted");
      const is429     = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      console.warn(`[tts] ${tag} attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 120)}`);
      if (isDaily || isBilling) { _dailyQuotaExhausted = true; console.warn(`[tts] fatal quota/billing error — all further TTS calls skipped`); break; }
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

// ── WAV save / upload ─────────────────────────────────────────────────────────

async function saveWav(wav: Buffer, filename: string): Promise<{ url: string; durationSec: number }> {
  const durationSec = (wav.length - 44) / 2 / SAMPLE_RATE;
  const kb = (wav.length / 1024).toFixed(0);
  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.wav`), wav);
    console.log(`[tts] saved ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.wav`, durationSec };
  }
  const url = await uploadAudio(`${filename}.wav`, wav);
  console.log(`[tts] uploaded ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}

// ── Silence detection ─────────────────────────────────────────────────────────

const SILENCE_RMS_THRESHOLD   = 400;  // 0–32767
const MIN_SILENCE_MS          = 250;
const ANALYSIS_WINDOW_MS      = 10;
const MIN_SILENCE_SAMPLES     = Math.floor(SAMPLE_RATE * MIN_SILENCE_MS    / 1000);
const ANALYSIS_WINDOW_SAMPLES = Math.floor(SAMPLE_RATE * ANALYSIS_WINDOW_MS / 1000);

interface SilentRegion { startSample: number; endSample: number; durationMs: number; }

function findSilentRegions(pcm: Buffer): SilentRegion[] {
  const numSamples = Math.floor(pcm.length / 2);
  const regions: SilentRegion[] = [];
  let silenceStart = -1;

  for (let s = 0; s + ANALYSIS_WINDOW_SAMPLES <= numSamples; s += ANALYSIS_WINDOW_SAMPLES) {
    let sum = 0;
    for (let j = 0; j < ANALYSIS_WINDOW_SAMPLES; j++) {
      const v = pcm.readInt16LE((s + j) * 2);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / ANALYSIS_WINDOW_SAMPLES);
    if (rms < SILENCE_RMS_THRESHOLD) {
      if (silenceStart < 0) silenceStart = s;
    } else {
      if (silenceStart >= 0) {
        const dur = s - silenceStart;
        if (dur >= MIN_SILENCE_SAMPLES)
          regions.push({ startSample: silenceStart, endSample: s, durationMs: Math.round(dur / SAMPLE_RATE * 1000) });
        silenceStart = -1;
      }
    }
  }
  if (silenceStart >= 0) {
    const dur = numSamples - silenceStart;
    if (dur >= MIN_SILENCE_SAMPLES)
      regions.push({ startSample: silenceStart, endSample: numSamples, durationMs: Math.round(dur / SAMPLE_RATE * 1000) });
  }
  return regions;
}

/**
 * Find per-story start times (seconds) within a section PCM.
 * Uses silence boundaries for the N-1 gaps between stories.
 * Falls back to word-count proportion if not enough silences found.
 */
function findStoryBoundaries(pcm: Buffer, wordCounts: number[]): number[] {
  const storyCount  = wordCounts.length;
  const totalDurSec = pcm.length / 2 / SAMPLE_RATE;

  const wordCountFallback = (): number[] => {
    const total = wordCounts.reduce((a, b) => a + b, 0);
    let acc = 0;
    return wordCounts.map(wc => {
      const start = total > 0 ? (acc / total) * totalDurSec : 0;
      acc += wc;
      return start;
    });
  };

  if (storyCount <= 1) return [0];

  const needed  = storyCount - 1;
  const regions = findSilentRegions(pcm);

  if (regions.length < needed) {
    console.warn(`[tts:silence] need ${needed} boundaries, found ${regions.length} — word-count fallback`);
    return wordCountFallback();
  }

  const cuts = [...regions]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, needed)
    .sort((a, b) => a.startSample - b.startSample)
    .map(r => Math.floor((r.startSample + r.endSample) / 2) / SAMPLE_RATE);

  console.log(`[tts:silence] found ${regions.length} silences, using ${needed} as boundaries`);
  return [0, ...cuts];
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function googleTTS(
  text: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const pcm = await synthesizeWithRetry(text, filename);
  return saveWav(pcmToWav(pcm), filename);
}

/**
 * Synthesise a full section (multiple story scripts joined with \n\n).
 * Returns the audio URL, total duration, and per-story start times
 * derived from silence detection (falls back to word-count proportion).
 */
export async function googleTTSSection(
  scripts: string[],
  filename: string,
): Promise<{ url: string; durationSec: number; storyStartSecs: number[] }> {
  const wordCounts = scripts.map(s => s.split(/\s+/).length);
  const combined   = scripts.join("\n\n");
  const pcm        = await synthesizeWithRetry(combined, filename);
  const storyStartSecs = findStoryBoundaries(pcm, wordCounts);
  const { url, durationSec } = await saveWav(pcmToWav(pcm), filename);
  return { url, durationSec, storyStartSecs };
}

