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

// ── Daily quota guard ─────────────────────────────────────────────────────────
// Once the per-model-per-day limit is hit, every subsequent API call that day
// will also fail. Flip this flag on first quota error so we skip the network
// entirely for the rest of the run — avoids burning retries on dead quota.
let _dailyQuotaExhausted = false;

/** True once a per_model_per_day quota error has been seen this process run. */
export const isDailyQuotaExhausted = () => _dailyQuotaExhausted;

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
      const isBilling = msg.includes("prepayment") || msg.includes("credits are depleted") || msg.includes("billing");
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

