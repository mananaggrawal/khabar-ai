import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Splits text at sentence boundaries to fit ElevenLabs' per-request limit.
function chunkText(text: string, maxChars = 4500): string[] {
  const chunks: string[] = [];
  let current = "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? " " : "") + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function callElevenLabsTTS(
  text: string,
  voiceId: string,
  apiKey: string,
): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS ${res.status}: ${err.slice(0, 300)}`);
  }

  return res.arrayBuffer();
}

/**
 * Generates MP3 audio for today's briefing monologue.
 * Chunks the script → ElevenLabs TTS per chunk → concatenate bytes →
 * write to public/audio/{id}.mp3 (served as static file by the dev server).
 *
 * For production: replace the writeFile section with a Supabase Storage upload.
 */
export const generateBriefingAudio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ briefingId: z.string().uuid() }))
  .handler(async ({ data, context }: any): Promise<{ audioUrl: string }> => {
    const { supabase, userId } = context;

    const { data: briefing } = await supabase
      .from("briefings")
      .select("audio_url, monologue_script")
      .eq("id", data.briefingId)
      .eq("user_id", userId)
      .single();

    if (!briefing) throw new Error("Briefing not found");
    if (briefing.audio_url) return { audioUrl: briefing.audio_url as string };

    const script = briefing.monologue_script as string | null;
    if (!script) throw new Error("Briefing has no monologue script");

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");

    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "nPczCjzI2devNBz1zQrb";
    const chunks = chunkText(script);
    console.log(`[tts] ${chunks.length} chunk(s) for briefing ${data.briefingId}`);

    const buffers = await Promise.all(
      chunks.map((c) => callElevenLabsTTS(c, voiceId, apiKey)),
    );

    // Concatenate MP3 byte arrays (boundary-concatenated MP3 plays fine in browsers)
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // Write to public/audio/ — the dev server serves this directory as static files.
    // TODO for production: upload to Supabase Storage and use its public URL instead.
    const audioDir = join(process.cwd(), "public", "audio");
    await mkdir(audioDir, { recursive: true });
    const filename = `${data.briefingId}.mp3`;
    await writeFile(join(audioDir, filename), Buffer.from(merged));
    const audioUrl = `/audio/${filename}`;

    await supabase
      .from("briefings")
      .update({ audio_url: audioUrl })
      .eq("id", data.briefingId);

    console.log(`[tts] done — ${(total / 1024).toFixed(0)} KB → ${audioUrl}`);
    return { audioUrl };
  });
