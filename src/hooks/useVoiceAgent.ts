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

export type VoiceConfigError = "missing_api_key" | "missing_agent_id" | "upstream_error" | "disconnected_early" | null;
export type VoiceErrorDetail = { reason: VoiceConfigError; detail?: string } | null;

interface UseVoiceAgentOpts {
  briefing: Briefing | null;
}

export function useVoiceAgent({ briefing }: UseVoiceAgentOpts) {
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [configError, setConfigError] = useState<VoiceConfigError>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const freqRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const briefingIdRef = useRef<string | null>(null);
  const briefingRef = useRef<Briefing | null>(null);
  const pendingKickoffRef = useRef<{ parts: string[]; opener: string } | null>(null);
  const autoStartPromptRef = useRef<string | null>(null);
  const autoStartSentRef = useRef(false);
  const autoStartTimerRef = useRef<number | null>(null);
  const agentSpokeRef = useRef(false);
  const connectedAtRef = useRef<number>(0);
  const lastSdkErrorRef = useRef<string | null>(null);

  useEffect(() => {
    briefingIdRef.current = briefing?.id ?? null;
    briefingRef.current = briefing;
  }, [briefing]);

  const reportError = useCallback((reason: VoiceConfigError, detail?: string) => {
    console.error("[voice] error surfaced:", reason, detail);
    setConfigError(reason);
    if (detail) setErrorDetail(detail);
  }, []);

  useEffect(() => {
    const captureSdkCrash = (raw: unknown) => {
      const detail = raw instanceof Error ? raw.message : String(raw);
      if (!/error_type|ElevenLabs|LiveKit|voice|conversation/i.test(detail)) return;
      reportError(
        "upstream_error",
        `Voice SDK runtime error: ${detail}. If this repeats, the agent is returning an invalid error packet before audio starts.`,
      );
    };
    const onUnhandled = (event: PromiseRejectionEvent) => captureSdkCrash(event.reason);
    const onWindowError = (event: ErrorEvent) => captureSdkCrash(event.error ?? event.message);
    window.addEventListener("unhandledrejection", onUnhandled);
    window.addEventListener("error", onWindowError);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandled);
      window.removeEventListener("error", onWindowError);
      if (autoStartTimerRef.current) window.clearTimeout(autoStartTimerRef.current);
    };
  }, [reportError]);

  const mintToken = useServerFn(getElevenLabsToken);
  const persistMessage = useServerFn(saveMessage);

  const conversation = useConversation({
    onConnect: () => {
      console.log("[voice] connected");
      agentSpokeRef.current = false;
      lastSdkErrorRef.current = null;
      connectedAtRef.current = Date.now();
      autoStartSentRef.current = false;
      if (autoStartTimerRef.current) window.clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = window.setTimeout(() => {
        const prompt = autoStartPromptRef.current;
        if (!prompt || autoStartSentRef.current) return;
        autoStartSentRef.current = true;
        try {
          conversation.sendUserMessage(prompt);
        } catch (e) {
          autoStartSentRef.current = false;
          console.warn("[voice] auto-start prompt failed", e);
        }
      }, 1800);
      const kickoff = pendingKickoffRef.current;
      pendingKickoffRef.current = null;
      if (!kickoff || kickoff.parts.length === 0) return;
      // Send chunks paced — blasting >30KB synchronously over the WebRTC
      // data channel right after connect overflows the channel buffer and
      // tears the session down with code 1006.
      (async () => {
        try {
          // Let the SDK finish its initiation packet before we publish our own
          // context. Sending immediately after onConnect can race LiveKit's data
          // channel and close the room before the first audio packet arrives.
          await new Promise((r) => setTimeout(r, 1200));
          let totalBytes = 0;
          for (let i = 0; i < kickoff.parts.length; i++) {
            const part = kickoff.parts[i];
            const labeled = `BRIEFING CONTEXT PART ${i + 1}/${kickoff.parts.length}:\n${part}`;
            try {
              conversation.sendContextualUpdate?.(labeled);
              totalBytes += new TextEncoder().encode(labeled).length;
            } catch (e) {
              console.warn("[voice] context chunk failed", i + 1, e);
            }
            // Yield between chunks so the data channel can drain.
            await new Promise((r) => setTimeout(r, 350));
          }
          console.log("[voice] sent context", kickoff.parts.length, "chunks,", totalBytes, "bytes");
        } catch (e) {
          console.warn("[voice] kickoff failed", e);
        }
      })();
    },
    onDisconnect: (details: any) => {
      setAmplitude(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (autoStartTimerRef.current) window.clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = null;
      autoStartPromptRef.current = null;
      if (details?.reason === "user") {
        connectedAtRef.current = 0;
        return;
      }
      // If we connected but the agent never produced a single response,
      // surface that with the SDK disconnect detail and our last SDK error.
      if (connectedAtRef.current && !agentSpokeRef.current) {
        const elapsed = Date.now() - connectedAtRef.current;
        const sdkDetail = lastSdkErrorRef.current ? ` Last SDK error: ${lastSdkErrorRef.current}` : "";
        const disconnectDetail = formatDisconnectDetails(details);
        reportError(
          "disconnected_early",
          `Session ended after ${Math.round(elapsed / 100) / 10}s without the agent speaking. ` +
            `${disconnectDetail} ` +
            `No live context packet is sent after connect now, so if this repeats check that the agent is published and that First message/System prompt overrides are enabled.` +
            sdkDetail,
        );
      }
      connectedAtRef.current = 0;
    },
    onError: (err: any, context?: any) => {
      // ElevenLabs SDK sometimes passes a raw event, sometimes an object.
      const detail =
        typeof err === "string"
          ? err
          : err?.message ?? err?.reason ?? err?.error ?? (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
      const contextDetail = context ? safeJson(context).slice(0, 500) : "";
      const fullDetail = contextDetail ? `${detail} — ${contextDetail}` : detail;
      lastSdkErrorRef.current = fullDetail;
      console.error("[voice] error", err, context);
      reportError("upstream_error", detail);
    },
    onModeChange: ({ mode }: any) => {
      if (mode === "speaking") agentSpokeRef.current = true;
      if (mode === "listening" && autoStartPromptRef.current && !autoStartSentRef.current) {
        if (autoStartTimerRef.current) window.clearTimeout(autoStartTimerRef.current);
        autoStartTimerRef.current = window.setTimeout(() => {
          const prompt = autoStartPromptRef.current;
          if (!prompt || autoStartSentRef.current) return;
          autoStartSentRef.current = true;
          try {
            conversation.sendUserMessage(prompt);
          } catch (e) {
            autoStartSentRef.current = false;
            console.warn("[voice] auto-start prompt failed", e);
          }
        }, 250);
      }
    },
    onAudio: () => {
      agentSpokeRef.current = true;
    },
    onDebug: (info: any) => {
      if (info?.type === "send_message_error") {
        const detail = `Failed sending a voice data-channel message: ${safeJson(info.message?.error ?? info).slice(0, 350)}`;
        lastSdkErrorRef.current = detail;
        reportError("upstream_error", detail);
      } else {
        console.debug("[voice] debug", info);
      }
    },
    onMessage: (msg: any) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const bid = briefingIdRef.current;
      // Current @elevenlabs/react emits normalized messages:
      // { role: "user" | "agent", message: string }. Keep the raw-event
      // branches below as a fallback for older SDK payloads.
      if (typeof msg?.message === "string" && (msg?.role || msg?.source)) {
        const role = msg.role === "agent" || msg.source === "ai" ? "agent" : "user";
        const text = msg.message.trim();
        if (!text) return;
        if (shouldHideTranscriptLine(role, text)) return;
        if (role === "agent") agentSpokeRef.current = true;
        setTranscript((t) => [...t, { id, role, text, at: Date.now() }]);
        if (bid) persistMessage({ data: { briefingId: bid, role, content: text } }).catch(console.error);
        if (role === "agent" && bid) markProgressFromAgentText(briefingRef.current, bid, text);
        return;
      }
      // Capture any server-side error events the SDK forwards.
      if (msg?.type && /error/i.test(msg.type)) {
        const detail = msg?.error_event?.message ?? msg?.error?.message ?? msg?.message ?? JSON.stringify(msg).slice(0, 400);
        reportError("upstream_error", `Agent error (${msg.type}): ${detail}`);
        return;
      }
      if (msg.type === "user_transcript") {
        const text = msg.user_transcription_event?.user_transcript ?? "";
        if (text) {
          if (shouldHideTranscriptLine("user", text)) return;
          setTranscript((t) => [...t, { id, role: "user", text, at: Date.now() }]);
          if (bid) persistMessage({ data: { briefingId: bid, role: "user", content: text } }).catch(console.error);
        }
      } else if (msg.type === "agent_response") {
        const text = msg.agent_response_event?.agent_response ?? "";
        if (text) {
          agentSpokeRef.current = true;
          setTranscript((t) => [...t, { id, role: "agent", text, at: Date.now() }]);
          if (bid) persistMessage({ data: { briefingId: bid, role: "agent", content: text } }).catch(console.error);
          if (bid) markProgressFromAgentText(briefingRef.current, bid, text);
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
    setErrorDetail(null);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const tokenRes = await mintToken({ data: undefined as never });
      if (!tokenRes.ok) {
        reportError(tokenRes.reason, (tokenRes as any).detail);
        setIsStarting(false);
        return;
      }

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

      const sessionPrompt = buildSessionPrompt(briefing, effectiveJump, isResume);
      const jumpNote = isResume && typeof effectiveJump === "number"
        ? `\n\nRESUMING a previous session. The user already heard stories 1 through ${effectiveJump}. Pick up at story #${effectiveJump + 1} and continue in order. Do NOT repeat the full intro — open with a brief "Picking up where we left off" line, then go.`
        : typeof effectiveJump === "number"
        ? `\n\nThe user tapped story #${effectiveJump + 1}. Begin there and continue in order.`
        : "";
      const opener = isResume && typeof effectiveJump === "number"
        ? buildResumeMessage(briefing, effectiveJump)
        : typeof effectiveJump === "number"
        ? buildJumpMessage(briefing, effectiveJump)
        : buildFirstMessage(briefing);
      autoStartPromptRef.current = buildAutoStartPrompt(isResume, effectiveJump);
      autoStartSentRef.current = false;
      pendingKickoffRef.current = {
        // Do not push briefing context after connect. Even 20–25KB contextual
        // updates can close ElevenLabs' WebRTC room before first audio. The
        // compact briefing is included in the session prompt override instead.
        parts: [],
        opener,
      };
      await conversation.startSession({
        conversationToken: tokenRes.token,
        connectionType: "webrtc",
        overrides: {
          agent: {
            firstMessage: opener,
            prompt: { prompt: `${sessionPrompt}${jumpNote}` },
            language: "en",
          },
        },
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
    errorDetail,
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

const AGENT_SYSTEM_PROMPT = `You are Khabar AI, an AI-native news anchor. Intellectual but warm and conversational — like a well-read friend catching you up over chai. Speak in natural Indian English: warm, unhurried, with Indian pronunciations of names, places, and Hindi words. Avoid stiff broadcaster cadence; use everyday words and natural pauses.

Rules:
- The TODAY'S BRIEFING JSON below is your ONLY source of truth for the spoken brief. It is organised in three tiers: HOME (the user's country), WORLD (everywhere else), and QUICK HITS (one-liners).
- Total runtime target: ~15 minutes. Roughly 7 min HOME, 4 min WORLD, 3 min QUICK HITS. Do not pad. Do not invent.
- Your opening line is provided in the kickoff message — read it naturally as your first words, then continue straight into the briefing. Do NOT prepend your own greeting or say "Welcome" again on your own.
- Begin as a monologue. The listener should NOT need to say anything before you start the briefing.
- If you receive a message beginning SYSTEM_AUTO_START_BRIEFING, treat it as a hidden control signal to start immediately. Never read or mention that control text aloud.
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
- If the pack truly doesn't cover a very specific detail, do NOT say "I don't know". Instead, answer with what the pack DOES cover (the broader context, the key facts you have, the angle the sources took) and offer to dig deeper in tomorrow's briefing — e.g. "the reporting I have focuses on X and Y; I'll flag Z for tomorrow's update."
- For questions completely unrelated to today's news, you may answer briefly from general knowledge, then steer back to the briefing.`;

function buildSessionPrompt(b: Briefing, effectiveJump?: number, isResume = false): string {
  const startLine = isResume && typeof effectiveJump === "number"
    ? `Start at story ${effectiveJump + 1}. The listener already heard everything before it. Do not repeat the welcome.`
    : typeof effectiveJump === "number"
    ? `Start at story ${effectiveJump + 1}. The listener tapped that story.`
    : "Start with the provided first message, then continue through the briefing in order.";
  return [
    AGENT_SYSTEM_PROMPT,
    "",
    startLine,
    "",
    "TODAY'S BRIEFING — use only this compact source. Read HOME first, then WORLD, then QUICK HITS:",
    buildPromptBriefingContext(b),
  ].join("\n");
}

function buildPromptBriefingContext(b: Briefing): string {
  const lines: string[] = [`Home country: ${COUNTRY_LABELS[b.homeCountry ?? "in"] ?? "India"}`];
  b.topics.forEach((t, i) => {
    const tier = tierLabel(t.tier);
    const source = t.sources[0]?.name ? ` Source: ${t.sources[0].name}.` : "";
    const hook = compactSentence(t.hook, 170);
    const explain = compactSentence(t.explanation, t.tier === "quick_hit" ? 150 : 230);
    const why = t.tier === "quick_hit" ? "" : ` Why it matters: ${compactSentence(t.whyItMatters, 150)}`;
    lines.push(`${i + 1}. [${tier}] ${t.headline}. ${hook} ${explain}${why}${source}`.replace(/\s+/g, " ").trim());
  });
  return lines.join("\n");
}

function compactSentence(value: string | undefined, max: number): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max);
  return `${clipped.slice(0, Math.max(0, clipped.lastIndexOf(" ")))}…`;
}

function tierLabel(tier?: string) {
  if (tier === "home") return "HOME";
  if (tier === "world") return "WORLD";
  if (tier === "quick_hit") return "QUICK";
  return "WORLD";
}

function buildFirstMessage(b: Briefing): string {
  const isIndia = (b.homeCountry ?? "in") === "in";
  if (b.topics.length === 0) {
    return isIndia
      ? "Namaste, and welcome to Khabar AI. I couldn't pull any stories just yet — give it a minute and try again."
      : "Hey, welcome to Khabar AI. I couldn't pull any stories just yet — give it a minute and try again.";
  }
  const greeting = isIndia ? "Namaste, and welcome to Khabar AI" : "Hey, welcome to Khabar AI";
  return `${greeting} — your daily catch-up on what's happening and why it matters.`;
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

const AUTO_START_PREFIX = "SYSTEM_AUTO_START_BRIEFING";

function buildAutoStartPrompt(isResume: boolean, effectiveJump?: number): string {
  if (isResume && typeof effectiveJump === "number") {
    return `${AUTO_START_PREFIX}: Start speaking now as a continuous news monologue from story ${effectiveJump + 1}. Do not wait for the listener and do not ask a question.`;
  }
  if (typeof effectiveJump === "number") {
    return `${AUTO_START_PREFIX}: Start speaking now as a continuous news monologue from story ${effectiveJump + 1}. Do not wait for the listener and do not ask a question.`;
  }
  return `${AUTO_START_PREFIX}: Start speaking now as a continuous news monologue from the first story. Do not wait for the listener and do not ask a question.`;
}

function shouldHideTranscriptLine(role: "user" | "agent", text: string): boolean {
  if (role !== "user") return false;
  const normalized = text.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  return normalized.startsWith(AUTO_START_PREFIX.toLowerCase()) || normalized === "you can start";
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

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function formatDisconnectDetails(details: any): string {
  if (!details) return "No disconnect details were provided by the voice SDK.";
  const bits = [
    details.reason ? `reason=${details.reason}` : "",
    details.message ? `message=${details.message}` : "",
    details.closeCode ? `closeCode=${details.closeCode}` : "",
    details.closeReason ? `closeReason=${details.closeReason}` : "",
    details.context?.type ? `context=${details.context.type}` : "",
    details.context?.reason ? `contextReason=${details.context.reason}` : "",
  ].filter(Boolean).join(", ");
  return bits ? `Voice SDK disconnect detail: ${bits}.` : "The voice SDK disconnected without a specific reason.";
}

function markProgressFromAgentText(b: Briefing | null, briefingId: string, text: string) {
  if (!b) return;
  const norm = normalize(text);
  let covered = loadProgress(briefingId);
  b.topics.forEach((topic, idx) => {
    const key = normalize(topic.headline).slice(0, 40);
    if (key.length >= 8 && norm.includes(key) && idx > covered) {
      covered = idx;
    }
  });
  saveProgress(briefingId, covered);
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

function buildSlimBriefingContext(b: Briefing): string {
  // Slim payload for the live data-channel push: headline + hook +
  // explanation + whyItMatters + sources. Reference packs (deepBrief, qa,
  // keyFacts, articleExcerpts) are intentionally omitted — they bloat the
  // payload past WebRTC data-channel safe limits and the agent rarely needs
  // them for the initial read-through. Follow-ups can be answered from the
  // system prompt + headline context.
  return JSON.stringify({
    homeCountry: b.homeCountry,
    totalTopics: b.topics.length,
    topics: b.topics.map((t, i) => ({
      n: i + 1,
      tier: tierLabel(t.tier),
      headline: t.headline,
      hook: t.hook,
      explanation: (t.explanation ?? "").slice(0, 400),
      whyItMatters: (t.whyItMatters ?? "").slice(0, 300),
      sources: t.sources.slice(0, 3).map((s) => s.name),
      ...(t.tier !== "quick_hit" && t.keyFacts?.length ? { keyFacts: t.keyFacts.slice(0, 4) } : {}),
    })),
  });
}

function buildBriefingContext(b: Briefing): string {
  return JSON.stringify({
    generatedAt: b.generatedAt,
    homeCountry: b.homeCountry,
    totalTopics: b.topics.length,
    topics: b.topics.map((t, i) => {
      const base: Record<string, unknown> = {
        n: i + 1,
        id: t.id,
        tier: tierLabel(t.tier),
        headline: t.headline,
        hook: t.hook,
        explanation: t.explanation,
        whyItMatters: t.whyItMatters,
        sources: t.sources.slice(0, 6).map((s) => s.name),
      };
      if (t.tier !== "quick_hit") {
        if (t.deepBrief) base.deepBrief = t.deepBrief.slice(0, 1200);
        if (t.background) base.background = t.background.slice(0, 600);
        if (t.keyFacts?.length) base.keyFacts = t.keyFacts.slice(0, 8);
        if (t.qa?.length) base.qa = t.qa.slice(0, 4);
        if (t.articleExcerpts?.length) {
          base.articleExcerpts = t.articleExcerpts.slice(0, 2).map((e) => ({
            source: e.source,
            excerpt: e.excerpt.slice(0, 400),
          }));
        }
      }
      return base;
    }),
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

// WebRTC data channel cap is 65535 bytes per message. Leave headroom for
// framing + our "PART x/N" label, then split on safe boundaries.
function splitForContextChannel(text: string, maxBytes = 55000): string[] {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return [text];

  // Prefer splitting on topic-object boundaries inside the JSON payload,
  // falling back to newlines, then hard char chunks.
  const candidates = text.includes("},{")
    ? text.split(/(?<=\},)(?=\{)/)
    : text.split(/\n/);

  const parts: string[] = [];
  let buf = "";
  const flush = () => { if (buf) { parts.push(buf); buf = ""; } };

  for (const seg of candidates) {
    const piece = buf ? buf + (text.includes("},{") ? "" : "\n") + seg : seg;
    if (enc.encode(piece).length <= maxBytes) {
      buf = piece;
    } else {
      flush();
      if (enc.encode(seg).length <= maxBytes) {
        buf = seg;
      } else {
        // Segment itself too big — hard slice by chars (approx, safe upper bound).
        const step = Math.floor(maxBytes / 2);
        for (let i = 0; i < seg.length; i += step) {
          parts.push(seg.slice(i, i + step));
        }
      }
    }
  }
  flush();
  return parts;
}
