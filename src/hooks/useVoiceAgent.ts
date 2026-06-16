import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { useServerFn } from "@tanstack/react-start";
import { getElevenLabsToken } from "@/lib/voice/elevenlabs.functions";
import { saveMessage } from "@/lib/voice/messages.functions";
import { searchTopicLive } from "@/lib/news/search.functions";
import type { Briefing, BriefingTopic } from "@/lib/news/briefing.functions";
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
  const briefingRef = useRef<Briefing | null>(null);
  const pendingKickoffRef = useRef<{ context: string; opener: string } | null>(null);

  useEffect(() => {
    briefingIdRef.current = briefing?.id ?? null;
    briefingRef.current = briefing;
  }, [briefing]);

  const mintToken = useServerFn(getElevenLabsToken);
  const persistMessage = useServerFn(saveMessage);
  const liveSearch = useServerFn(searchTopicLive);

  const conversation = useConversation({
    clientTools: {
      // The agent calls this when the briefing pack doesn't cover a follow-up.
      // Register a matching tool on the ElevenLabs agent dashboard:
      //   name: searchTopic
      //   params: topicId (string), query (string)
      searchTopic: async (params: { topicId?: string; query?: string }) => {
        const b = briefingRef.current;
        const q = (params?.query ?? "").trim();
        if (!b || !q) return "No active briefing or empty query.";
        const topic =
          b.topics.find((t) => t.id === params?.topicId) ??
          b.topics[0];
        const headline = topic?.headline ?? "today's news";
        // Surface a small "looking it up" line in the transcript so the user
        // sees the agent is going to the web.
        setTranscript((t) => [
          ...t,
          {
            id: `${Date.now()}-search`,
            role: "agent",
            text: `🔎 Looking that up — "${q}"`,
            at: Date.now(),
          },
        ]);
        try {
          const res = await liveSearch({ data: { headline, query: q } });
          if (!res.ok || !res.answer) return res.answer || "No fresh sources found.";
          return res.sourceName
            ? `${res.answer} (Source: ${res.sourceName})`
            : res.answer;
        } catch (e) {
          console.error("[voice] searchTopic failed", e);
          return "I couldn't reach the web just now.";
        }
      },
    },
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

      // Resume: if no explicit jump, see if we already covered some topics in
      // a previous session for this briefing (in-memory transcript or
      // localStorage). Pick up from the next uncovered topic.
      let resumeIndex: number | undefined;
      let isResume = false;
      if (typeof jumpToIndex !== "number") {
        const covered = computeCoveredIndex(briefing, transcript, briefing.id);
        if (covered >= 0 && covered < briefing.topics.length - 1) {
          resumeIndex = covered + 1;
          isResume = true;
        }
      }
      const effectiveJump = typeof jumpToIndex === "number" ? jumpToIndex : resumeIndex;

      const compactIndex = buildCompactIndex(briefing);
      const fullBriefing = buildBriefingContext(briefing);
      const jumpNote = isResume && typeof effectiveJump === "number"
        ? `\n\nRESUMING a previous session. The user already heard stories 1 through ${effectiveJump}. Pick up at story #${effectiveJump + 1} and continue in order. Do NOT repeat the full intro — open with a brief "Picking up where we left off" line, then go.`
        : typeof effectiveJump === "number"
        ? `\n\nThe user tapped story #${effectiveJump + 1}. Begin there and continue in order.`
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
      const opener = isResume && typeof effectiveJump === "number"
        ? buildResumeMessage(briefing, effectiveJump)
        : typeof effectiveJump === "number"
        ? buildJumpMessage(briefing, effectiveJump)
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
  }, [briefing, conversation, mintToken, transcript]);

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

