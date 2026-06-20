/**
 * useMonologue — section-aware briefing playback + voice Q&A.
 *
 * Music-player model:
 *   playAll()          — queue all sections, auto-advance
 *   playGroup(group)   — queue sections within one group only
 *   playSection(idx)   — play a specific section, no auto-advance
 *   nextSection()      — skip to next (maintains queue mode)
 *   prevSection()      — restart current if >3s in, else go to previous
 *   pause/resume/stop  — standard controls
 *   startListening()   — explicit voice Q&A trigger (NOT the orb when paused)
 *   orbTap()           — idle→play, playing→listen, paused→resume, listening→stop
 *
 * Resume from interruption:
 *   Position is saved to localStorage every 5s.
 *   Orb tap when idle resumes from saved position if available.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyBriefing } from "@/lib/news/generator";

export type MonologueState =
  | "idle"
  | "playing"
  | "paused"
  | "listening"
  | "answering"
  | "error";

const RESUME_KEY = "khabar-resume-pos";

export function useMonologue({ briefing }: { briefing: DailyBriefing | null }) {
  const [state, setState] = useState<MonologueState>("idle");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [currentSectionIdx, setCurrentSectionIdx] = useState<number>(-1);
  const [queueAll, setQueueAll] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pauseTimeRef = useRef(0);
  const recognitionRef = useRef<any>(null);
  const queueAllRef = useRef(false);
  const currentIdxRef = useRef(-1);
  const groupLimitRef = useRef<"india" | "global" | null>(null);
  const lastSaveRef = useRef(0);

  // Keep refs in sync
  useEffect(() => { queueAllRef.current = queueAll; }, [queueAll]);
  useEffect(() => { currentIdxRef.current = currentSectionIdx; }, [currentSectionIdx]);
  // playSectionAtRef is updated after playSectionAt is defined below

  const sectionsWithAudio = useMemo(
    () => briefing?.sections.filter((s) => s.audioUrl) ?? [],
    [briefing],
  );

  // Stable ref so onEnded closures always call the latest playSectionAt
  // (avoids stale closure when component re-renders mid-playback)
  const playSectionAtRef = useRef<((idx: number, all: boolean, startAt?: number) => void) | null>(null);

  // ── Audio attachment ────────────────────────────────────────────────────

  const attachAudio = useCallback(
    (url: string, startAt = 0, onEnded?: () => void) => {
      audioRef.current?.pause();
      const audio = new Audio(url);
      if (startAt > 0) audio.currentTime = startAt;
      audioRef.current = audio;

      audio.onloadedmetadata = () => setDuration(audio.duration);

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          const frac = audio.currentTime / audio.duration;
          setProgress(frac);
          // Save position every 5s for resume-from-interruption
          const now = Date.now();
          if (now - lastSaveRef.current > 5000) {
            lastSaveRef.current = now;
            try {
              localStorage.setItem(RESUME_KEY, JSON.stringify({
                idx: currentIdxRef.current,
                time: audio.currentTime,
                date: briefing?.date ?? "",
              }));
            } catch {}
          }
        }
      };

      audio.onplay = () => setState("playing");

      audio.onpause = () => {
        // Save exact position so resume works after external interruption
        pauseTimeRef.current = audio.currentTime;
        setState((s) => (s === "listening" || s === "answering" ? s : "paused"));
      };

      audio.onended = () => {
        setProgress(0);
        if (onEnded) {
          onEnded();
        } else {
          setState("idle");
        }
      };

      audio.onerror = () => {
        setState("error");
        setError("Audio playback failed.");
      };

      return audio;
    },
    [],
  );

  // ── Section navigation ──────────────────────────────────────────────────

  const playSectionAt = useCallback(
    (idx: number, all: boolean, startAt = 0) => {
      if (!briefing) return;
      const section = sectionsWithAudio[idx];
      if (!section) { setState("idle"); setCurrentSectionIdx(-1); return; }

      setError(null);
      setCurrentSectionIdx(idx);
      setQueueAll(all);

      const onEnded = all
        ? () => {
            const next = currentIdxRef.current + 1;
            if (next >= sectionsWithAudio.length) {
              setState("idle"); setCurrentSectionIdx(-1); setQueueAll(false);
              groupLimitRef.current = null;
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              return;
            }
            const limit = groupLimitRef.current;
            if (limit !== null && sectionsWithAudio[next]?.group !== limit) {
              setState("idle"); setCurrentSectionIdx(-1); setQueueAll(false);
              groupLimitRef.current = null;
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              return;
            }
            // Small delay lets iOS release the previous Audio element before
            // creating the next one — prevents AbortError on auto-advance.
            // Uses ref to avoid stale closure if component re-rendered.
            setTimeout(() => playSectionAtRef.current?.(next, true), 150);
          }
        : undefined;

      const audio = attachAudio(section.audioUrl, startAt, onEnded);
      audio.play().catch((e: any) => {
        if (e?.name === "AbortError") {
          // iOS may abort the play() call if audio engine is still releasing
          // the previous element. Retry once after a short delay — but ONLY
          // if this audio element is still the active one (guards against the
          // retry firing after auto-next has moved to the next section, which
          // would cause two voices playing simultaneously).
          setTimeout(() => {
            if (audioRef.current !== audio) return; // stale — a new section started
            audio.play().catch(() => setState("paused"));
          }, 300);
          return;
        }
        setState("error");
        setError(e?.message ?? "Playback blocked — tap again");
      });
    },
    [briefing, sectionsWithAudio, attachAudio],
  );

  // Keep playSectionAtRef current so onEnded closures never go stale
  useEffect(() => { playSectionAtRef.current = playSectionAt; }, [playSectionAt]);

  const playAll = useCallback(() => {
    groupLimitRef.current = null;
    playSectionAt(0, true);
  }, [playSectionAt]);

  const playGroup = useCallback((group: "india" | "global") => {
    const firstIdx = sectionsWithAudio.findIndex((s) => s.group === group);
    if (firstIdx < 0) return;
    groupLimitRef.current = group;
    playSectionAt(firstIdx, true);
  }, [sectionsWithAudio, playSectionAt]);

  const playSection = useCallback(
    (idx: number) => {
      groupLimitRef.current = null;
      playSectionAt(idx, false);
    },
    [playSectionAt],
  );

  // ── Skip controls (music player) ────────────────────────────────────────

  const nextSection = useCallback(() => {
    const next = currentIdxRef.current + 1;
    if (next < sectionsWithAudio.length) {
      playSectionAt(next, queueAllRef.current);
    }
  }, [sectionsWithAudio, playSectionAt]);

  const prevSection = useCallback(() => {
    // If >3s into section → restart; else → go to previous
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      setProgress(0);
      return;
    }
    const prev = currentIdxRef.current - 1;
    if (prev >= 0) {
      playSectionAt(prev, queueAllRef.current);
    } else {
      // Already at first — just restart
      if (audioRef.current) { audioRef.current.currentTime = 0; setProgress(0); }
    }
  }, [playSectionAt]);

  // ── Playback controls ───────────────────────────────────────────────────

  const play = useCallback(() => {
    // Check for saved resume position
    try {
      const saved = localStorage.getItem(RESUME_KEY);
      if (saved) {
        const { idx, time, date } = JSON.parse(saved) as { idx: number; time: number; date?: string };
        const currentDate = briefing?.date ?? "";
        if (idx >= 0 && idx < sectionsWithAudio.length && time > 2 && (!date || date === currentDate)) {
          playSectionAt(idx, true, time);
          return;
        }
      }
    } catch {}
    playAll();
  }, [sectionsWithAudio, playSectionAt, playAll]);

  const pause = useCallback(() => {
    if (audioRef.current) {
      pauseTimeRef.current = audioRef.current.currentTime;
      audioRef.current.pause();
    }
    setState("paused");
  }, []);

  const resume = useCallback(async () => {
    if (audioRef.current && audioRef.current.paused) {
      await audioRef.current.play().catch(() => {});
    } else if (currentSectionIdx >= 0) {
      const section = sectionsWithAudio[currentSectionIdx];
      if (section) {
        const audio = attachAudio(section.audioUrl, pauseTimeRef.current);
        await audio.play().catch(() => {});
      }
    }
  }, [currentSectionIdx, sectionsWithAudio, attachAudio]);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
    setProgress(0);
    setDuration(0);
    setCurrentSectionIdx(-1);
    setQueueAll(false);
    groupLimitRef.current = null;
    pauseTimeRef.current = 0;
    try { localStorage.removeItem(RESUME_KEY); } catch {}
  }, []);

  const seek = useCallback(
    (fraction: number) => {
      if (audioRef.current && duration > 0) {
        audioRef.current.currentTime = fraction * duration;
        setProgress(fraction);
      }
    },
    [duration],
  );

  const seekForward = useCallback((seconds = 10) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.min(
      audioRef.current.currentTime + seconds,
      audioRef.current.duration || 0,
    );
  }, []);

  const seekBackward = useCallback((seconds = 10) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(audioRef.current.currentTime - seconds, 0);
  }, []);

  // ── Voice Q&A ───────────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Voice input not supported in this browser.");
      setState("error");
      return;
    }
    if (audioRef.current) {
      pauseTimeRef.current = audioRef.current.currentTime;
      audioRef.current.pause();
    }
    setState("listening");
    setTranscript("");

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-IN";
    recognitionRef.current = recognition;

    recognition.onresult = (e: any) => {
      const text = e.results[0]?.[0]?.transcript ?? "";
      setTranscript(text);
      if (text) handleQuestion(text);
      else setState("paused");
    };
    recognition.onerror = (e: any) => {
      console.error("[speech]", e.error);
      const msg = e.error === "not-allowed"
        ? "Microphone access denied — check browser permissions."
        : e.error === "no-speech"
        ? "No speech detected — try again."
        : `Voice error: ${e.error}`;
      setError(msg);
      setState("paused");
    };
    recognition.onend = () => { recognitionRef.current = null; };
    recognition.start();
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setState("paused");
  }, []);

  async function handleQuestion(question: string) {
    setState("answering");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { audioUrl } = await res.json();
      const answerAudio = new Audio(audioUrl);
      answerAudio.onended = () => resume();
      answerAudio.onerror = () => { setError("Answer audio failed."); setState("paused"); };
      await answerAudio.play().catch((e: any) => {
        setError(e?.message ?? "Could not play answer.");
        setState("paused");
      });
    } catch (e: any) {
      setError(e?.message ?? "Could not get an answer");
      setState("paused");
    }
  }

  // Orb: idle→play, playing→pause, paused→resume, listening→stop
  const orbTap = useCallback(() => {
    switch (state) {
      case "idle":      play(); break;
      case "playing":   pause(); break;
      case "paused":    resume(); break;
      case "listening": stopListening(); break;
      case "answering": break;
      case "error":     setError(null); setState("idle"); break;
    }
  }, [state, play, pause, resume, stopListening]);

  useEffect(() => () => {
    audioRef.current?.pause();
    recognitionRef.current?.stop();
  }, []);

  return {
    state,
    progress,
    duration,
    error,
    transcript,
    currentSectionIdx,
    sectionsWithAudio,
    play,
    playAll,
    playGroup,
    playSection,
    nextSection,
    prevSection,
    pause,
    resume,
    stop,
    seek,
    seekForward,
    seekBackward,
    startListening,
    orbTap,
  };
}
