/**
 * OpenAI TTS — /v1/audio/speech
 *
 * Model: tts-1 (fast) or tts-1-hd (higher quality), set via OPENAI_TTS_MODEL env var.
 * Voice: configurable per language via OPENAI_TTS_VOICE_EN / OPENAI_TTS_VOICE_HI env vars.
 *        Defaults: onyx (deep male) for EN, onyx for HI.
 *
 * OpenAI TTS handles Hindi natively — the model detects language from text.
 * Output: MP3 @ 24kHz (OpenAI default)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

function getKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY is not set");
  return k;
}

function getModel(): string {
  return process.env.OPENAI_TTS_MODEL ?? "tts-1";
}

// Voice defaults per language — override via env vars
const DEFAULT_VOICE: Record<string, string> = {
  en: "onyx",   // deep, authoritative male
  hi: "onyx",   // same — OpenAI detects Hindi from text
};

function getVoice(lang: string): string {
  const envKey = `OPENAI_TTS_VOICE_${lang.toUpperCase()}`;
  return process.env[envKey] ?? DEFAULT_VOICE[lang] ?? "onyx";
}

// Estimate MP3 duration from word count (~150 WPM)
function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return (words / 150) * 60;
}

async function synthesize(script: string, voice: string): Promise<Buffer> {
  const model = getModel();
  const res = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model,
      input: script,
      voice,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`OpenAI TTS ${res.status}: ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function saveMp3(
  mp3: Buffer,
  filename: string,
  voice: string,
): Promise<{ url: string; durationSec: number }> {
  const durationSec = estimateDuration(filename); // fallback — caller can override
  const kb = (mp3.length / 1024).toFixed(0);

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.mp3`), mp3);
    console.log(`[tts/openai] ✓ ${filename}.mp3 — voice: ${voice}, ${kb}KB`);
    return { url: `/audio/${filename}.mp3`, durationSec };
  }

  const url = await uploadAudio(`${filename}.mp3`, mp3, "audio/mpeg");
  console.log(`[tts/openai] ✓ ${filename}.mp3 — voice: ${voice}, ${kb}KB`);
  return { url, durationSec };
}

export async function openaiTTS(
  script: string,
  filename: string,
): Promise<{ url: string; durationSec: number }> {
  // Filename format: "YYYY-MM-DD-<storyId16>-<lang>"
  const parts = filename.split("-");
  const lang  = parts[parts.length - 1] ?? "en";
  const voice = getVoice(lang);

  console.log(`[tts/openai] ${lang.toUpperCase()} → ${voice} | model: ${getModel()}`);

  const mp3 = await synthesize(script, voice);
  const durationSec = estimateDuration(script);

  const kb = (mp3.length / 1024).toFixed(0);

  if (LOCAL_MODE) {
    const dir = join(process.cwd(), "public", "audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${filename}.mp3`), mp3);
    console.log(`[tts/openai] saved ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
    return { url: `/audio/${filename}.mp3`, durationSec };
  }

  const url = await uploadAudio(`${filename}.mp3`, mp3, "audio/mpeg");
  console.log(`[tts/openai] uploaded ${filename}.mp3 — ${kb}KB ~${durationSec.toFixed(1)}s`);
  return { url, durationSec };
}
