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
  const pendingKickoffRef = useRef<{ context: string; opener: string } | null>(null);

  useEffect(() => { briefingIdRef.current = briefing?.id ?? null; }, [briefing]);

  const mintToken = useServerFn(getElevenLabsToken);
  const persistMessage = useServerFn(saveMessage);

  const conversation = useConversation({
    onConnect: () => {
      console.log("[voice] connected");
      const kickoff = pendingKickoffRef.current;
      pendingKickoffRef.current = null;
      if (!kickoff) return;
      try {
        conversation.sendContextualUpdate?.(kickoff.context);
        conversation.sendUserMessage?.(kickoff.opener);
      } catch (e) {
        console.warn("[voice] kickoff failed", e);
      }
    },
    onDisconnect: () => {
      setAmplitude(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    onError: (err: any) => {
      console.error("[voice] error", err);
      setConfigError("upstream_error");
    },
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

  const start = useCallback(async (jumpToIndex?: number) => {
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
      // No overrides — agent persona is configured in the ElevenLabs dashboard.
      // We inject briefing data and trigger the opener via contextual update + user message,
      // dispatched from onConnect once the WebRTC session is live.
      const compactIndex = buildCompactIndex(briefing);
      const fullBriefing = buildBriefingContext(briefing);
      const jumpNote = typeof jumpToIndex === "number"
        ? `\n\nThe user tapped story #${jumpToIndex + 1}. Begin there and continue in order.`
        : "";
      const context = [
        "SESSION RULES:",
        AGENT_SYSTEM_PROMPT,
        "",
        `TODAY'S HEADLINES (${briefing.topics.length} stories, compact index):`,
        compactIndex,
        "",
        "FULL BRIEFING DATA (use for explanations, why-it-matters, and sources):",
        fullBriefing,
        jumpNote,
      ].join("\n");
      const opener = typeof jumpToIndex === "number"
        ? buildJumpMessage(briefing, jumpToIndex)
        : buildFirstMessage(briefing);
      pendingKickoffRef.current = {
        context,
        opener: `Please begin the briefing now. Start with: "${opener}"`,
      };
      await conversation.startSession({
        conversationToken: tokenRes.token,
        connectionType: "webrtc",
      } as any);
    } catch (e) {
      console.error("[voice] start failed", e);
      setConfigError("upstream_error");
      pendingKickoffRef.current = null;
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
- The TODAY'S BRIEFING JSON below is your ONLY source of truth — every story today is in there, ordered by significance. Do not invent facts.
- Open with a one-sentence greeting that names the real count ("I've got 42 stories for you today — interrupt anytime, say 'next' to skip, 'go deeper' to expand"), then proceed in order.
- For each topic: 20–30 seconds spoken. Deliver hook → 1–2 sentence explanation → one sentence on why it matters. Cite an outlet by name when natural ("Reuters reports…", "the BBC notes…"). Don't read every source.
- After roughly every 10 stories, offer a brief check-in ("Want me to keep going or jump to a section?").
- Accept "next" / "skip" → move on. "Go deeper" / "tell me more" → expand the current topic. "Jump to <topic>" → search the list and switch.
- If the user asks something not in the briefing, say so honestly.
- You will be told via system message if the user tapped a specific story — start from that topic and continue.`;

function buildFirstMessage(b: Briefing): string {
  const n = b.topics.length;
  const minutes = Math.max(3, Math.round(n * 0.5));
  if (n === 0) return "I couldn't find any stories yet — try refreshing in a minute.";
  return `Good day. I've got ${n} ${n === 1 ? "story" : "stories"} for you today — roughly ${minutes} minutes end-to-end. Want me to run the whole briefing, or skim the headlines first? Either way, interrupt anytime.`;
}

function buildJumpMessage(b: Briefing, i: number): string {
  const t = b.topics[i];
  if (!t) return buildFirstMessage(b);
  return `Jumping to story ${i + 1} of ${b.topics.length}: ${t.headline}. Here we go.`;
}

function buildBriefingContext(b: Briefing): string {
  return JSON.stringify({
    generatedAt: b.generatedAt,
    totalTopics: b.topics.length,
    topics: b.topics.map((t, i) => ({
      n: i + 1,
      headline: t.headline,
      hook: t.hook,
      explanation: t.explanation,
      whyItMatters: t.whyItMatters,
      sources: t.sources.slice(0, 6).map((s) => s.name),
    })),
  });
}

function buildCompactIndex(b: Briefing): string {
  return b.topics
    .map((t, i) => `${i + 1}. ${t.headline}${t.hook ? ` — ${t.hook}` : ""}`)
    .join("\n");
}