const AGENT_SYSTEM_PROMPT = `You are Khabar AI, an AI-native news anchor. Intellectual but warm and conversational — like a well-read friend catching you up over chai. Speak slowly, casually, with natural pauses. Avoid stiff broadcaster cadence; use everyday words.

Rules:
- The TODAY'S BRIEFING JSON below is your ONLY source of truth for the spoken brief. It is organised in three tiers: HOME (the user's country), WORLD (everywhere else), and QUICK HITS (one-liners).
- Total runtime target: ~15 minutes. Roughly 7 min HOME, 4 min WORLD, 3 min QUICK HITS. Do not pad. Do not invent.
- Open EXACTLY with: "Welcome to Khabar AI. We'll catch you up on what's happening and why it matters." Then in one short, casual sentence tell them what's in today's briefing and that they can interrupt anytime ("say 'next' to skip, 'go deeper' if you want more").
- For the spoken briefing, use each topic's "hook", "explanation", and "whyItMatters" fields.
- HOME and WORLD topics: hook → 1–2 sentence explanation → one sentence on why it matters. Cite an outlet by name when natural. ~25 seconds each. Speak slowly and naturally.
- QUICK HITS: one sentence each. Move fast but still casual.
- Announce section transitions casually: "Alright, now around the world…" / "And finally, the quick hits…"
- Accept "next" / "skip", "go deeper" / "tell me more", "jump to <topic>".
- If the user tapped a specific story, start from that topic and continue in order.
- If RESUMING a previous session, do NOT replay the welcome — just say something brief like "Picking up where we left off" and continue from the next story.

ANSWERING FOLLOW-UP QUESTIONS (very important):
- Each topic in the briefing JSON also carries a REFERENCE PACK: "deepBrief" (longer narrative), "background" (history/context), "keyFacts" (numbers, names, dates, direct quotes), "qa" (pre-answered likely questions), and "articleExcerpts" (raw passages from the original sources). When the user asks for more detail, "go deeper", "who said that", "how much", "what happened before", etc., draw your answer from THIS PACK first — it is grounded in the actual articles.
- "go deeper" / "tell me more" → expand using deepBrief + 1-2 keyFacts, in a natural conversational way (don't read the JSON).
- Specific factual questions → answer from keyFacts or qa when possible; cite the source name.
- If the pack truly doesn't cover the question, CALL THE "searchTopic" TOOL with { topicId: <current topic id>, query: <user's question> } to fetch a fresh answer from the live web. Say something brief like "let me look that up" before calling. Use the tool's returned text as your answer and cite the source it gives you.
- NEVER say "I don't have that information" or "I don't know" as a final answer. Either answer from the pack, or call searchTopic, or honestly say "let me check" and then call searchTopic.
- For questions completely unrelated to today's news, you may answer briefly from general knowledge, but prefer searchTopic for anything time-sensitive.`;

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
  if (b.topics.length === 0) return "Welcome to Khabar AI. I couldn't find any stories yet — try refreshing in a minute.";
  const parts: string[] = [];
  if (home) parts.push(`${home} from ${homeLabel}`);
  if (world) parts.push(`${world} from around the world`);
  if (quick) parts.push(`${quick} quick hits`);
  return `Welcome to Khabar AI. We'll catch you up on what's happening and why it matters. Today we've got ${parts.join(", ")} — interrupt anytime.`;
}

function buildJumpMessage(b: Briefing, i: number): string {
  const t = b.topics[i];
  if (!t) return buildFirstMessage(b);
  return `Jumping to story ${i + 1}: ${t.headline}. Here we go.`;
}

function buildResumeMessage(b: Briefing, i: number): string {
  const t = b.topics[i];
  if (!t) return buildFirstMessage(b);
  return `Picking up where we left off — story ${i + 1}: ${t.headline}.`;
}

const PROGRESS_KEY = "khabar.progress";

function loadProgress(briefingId: string): number {
  if (typeof window === "undefined") return -1;
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return -1;
    const obj = JSON.parse(raw) as { id?: string; covered?: number };
    return obj.id === briefingId && typeof obj.covered === "number" ? obj.covered : -1;
  } catch { return -1; }
}

function saveProgress(briefingId: string, covered: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify({ id: briefingId, covered }));
  } catch { /* ignore */ }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function computeCoveredIndex(
  b: Briefing,
  transcript: TranscriptLine[],
  briefingId: string,
): number {
  let covered = loadProgress(briefingId);
  const agentText = transcript.filter((t) => t.role === "agent").map((t) => normalize(t.text)).join(" \n ");
  if (agentText) {
    b.topics.forEach((topic, idx) => {
      const key = normalize(topic.headline).slice(0, 40);
      if (key.length >= 8 && agentText.includes(key)) {
        if (idx > covered) covered = idx;
      }
    });
    saveProgress(briefingId, covered);
  }
  return covered;
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
