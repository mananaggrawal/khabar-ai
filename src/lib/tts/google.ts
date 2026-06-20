/**
 * Gemini TTS — single-story and batch synthesis.
 *
 * Batch mode merges N story scripts into one API call, splits the resulting
 * PCM at silence boundaries, and saves individual WAVs. This keeps daily API
 * call counts well under quota regardless of story count.
 *
 * Voice: Algieba (Smooth — Indian English)
 * Output: 16-bit signed LE PCM @ 24 kHz → WAV
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL       = "gemini-3.1-flash-tts-preview";
const VOICE       = "Algieba";
const SAMPLE_RATE = 24_000; // Hz — Gemini TTS always outputs 24 kHz PCM

const GEMINI_TTS_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

function getKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// ── Style instructions ────────────────────────────────────────────────────────

const STYLE_INSTRUCTIONS_EN = `# AUDIO PROFILE: Khabar AI — Daily News Briefing

## THE SCENE
A quiet, well-lit home studio. One person preparing to share today's news with a friend over the phone. Warm, unhurried, human.

### DIRECTOR'S NOTES

Style: Speak like a smart, well-informed friend sharing things they learned today — not a broadcaster, not a news anchor, not an AI assistant. Warm, curious, relaxed, trustworthy. The listener should forget they're listening to a generated voice.

Pacing: Never rushed. Slow down slightly for important developments. Speed stays conversational. Never monotone — vary pace based on content. Use natural pauses:
- Brief pause after important facts
- Slight pause before key takeaways
- Longer pause when transitioning between major stories

Tone variation:
- [curious] when introducing something surprising
- [thoughtful] for politics, economics, global affairs
- [subtle energy] for innovation, breakthroughs, exciting events
- [empathetic] for difficult or emotional topics
- Return to calm, conversational baseline between stories

Emphasis: Highlight what changed, what surprised people, why something matters, what could happen next. When a sentence contains an important insight, give it room to land. Emphasize meaning — not individual words.

Transitions: Make story transitions feel effortless and conversational, not segmented. Imagine sitting next to someone during a commute, casually catching them up.

Accent: Indian English — natural, educated, clear.

Never: Sound robotic, overly dramatic, like a presenter, or like you're performing.

### TRANSCRIPT
`;

const STYLE_INSTRUCTIONS_HI = `# AUDIO PROFILE: Khabar AI — दैनिक समाचार

## THE SCENE
एक शांत होम स्टूडियो। एक पढ़ा-लिखा दोस्त जो आज की ख़बरें किसी क़रीबी को फ़ोन पर बता रहा हो।

### DIRECTOR'S NOTES

Style: एक समझदार, जानकार दोस्त की तरह बोलें जो आज की ख़बरें share कर रहा हो — न news anchor की तरह, न AI की तरह। गर्मजोशी, स्वाभाविकता, भरोसा।

Pacing: जल्दबाज़ी नहीं। स्वाभाविक हिंदी की रफ़्तार। महत्वपूर्ण तथ्यों के बाद थोड़ा रुकें।

Proper nouns: नाम, जगह, कंपनियाँ, organizations — इन्हें अंग्रेज़ी में ही बोलें जैसा वो naturally बोले जाते हैं।

Tone: तथ्यों पर ध्यान दें। Dramatic नहीं।

Never: Robotic, overly formal news anchor style, या performance जैसा न लगे।

### TRANSCRIPT
`;

// ── Core synthesis ────────────────────────────────────────────────────────────

async function synthesizeRaw(prompt: string): Promise<Buffer> {
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
      const isDaily = msg.includes("per_day") || msg.includes("per_model_per_day");
      const is429   = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      console.warn(`[tts] ${tag} attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 120)}`);
      if (isDaily) { console.warn("[tts] daily quota exhausted — aborting retries"); break; }
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

async function saveWav(wav: Buffer, filename: string): Promise<string> {
  const durationSec = ((wav.length - 44) / 2 / SAMPLE_RATE).toFixed(1);
  const kb = (wav.length / 1024).toFixed(0);
  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.wav`), wav);
    console.log(`[tts] saved ${filename}.wav — ${kb}KB ~${durationSec}s`);
    return `/audio/${filename}.wav`;
  }
  const url = await uploadAudio(`${filename}.wav`, wav);
  console.log(`[tts] uploaded ${filename}.wav — ${kb}KB ~${durationSec}s`);
  return url;
}

// ── Single-story public API ───────────────────────────────────────────────────

export async function googleTTS(
  text: string,
  filename: string,
  language: "en" | "hi" = "en",
): Promise<string> {
  const style = language === "hi" ? STYLE_INSTRUCTIONS_HI : STYLE_INSTRUCTIONS_EN;
  const pcm = await synthesizeWithRetry(style + text, filename);
  return saveWav(pcmToWav(pcm), filename);
}

// ── Batch TTS ─────────────────────────────────────────────────────────────────
//
// Merges N story scripts into one API call, splits the resulting PCM at the
// N-1 longest silence regions, and saves individual WAV files.
//
// API call count: ceil(stories / BATCH_SIZE) × 2 languages
// Example: 400 stories → 27 batches × 2 = 54 calls (vs. 800 individual calls)

/** Stories per batch call — ~60 s of audio per call at ~4 s/story. */
export const TTS_BATCH_SIZE = 15;

