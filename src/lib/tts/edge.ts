/**
 * Edge TTS — Microsoft's neural voices via the msedge-tts package.
 *
 * Completely free, no API key required.
 * Two voices per language for A/B quality testing — split deterministically
 * by story ID so results are consistent across re-runs.
 *
 * Voice roster (A = index 0, B = index 1):
 *   EN: en-IN-PrabhatNeural (male)   | en-IN-NeerjaExpressiveNeural (female, expressive)
 *   HI: hi-IN-MadhurNeural (male)    | hi-IN-SwaraNeural (female)
 *   TA: ta-IN-ValluvarNeural (male)   | ta-IN-PallaviNeural (female)
 *   MR: mr-IN-ManoharNeural (male)   | mr-IN-AarohiNeural (female)
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
  ta: ["ta-IN-ValluvarNeural",  "ta-IN-PallaviNeural"],
  mr: ["mr-IN-ManoharNeural",   "mr-IN-AarohiNeural"],
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

// Estimate duration from MP3 bitrate (96 kbps = 12 KB/s)
function estimateMp3Duration(bytes: number): number {
  return bytes / (96_000 / 8);
}

async function synthesize(script: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(script);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", resolve);
    audioStream.on("error", reject);
  });

  return Buffer.concat(chunks);
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
): Promise<{ url: string; durationSec: number }> {
  // Filename format: "YYYY-MM-DD-<storyId16>-<lang>"
  // e.g. "2026-06-22-3a9f1b2c4d5e6f7a-hi"
  const parts = filename.split("-");
  const lang    = parts[parts.length - 1] ?? "en";         // last segment
  const storyId = parts[parts.length - 2] ?? "";           // second-to-last = 16-char hex ID
  const voice   = pickVoice(lang, storyId);

  console.log(`[tts/edge] ${lang.toUpperCase()} → ${voice} (story: ${storyId.slice(0, 8)}…)`);
  const mp3 = await synthesize(script, voice);
  return saveMp3(mp3, filename, voice);
}
