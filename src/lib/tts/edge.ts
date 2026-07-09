/**
 * Edge TTS — Microsoft's neural voices via the msedge-tts package.
 *
 * Completely free, no API key required.
 * Two voices per language, alternated by story position in the briefing
 * (1st story = A, 2nd = B, 3rd = A, …) so no two consecutive stories share
 * a voice. Falls back to a per-story-ID hash split when no position is
 * available (e.g. Kokoro's Hindi fallback path).
 *
 * Voice roster (A = index 0, B = index 1):
 *   EN: en-IN-PrabhatNeural (male)   | en-IN-NeerjaExpressiveNeural (female, expressive)
 *   HI: hi-IN-MadhurNeural (male)    | hi-IN-SwaraNeural (female)
 *
 * Output: MP3 @ 24 kHz 96 kbps mono
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// Two voices per language: [A, B]. A/B chosen by story-ID hash (50/50 split).
const VOICES: Record<string, [string, string]> = {
  en: ["en-IN-PrabhatNeural",   "en-IN-NeerjaExpressiveNeural"],
  hi: ["hi-IN-MadhurNeural",    "hi-IN-SwaraNeural"],
};

/**
 * Deterministically pick voice A or B for a given story.
 * Uses the first hex digit of the story ID — 0-7 → A, 8-f → B.
 * Same story always gets the same voice across re-runs.
 */
function pickVoice(lang: string, storyId: string): string {
  const pair = VOICES[lang] ?? VOICES.en;
  const firstHex = parseInt(storyId[0] ?? "0", 16); // 0–15
  const variant  = firstHex < 8 ? 0 : 1;            // 50/50 split
  return pair[variant];
}

/**
 * Strictly alternate voice A/B by position in the briefing (0=A, 1=B, 2=A, …)
 * so consecutive stories in playback order never share the same voice.
 * Used instead of pickVoice() whenever a position index is available.
 */
function pickVoiceByIndex(lang: string, index: number): string {
  const pair = VOICES[lang] ?? VOICES.en;
  return pair[index % 2];
}

// Estimate duration from MP3 bitrate (96 kbps = 12 KB/s)
function estimateMp3Duration(bytes: number): number {
  return bytes / (96_000 / 8);
}

// Speak a bit faster than default for a snappier, news-anchor pace.
// Relative percentage per SSML prosody rate. Override via EDGE_TTS_RATE.
const TTS_RATE = process.env.EDGE_TTS_RATE ?? "+12%";

// msedge-tts inserts our text RAW into its SSML, so escape XML specials and use
// SSML to fix pronunciation. Acronyms like "US" are otherwise read as the word
// "us"; spell them out letter-by-letter.
function ssmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Acronyms to spell out (read as letters, not as a word). Order: longest first.
const SPELL_OUT = ["USA", "UAE", "US", "UK", "UN", "EU"];

function prepareSpoken(text: string): string {
  let t = ssmlEscape(text);
  // normalise dotted forms first: U.S.A. → USA, U.S. → US, etc.
  t = t
    .replace(/\bU\.S\.A\./g, "USA")
    .replace(/\bU\.S\.(?!A)/g, "US")
    .replace(/\bU\.K\./g, "UK")
    .replace(/\bU\.N\./g, "UN")
    .replace(/\bE\.U\./g, "EU");
  // spell out whole-word acronyms via SSML say-as
  t = t.replace(new RegExp(`\\b(${SPELL_OUT.join("|")})\\b`, "g"),
    (m) => `<say-as interpret-as="characters">${m}</say-as>`);
  return t;
}

const TTS_TIMEOUT_MS = 25_000;

// One synthesis attempt with a hard timeout (the websocket can hang silently).
function synthesizeOnce(input: string, voice: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (err) reject(err); else resolve(buf!);
    };
    const timer = setTimeout(() => finish(new Error("Edge TTS timeout")), TTS_TIMEOUT_MS);
    (async () => {
      try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(input, { rate: TTS_RATE });
        const chunks: Buffer[] = [];
        audioStream.on("data", (c: Buffer) => chunks.push(c));
        audioStream.on("end", () => finish(null, Buffer.concat(chunks)));
        audioStream.on("error", (e: any) => finish(e instanceof Error ? e : new Error(String(e))));
      } catch (e: any) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

// Retry transient failures (websocket drops, EAI_AGAIN, timeouts) and treat an
// empty/too-small result as a failure to retry. Last attempt falls back to plain
// text in case the SSML transform is what Edge is choking on.
// 4 attempts (was 3, 2026-07-05) with longer backoff — under full-run concurrency
// (5 parallel TTS jobs × ~100+ stories × up to 4 languages) a small percentage of
// clips still exhausted 3 attempts and were permanently skipped; one more attempt
// with more spacing catches most of those without materially slowing the run
// (this only fires for the ~1-2% of clips that were already retrying).
async function synthesize(script: string, voice: string): Promise<Buffer> {
  const ssml = prepareSpoken(script);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
    const input = attempt < 3 ? ssml : ssmlEscape(script); // final attempt: plain
    try {
      const buf = await synthesizeOnce(input, voice);
      if (buf && buf.length >= 2000) return buf;
      lastErr = new Error(`empty audio (${buf?.length ?? 0} bytes)`);
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("Edge TTS failed");
}

async function saveMp3(
  mp3: Buffer,
  filename: string,
  voice: string,
): Promise<{ url: string; durationSec: number }> {
  const durationSec = estimateMp3Duration(mp3.length);
  const kb = (mp3.length / 1024).toFixed(0);

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.mp3`), mp3);
    console.log(`[tts/edge] ✓ ${filename}.mp3 — voice: ${voice}, ${kb}KB, ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.mp3`, durationSec };
  }

  const url = await uploadAudio(`${filename}.mp3`, mp3, "audio/mpeg");
  console.log(`[tts/edge] ✓ ${filename}.mp3 — voice: ${voice}, ${kb}KB, ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}

export async function edgeTTS(
  script: string,
  filename: string,
  index?: number,
): Promise<{ url: string; durationSec: number }> {
  // Filename format: "YYYY-MM-DD-<storyId16>-<lang>"
  // e.g. "2026-06-22-3a9f1b2c4d5e6f7a-hi"
  const parts = filename.split("-");
  const lang    = parts[parts.length - 1] ?? "en";         // last segment
  const storyId = parts[parts.length - 2] ?? "";           // second-to-last = 16-char hex ID
  // Alternate strictly by position in the briefing when an index is given
  // (normal case, from generateAllTTS); fall back to the old per-story hash
  // split for callers that don't have a position (e.g. Kokoro's Hindi fallback).
  const voice   = index !== undefined ? pickVoiceByIndex(lang, index) : pickVoice(lang, storyId);

  console.log(`[tts/edge] ${lang.toUpperCase()} → ${voice} (story: ${storyId.slice(0, 8)}…)`);
  const mp3 = await synthesize(script, voice);
  // Reject empty/near-empty output — even the shortest valid clip is tens of KB.
  // An empty file would still upload and show a play button that plays nothing.
  if (!mp3 || mp3.length < 2000) {
    throw new Error(`Edge TTS produced empty audio (${mp3?.length ?? 0} bytes)`);
  }
  return saveMp3(mp3, filename, voice);
}
