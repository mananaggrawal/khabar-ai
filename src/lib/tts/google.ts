/**
 * Gemini 3.1 Flash TTS — natural language style control.
 * Voice: Algieba (Smooth, Indian English)
 * Output: PCM → WAV, saved to public/audio/
 *
 * Pricing (paid tier): $1.00/1M input tokens · $20.00/1M audio output tokens
 * (25 audio tokens/sec → ~$0.03 per minute of speech)
 * Free tier: no charge, rate-limited.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadAudio } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL   = "gemini-3.1-flash-tts-preview";
const VOICE   = "Algieba";   // Smooth — Indian English
const SAMPLE_RATE = 24000;   // Hz (Gemini TTS always outputs 24kHz PCM)

const GEMINI_TTS_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

function getKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// ── Style prompt ──────────────────────────────────────────────────────────────
//
// Gemini TTS is "controllable" — style instructions embedded in the content
// tell the model HOW to speak the transcript.
// Per Google docs, label the transcript section clearly to avoid the model
// reading the instructions aloud.

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

// ── Synthesis ─────────────────────────────────────────────────────────────────

async function synthesize(text: string, language: 'en' | 'hi' = 'en'): Promise<Buffer> {
  const styleInstructions = language === 'hi' ? STYLE_INSTRUCTIONS_HI : STYLE_INSTRUCTIONS_EN;
  const fullPrompt = styleInstructions + text;

  const res = await fetch(GEMINI_TTS_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullPrompt }], role: "user" }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: VOICE },
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    throw new Error(`Gemini TTS ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error(`Gemini TTS: no audio data in response. Finish reason: ${data.candidates?.[0]?.finishReason}`);
  }
  return Buffer.from(part.inlineData.data, "base64");
}

// ── PCM → WAV ─────────────────────────────────────────────────────────────────
// Gemini TTS returns raw 16-bit signed little-endian PCM at 24kHz.
// Wrap it in a standard WAV header so browsers can play it.

function pcmToWav(pcm: Buffer): Buffer {
  const dataSize   = pcm.length;
  const byteRate   = SAMPLE_RATE * 1 * 2; // sampleRate × channels × bytesPerSample
  const blockAlign = 1 * 2;               // channels × bytesPerSample
  const wav        = Buffer.alloc(44 + dataSize);

  wav.write("RIFF",   0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE",   8, "ascii");
  wav.write("fmt ",  12, "ascii");
  wav.writeUInt32LE(16,           16); // PCM chunk size
  wav.writeUInt16LE(1,            20); // PCM format
  wav.writeUInt16LE(1,            22); // mono
  wav.writeUInt32LE(SAMPLE_RATE,  24);
  wav.writeUInt32LE(byteRate,     28);
  wav.writeUInt16LE(blockAlign,   32);
  wav.writeUInt16LE(16,           34); // 16-bit
  wav.write("data",  36, "ascii");
  wav.writeUInt32LE(dataSize,     40);
  pcm.copy(wav, 44);

  return wav;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
// Gemini TTS occasionally returns text tokens instead of audio (500 error).
// Docs recommend automated retry logic.

async function synthesizeWithRetry(text: string, language: 'en' | 'hi' = 'en', maxAttempts = 4): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await synthesize(text, language);
    } catch (err: any) {
      lastErr = err;
      const msg: string = err.message ?? "";
      const is429 = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      console.warn(`[tts] attempt ${attempt}/${maxAttempts} failed${is429 ? " (rate limit)" : ""}: ${msg}`);
      if (attempt < maxAttempts) {
        // 429 = rate limit: back off aggressively (30s, then 60s)
        const delay = is429 ? 30_000 * attempt : 1000 * attempt;
        console.warn(`[tts] waiting ${delay / 1000}s before retry…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr!;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesise `text` → WAV saved at public/audio/{filename}.wav
 * Returns the public URL path e.g. "/audio/briefing-2026-06-18-india-national.wav"
 * Exported as `googleTTS` to keep the rest of the codebase unchanged.
 */
export async function googleTTS(text: string, filename: string, language: 'en' | 'hi' = 'en'): Promise<string> {
  console.log(`[tts] ${filename} (${language}): ${text.length} chars, voice=${VOICE}`);

  const pcm = await synthesizeWithRetry(text, language);
  const wav = pcmToWav(pcm);
  const durationSec = (pcm.length / 2 / SAMPLE_RATE).toFixed(1);

  if (LOCAL_MODE) {
    // Local dev — write to public/audio/ (served by Vite)
    const audioDir = join(process.cwd(), "public", "audio");
    await mkdir(audioDir, { recursive: true });
    await writeFile(join(audioDir, `${filename}.wav`), wav);
    console.log(`[tts] saved local ${filename}.wav — ${(wav.length / 1024).toFixed(0)} KB, ~${durationSec}s`);
    return `/audio/${filename}.wav`;
  }

  // Production — upload to Supabase Storage
  const url = await uploadAudio(`${filename}.wav`, wav);
  console.log(`[tts] uploaded ${filename}.wav to storage — ${(wav.length / 1024).toFixed(0)} KB, ~${durationSec}s`);
  return url;
}
