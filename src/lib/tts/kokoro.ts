/**
 * Kokoro TTS — 82M parameter open-source model via kokoro-js.
 *
 * Completely free, runs locally (no API key).
 * Downloads ~100MB model from Hugging Face on first use (cached after that).
 * EN voice: bm_george (British male — best quality available)
 * HI: no Hindi voice in Kokoro → falls back to Edge TTS hi-IN-MadhurNeural
 * Output: WAV @ 24 kHz
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";
import { edgeTTS } from "./edge";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";
const MODEL_ID   = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Singleton — model stays loaded in memory across calls (saves re-download)
let _tts: any | null = null;

async function getModel(): Promise<any> {
  if (_tts) return _tts;
  console.log("[tts/kokoro] loading model (first run downloads ~100MB)…");
  const { KokoroTTS } = await import("kokoro-js");
  _tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });
  console.log("[tts/kokoro] model ready");
  return _tts;
}

async function saveWav(
  wavBuffer: Buffer,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  // WAV header: 44 bytes; 16-bit mono @ 24 kHz
  const durationSec = Math.max(0, (wavBuffer.length - 44) / 2 / 24_000);
  const kb = (wavBuffer.length / 1024).toFixed(0);

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.wav`), wavBuffer);
    console.log(`[tts/kokoro] saved ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.wav`, durationSec };
  }

  const url = await uploadAudio(`${filename}.wav`, wavBuffer);
  console.log(`[tts/kokoro] uploaded ${filename}.wav — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}

export async function kokoroTTS(
  script: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  const lang = filename.endsWith("-hi") ? "hi" : "en";

  // Kokoro has no Hindi voice — delegate to Edge TTS
  if (lang === "hi") {
    return edgeTTS(script, filename);
  }

  const model = await getModel();
  const audio  = await model.generate(script, { voice: "bm_george" });

  // RawAudio.toWav() returns a Uint8Array / Buffer-like
  const wavData: Uint8Array = audio.toWav();
  return saveWav(Buffer.from(wavData), filename);
}
