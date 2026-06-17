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

export type VoiceConfigError =
  | "missing_api_key"
  | "missing_agent_id"
  | "upstream_error"
  | "disconnected_early"
  | null;
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
  const agentSpokeRef = useRef(false);
  const lastAgentAudioAtRef = useRef<number>(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartAttemptsRef = useRef(0);
  const restartingRef = useRef(false);

  useEffect(() => {
    briefingIdRef.current = briefing?.id ?? null;
  }, [briefing]);

  const reportError = useCallback((reason: VoiceConfigError, detail?: string) => {
    console.error("[voice] error surfaced:", reason, detail);
    setConfigError(reason);
    if (detail) setErrorDetail(detail);
  }, []);

  const mintToken = useServerFn(getElevenLabsToken);
  const persistMessage = useServerFn(saveMessage);

  const conversation = useConversation({
    onConnect: () => {
      console.log("[voice] connected");
      agentSpokeRef.current = false;
      lastAgentAudioAtRef.current = Date.now();
      setConfigError(null);
      setErrorDetail(null);
    },
    onDisconnect: () => {
      setAmplitude(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    onError: (err: unknown) => {
      const detail =
        typeof err === "string"
          ? err
          : (err as any)?.message ?? (err as any)?.reason ?? "";
      if (!detail) return;
      if (/error_event|error_type|undefined is not an object/i.test(String(detail))) {
        console.debug("[voice] ignoring malformed SDK error packet:", detail);
        return;
      }
      console.error("[voice] error", err);
      reportError("upstream_error", String(detail));
    },
    onModeChange: ({ mode }: any) => {
      if (mode === "speaking") {
        agentSpokeRef.current = true;
        lastAgentAudioAtRef.current = Date.now();
      }
    },
    onAudio: () => {
      agentSpokeRef.current = true;
      lastAgentAudioAtRef.current = Date.now();
    },
    onMessage: (msg: any) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const bid = briefingIdRef.current;

      if (typeof msg?.message === "string" && (msg?.role || msg?.source)) {
        const role = msg.role === "agent" || msg.source === "ai" ? "agent" : "user";
        const text = msg.message.trim();
        if (!text) return;
        if (shouldHideTranscriptLine(role, text)) return;
        if (role === "agent") {
          agentSpokeRef.current = true;
          lastAgentAudioAtRef.current = Date.now();
        }
        setTranscript((t) => [...t, { id, role, text, at: Date.now() }]);
        if (bid) persistMessage({ data: { briefingId: bid, role, content: text } }).catch(console.error);
        return;
      }

      if (msg?.type === "user_transcript") {
        const text = msg.user_transcription_event?.user_transcript ?? "";
        if (text && !shouldHideTranscriptLine("user", text)) {
          setTranscript((t) => [...t, { id, role: "user", text, at: Date.now() }]);
          if (bid) persistMessage({ data: { briefingId: bid, role: "user", content: text } }).catch(console.error);
        }
      } else if (msg?.type === "agent_response") {
        const text = msg.agent_response_event?.agent_response ?? "";
        if (text) {
          agentSpokeRef.current = true;
          lastAgentAudioAtRef.current = Date.now();
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

  const start = useCallback(async (_jumpToIndex?: number) => {
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

      await conversation.startSession({
        conversationToken: tokenRes.token,
        connectionType: "webrtc",
      } as any);
    } catch (e) {
      console.error("[voice] start failed", e);
      reportError("upstream_error", String((e as any)?.message ?? e));
    } finally {
      setIsStarting(false);
    }
  }, [briefing, conversation, mintToken, reportError]);

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

function shouldHideTranscriptLine(role: "user" | "agent", text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  // User turns are never rendered — monologue experience.
  if (role === "user") return true;
  return false;
}
