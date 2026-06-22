/**
 * Edge TTS — Microsoft's neural voices via the msedge-tts package.
 *
 * Completely free, no API key required.
 * EN voice: en-IN-PrabhatNeural (Indian English male)
 * HI voice: hi-IN-MadhurNeural  (Hindi male)
 * Output: MP3 @ 24 kHz (stored as .mp3)
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

const VOICE_EN = "en-IN-PrabhatNeural";
const VOICE_HI = "hi-IN-MadhurNeural";

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
): Promise<{ url: string; durationSec: number }> {
  const durationSec = estimateMp3Duration(mp3.length);
  const kb = (mp3.length / 1024).toFixed(0);

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.mp3`), mp3);
    console.log(`[tts/edge] saved ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.mp3`, durationSec };
  }

  const url = await uploadAudio(`${filename}.mp3`, mp3, "audio/mpeg");
  console.log(`[tts/edge] uploaded ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}

export async function edgeTTS(
  script: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const lang  = filename.endsWith("-hi") ? "hi" : "en";
  const voice = lang === "hi" ? VOICE_HI : VOICE_EN;
  const mp3   = await synthesize(script, voice);
  return saveMp3(mp3, filename);
}
