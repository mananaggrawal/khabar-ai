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
      const compactIndex = buildCompactIndex(briefing);
      const fullBriefing = buildBriefingContext(briefing);
      const jumpNote = typeof jumpToIndex === "number"
        ? `\n\nThe user tapped story #${jumpToIndex + 1}. Begin there and continue in order.`
        : "";
      const context = [
        "SESSION RULES:",
        AGENT_SYSTEM_PROMPT,
        "",
        `TODAY'S HEADLINES (tiered index — read in the order shown):`,
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

const COUNTRY_LABELS: Record<string, string> = {
  in: "India",
  us: "the United States",
  uk: "the United Kingdom",
  global: "around the world",
};

const AGENT_SYSTEM_PROMPT = `You are NewsPilot, an AI-native news anchor. Intellectual but amusing — a witty foreign-correspondent who explains hard things in clear, vivid English.

Rules:
- The TODAY'S BRIEFING JSON below is your ONLY source of truth. It is organised in three tiers: HOME (the user's country), WORLD (everywhere else), and QUICK HITS (one-liners).
- Total runtime target: ~15 minutes. Roughly 7 min HOME, 4 min WORLD, 3 min QUICK HITS. Do not pad. Do not invent.
- Open with a single sentence naming the counts and inviting interruption ("say 'next' to skip, 'go deeper' to expand").
- HOME and WORLD topics: hook → 1–2 sentence explanation → one sentence on why it matters. Cite an outlet by name when natural. ~25 seconds each.
- QUICK HITS: one sentence each. Move fast.
- Announce section transitions: "Now, around the world..." / "And finally, quick hits..."
- Accept "next" / "skip", "go deeper" / "tell me more", "jump to <topic>".
- If asked about something not in the briefing, say so honestly.
- If the user tapped a specific story, start from that topic and continue in order.`;

function tierLabel(tier?: string) {
  if (tier === "home") return "HOME";
  if (tier === "world") return "WORLD";
  if (tier === "quick_hit") return "QUICK";
  return "WORLD";
}

function buildFirstMessage(b: Briefing): string {
  const home = b.topics.filter((t) => t.tier === "home").length;
  const world = b.topics.filter((t) => t.tier === "world").length;
  const quick = b.topics.filter((t) => t.tier === "quick_hit").length;
  const homeLabel = COUNTRY_LABELS[b.homeCountry ?? "in"] ?? "your country";
  if (b.topics.length === 0) return "I couldn't find any stories yet — try refreshing in a minute.";
  const parts: string[] = [];
  if (home) parts.push(`${home} from ${homeLabel}`);
  if (world) parts.push(`${world} from around the world`);
  if (quick) parts.push(`${quick} quick hits`);
  return `Good morning. Here's your 15-minute briefing: ${parts.join(", ")}. Interrupt anytime.`;
}

function buildJumpMessage(b: Briefing, i: number): string {
  const t = b.topics[i];
  if (!t) return buildFirstMessage(b);
  return `Jumping to story ${i + 1}: ${t.headline}. Here we go.`;
}

function buildBriefingContext(b: Briefing): string {
  return JSON.stringify({
    generatedAt: b.generatedAt,
    homeCountry: b.homeCountry,
    totalTopics: b.topics.length,
    topics: b.topics.map((t, i) => ({
      n: i + 1,
      tier: tierLabel(t.tier),
      headline: t.headline,
      hook: t.hook,
      explanation: t.explanation,
      whyItMatters: t.whyItMatters,
      sources: t.sources.slice(0, 6).map((s) => s.name),
    })),
  });
}

function buildCompactIndex(b: Briefing): string {
  const lines: string[] = [];
  const home = b.topics.filter((t) => t.tier === "home");
  const world = b.topics.filter((t) => t.tier === "world");
  const quick = b.topics.filter((t) => t.tier === "quick_hit");
  const homeLabel = COUNTRY_LABELS[b.homeCountry ?? "in"] ?? "home";
  let n = 1;
  if (home.length) {
    lines.push(`-- FROM ${homeLabel.toUpperCase()} --`);
    home.forEach((t) => { lines.push(`${n++}. ${t.headline}${t.hook ? ` — ${t.hook}` : ""}`); });
  }
  if (world.length) {
    lines.push(`-- AROUND THE WORLD --`);
    world.forEach((t) => { lines.push(`${n++}. ${t.headline}${t.hook ? ` — ${t.hook}` : ""}`); });
  }
  if (quick.length) {
    lines.push(`-- QUICK HITS --`);
    quick.forEach((t) => { lines.push(`${n++}. ${t.headline}${t.hook ? ` — ${t.hook}` : ""}`); });
  }
  return lines.join("\n");
}