/** Text injected between stories; produces ~1 s silence in TTS output. */
const BATCH_SEPARATOR = "\n---\n";

// Silence-detection constants
const SILENCE_RMS_THRESHOLD    = 400;  // amplitude floor  (0 – 32 767)
const MIN_SILENCE_MS           = 300;  // shortest qualifying silence
const ANALYSIS_WINDOW_MS       = 10;   // RMS window

const MIN_SILENCE_SAMPLES      = Math.floor(SAMPLE_RATE * MIN_SILENCE_MS    / 1000); // 7 200
const ANALYSIS_WINDOW_SAMPLES  = Math.floor(SAMPLE_RATE * ANALYSIS_WINDOW_MS / 1000); //   240

interface SilentRegion {
  startSample: number;
  endSample:   number;
  durationMs:  number;
}

/** Scan PCM and return all contiguous silent runs ≥ MIN_SILENCE_MS. */
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
        if (dur >= MIN_SILENCE_SAMPLES) {
          regions.push({
            startSample: silenceStart,
            endSample:   s,
            durationMs:  Math.round(dur / SAMPLE_RATE * 1_000),
          });
        }
        silenceStart = -1;
      }
    }
  }
  // Trailing silence
  if (silenceStart >= 0) {
    const dur = numSamples - silenceStart;
    if (dur >= MIN_SILENCE_SAMPLES) {
      regions.push({
        startSample: silenceStart,
        endSample:   numSamples,
        durationMs:  Math.round(dur / SAMPLE_RATE * 1_000),
      });
    }
  }
  return regions;
}

/**
 * Split `pcm` into `storyCount` segments using the N-1 longest silence regions
 * as cut points. Returns null if splitting is not possible (triggers fallback).
 */
function splitPcmAtSilences(pcm: Buffer, storyCount: number): Buffer[] | null {
  if (storyCount === 1) return [pcm];

  const needed  = storyCount - 1;
  const regions = findSilentRegions(pcm);

  if (regions.length < needed) {
    console.warn(`[tts:split] need ${needed} boundaries, found ${regions.length} — fallback`);
    return null;
  }

  // Pick the N-1 longest silences, sort them back into timeline order
  const cuts = [...regions]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, needed)
    .sort((a, b) => a.startSample - b.startSample)
    .map(r => Math.floor((r.startSample + r.endSample) / 2) * 2); // byte offset at midpoint

  // Validate: every segment must be ≥ 0.3 s (14 400 bytes at 24 kHz 16-bit)
  const MIN_SEG_BYTES = SAMPLE_RATE * 2 * 0.3;
  const edges = [0, ...cuts, pcm.length];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] < MIN_SEG_BYTES) {
      console.warn(`[tts:split] segment ${i} too short (${edges[i+1]-edges[i]} bytes) — fallback`);
      return null;
    }
  }

  return edges.slice(0, -1).map((start, i) => pcm.subarray(start, edges[i + 1]));
}

