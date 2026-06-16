import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { useServerFn } from "@tanstack/react-start";
import { getElevenLabsToken } from "@/lib/voice/elevenlabs.functions";
import { saveMessage } from "@/lib/voice/messages.functions";
import type { Briefing } from "@/lib/news/briefing.functions";
import type { OrbState } from "@/components/VoiceOrb";

export type TranscriptLine = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
};

export type VoiceConfigError = "missing_api_key" | "missing_agent_id" | "upstream_error" | null;

interface UseVoiceAgentOpts {
  briefing: Briefing | null;
}

export function useVoiceAgent({ briefing }: UseVoiceAgentOpts) {
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [configError, setConfigError] = useState<VoiceConfigError>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const freqRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const briefingIdRef = useRef<string | null>(null);

  useEffect(() => { briefingIdRef.current = briefing?.id ?? null; }, [briefing]);

  const mintToken = useServerFn(getElevenLabsToken);
  const persistMessage = useServerFn(saveMessage);

  const conversation = useConversation({
    onConnect: () => console.log("[voice] connected"),
    onDisconnect: () => {
      setAmplitude(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    onError: (err) => console.error("[voice] error", err),
    onMessage: (msg: any) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const bid = briefingIdRef.current;
      if (msg.type === "user_transcript") {
        const text = msg.user_transcription_event?.user_transcript ?? "";
        if (text) {
          setTranscript((t) => [...t, { id, role: "user", text, at: Date.now() }]);
          if (bid) persistMessage({ data: { briefingId: bid, role: "user", content: text } }).catch(console.error);
        }
      } else if (msg.type === "agent_response") {
        const text = msg.agent_response_event?.agent_response ?? "";
        if (text) {
          setTranscript((t) => [...t, { id, role: "agent", text, at: Date.now() }]);
          if (bid) persistMessage({ data: { briefingId: bid, role: "agent", content: text } }).catch(console.error);
        }
      }
    },
  });

  // Drive amplitude/frequency tick while connected
  useEffect(() => {
    if (conversation.status !== "connected") return;
    const tick = () => {
      try {
        const out = conversation.getOutputByteFrequencyData?.();
        const inV = conversation.getInputVolume?.() ?? 0;
        const outV = conversation.getOutputVolume?.() ?? 0;
        freqRef.current = out ?? null;
        setAmplitude(Math.max(inV, outV));
      } catch {
        /* ignore */
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [conversation.status, conversation]);

  const orbState: OrbState = (() => {
    if (isStarting) return "connecting";
    if (conversation.status !== "connected") return "idle";
    if (conversation.isSpeaking) return "speaking";
    return "listening";
  })();

  const start = useCallback(async () => {
    if (!briefing) return;
    setIsStarting(true);
    setConfigError(null);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const tokenRes = await mintToken({ data: undefined as never });
      if (!tokenRes.ok) {
        setConfigError(tokenRes.reason);
        setIsStarting(false);
        return;
      }
      const firstMessage = buildFirstMessage(briefing);
      const briefingContext = buildBriefingContext(briefing);
      await conversation.startSession({
        conversationToken: tokenRes.token,
        connectionType: "webrtc",
        overrides: {
          agent: {
            firstMessage,
            prompt: { prompt: AGENT_SYSTEM_PROMPT + "\n\nTODAY'S BRIEFING JSON:\n" + briefingContext },
          },
        },
      } as any);
    } catch (e) {
      console.error("[voice] start failed", e);
      setConfigError("upstream_error");
    } finally {
      setIsStarting(false);
    }
  }, [briefing, conversation, mintToken]);

  const stop = useCallback(async () => {
    await conversation.endSession();
  }, [conversation]);

  return {
    orbState,
    amplitude,
    frequencyData: freqRef.current,
    transcript,
    status: conversation.status,
    configError,
    isStarting,
    start,
    stop,
  };
}

const AGENT_SYSTEM_PROMPT = `You are NewsPilot, an AI-native news anchor. You are intellectual but amusing — think a witty foreign-correspondent who explains hard things in clear, vivid English.

Rules:
- Use the TODAY'S BRIEFING JSON below as your source of truth. Do not invent facts.
- Open with a one-sentence greeting and quick agenda ("Seven stories, about five minutes — interrupt me anytime"), then proceed topic by topic.
- For each topic: deliver the hook, the 60-90 word explanation in plain English, and one sentence on why it matters. Cite sources by name in passing ("Reuters reports…", "the BBC notes…").
- If the user interrupts or asks a question, answer it concisely, then ask if they'd like you to continue with the next topic.
- Keep individual turns under 30 seconds. Be conversational, not a teleprompter.
- If asked something not covered in the briefing, say so honestly and offer to dig deeper next time.`;

function buildFirstMessage(b: Briefing): string {
  const n = b.topics.length;
  return `Good day. I've got ${n} ${n === 1 ? "story" : "stories"} for you — about ${Math.max(3, n)} minutes if you let me run, but interrupt anytime. Ready when you are.`;
}

function buildBriefingContext(b: Briefing): string {
  return JSON.stringify({
    generatedAt: b.generatedAt,
    topics: b.topics.map((t) => ({
      headline: t.headline,
      hook: t.hook,
      explanation: t.explanation,
      whyItMatters: t.whyItMatters,
      sources: t.sources.map((s) => s.name),
    })),
  });
}