/** Build merged prompt with batch-mode instructions. */
function buildBatchPrompt(texts: string[], language: "en" | "hi"): string {
  const base = language === "hi" ? STYLE_INSTRUCTIONS_HI : STYLE_INSTRUCTIONS_EN;

  const batchNote =
    `\nThis recording contains ${texts.length} independent news stories ` +
    `separated by "---". At each "---", pause silently for 1 second. ` +
    `Do NOT speak "---" aloud. Do NOT add transitions between stories.\n`;

  // Inject note right before the TRANSCRIPT marker
  const instructions = base.replace("### TRANSCRIPT\n", `### TRANSCRIPT${batchNote}`);
  return instructions + texts.join(BATCH_SEPARATOR);
}

/**
 * Synthesise a batch of story texts in one API call, split the resulting PCM,
 * and return individual WAV URLs. Falls back to individual calls on any error.
 *
 * @param log  Optional logger — errors are surfaced here so callers can show
 *             them in the admin log stream instead of silently dropping them.
 */
export async function googleTTSBatch(
  items: { text: string; filename: string }[],
  language: "en" | "hi",
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  if (items.length === 0) return [];

  // Single-item shortcut — no splitting needed
  if (items.length === 1) {
    try {
      return [await googleTTS(items[0].text, items[0].filename, language)];
    } catch (err: any) {
      log(`    ✗ ${items[0].filename}: ${err.message?.slice(0, 160)}`);
      return [""];
    }
  }

  const tag = `${language.toUpperCase()} batch(${items.length})`;
  console.log(`[tts:batch] ${tag} starting`);

  let segments: Buffer[] | null = null;

  try {
    const prompt = buildBatchPrompt(items.map(i => i.text), language);
    const pcm    = await synthesizeWithRetry(prompt, tag);
    segments     = splitPcmAtSilences(pcm, items.length);
  } catch (err: any) {
    const msg = `[tts:batch] ${tag} synthesis failed: ${err.message?.slice(0, 200)}`;
    console.warn(msg);
    log(`  ⚠ ${msg}`);
  }

  // Fallback to individual calls if batch synthesis or splitting failed
  if (!segments) {
    log(`  ↩ ${tag} — falling back to individual calls`);
    return individualFallback(items, language, log);
  }

  // Save each segment
  const urls: string[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const url = await saveWav(pcmToWav(segments[i]), items[i].filename);
      urls.push(url);
    } catch (err: any) {
      const msg = `save failed for ${items[i].filename}: ${err.message}`;
      console.warn(`[tts:batch] ${msg}`);
      log(`  ✗ ${msg}`);
      // Last-resort: synthesise this story individually
      try {
        urls.push(await googleTTS(items[i].text, items[i].filename, language));
      } catch {
        urls.push("");
      }
    }
  }

  const ok = urls.filter(Boolean).length;
  console.log(`[tts:batch] ${tag} done — ${ok}/${items.length} saved`);
  return urls;
}

/** Individual-call fallback used when batch synthesis or splitting fails. */
async function individualFallback(
  items: { text: string; filename: string }[],
  language: "en" | "hi",
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const urls: string[] = [];
  for (const item of items) {
    try {
      urls.push(await googleTTS(item.text, item.filename, language));
    } catch (err: any) {
      const msg = `✗ ${item.filename}: ${err.message?.slice(0, 160)}`;
      console.warn(`[tts:fallback] ${msg}`);
      log(`    ${msg}`);
      urls.push("");
    }
  }
  return urls;
}
