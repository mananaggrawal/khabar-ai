/**
 * useMonologue — topic-aware briefing playback + voice Q&A.
 *
 * Playback model:
 *   play()             — queue all topics across all sections, auto-advance
 *   playGroup(group)   — queue topics within india or global only
 *   playSection(idx)   — play all topics in a specific section
 *   playTopic(idx)     — play a single topic (no auto-advance)
 *   nextTopic()        — skip to next topic
 *   prevTopic()        — restart if >3s in, else go to previous topic
 *   pause/resume/stop  — standard controls
 *   orbTap()           — idle→play, playing→pause, paused→resume
 *
 * Language:
 *   Reads 'khabar-language' from localStorage ('en' | 'hi').
 *   Reacts to storage events so settings page can switch live.
 *
 * Resume from interruption:
 *   Position is saved to localStorage every 5s.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyBriefing, BriefingTopic, BriefingSection } from "@/lib/news/generator";

export type MonologueState =
  | "idle"
  | "playing"
  | "paused"
  | "listening"
  | "answering"
  | "error";

const RESUME_KEY      = "khabar-resume-pos";
const STORY_POS_KEY   = "khabar-story-pos";   // { [topicId]: seconds }
const LANGUAGE_KEY    = "khabar-language";

function readStoryPositions(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(STORY_POS_KEY) ?? "{}"); } catch { return {}; }
}
function saveStoryPosition(topicId: string, time: number) {
  try {
    const pos = readStoryPositions();
    pos[topicId] = time;
    localStorage.setItem(STORY_POS_KEY, JSON.stringify(pos));
  } catch {}
}
function clearStoryPosition(topicId: string) {
  try {
    const pos = readStoryPositions();
    delete pos[topicId];
    localStorage.setItem(STORY_POS_KEY, JSON.stringify(pos));
  } catch {}
}

function readLanguage(): "en" | "hi" {
  try { return (localStorage.getItem(LANGUAGE_KEY) as "en" | "hi") || "en"; } catch { return "en"; }
}

export function useMonologue({ briefing }: { briefing: DailyBriefing | null }) {
  const [state, setState] = useState<MonologueState>("idle");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [currentTopicIdx, setCurrentTopicIdx] = useState(-1);
  const [queueAll, setQueueAll] = useState(false);
  const [language, setLanguage] = useState<"en" | "hi">(readLanguage);

  const audioRef      = useRef<HTMLAudioElement | null>(null);
  const preloadRef    = useRef<HTMLAudioElement | null>(null);
  const pauseTimeRef  = useRef(0);
  const recognitionRef = useRef<any>(null);
  const queueAllRef   = useRef(false);
  const currentIdxRef = useRef(-1);
  const groupLimitRef = useRef<"india" | "global" | null>(null);
  const lastSaveRef   = useRef(0);
  const playTopicAtRef = useRef<((idx: number, all: boolean, startAt?: number) => void) | null>(null);

  // Keep refs in sync
  useEffect(() => { queueAllRef.current = queueAll; }, [queueAll]);
  useEffect(() => { currentIdxRef.current = currentTopicIdx; }, [currentTopicIdx]);

  // React to language changes from settings page
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_KEY) setLanguage((e.newValue as "en" | "hi") || "en");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Flat list of all topics that have audio in the current language
  const topicsWithAudio = useMemo(
    () =>
      briefing?.sections.flatMap((s) =>
        s.topics.filter((t) =>
          language === "hi" ? !!t.audioUrlHi : !!(t.audioUrlEn ?? (t as any).audioUrl),
        ),
      ) ?? [],
    [briefing, language],
  );

  // Sections that have at least one playable topic (for UI)
  const sectionsWithAudio = useMemo(
    () =>
      briefing?.sections.filter((s) =>
        s.topics.some((t) =>
          language === "hi" ? !!t.audioUrlHi : !!(t.audioUrlEn ?? (t as any).audioUrl),
        ),
      ) ?? [],
    [briefing, language],
  );

  const currentTopic: BriefingTopic | null =
    currentTopicIdx >= 0 ? topicsWithAudio[currentTopicIdx] ?? null : null;

  const currentSection: BriefingSection | null =
    currentTopic
      ? briefing?.sections.find((s) => s.category === currentTopic.section) ?? null
      : null;

  // currentSectionIdx — index within sectionsWithAudio (backwards compat for UI)
  const currentSectionIdx = useMemo(() => {
    if (!currentTopic) return -1;
    return sectionsWithAudio.findIndex((s) => s.category === currentTopic.section);
  }, [currentTopic, sectionsWithAudio]);

  // ── Audio attachment ───────────────────────────────────────────────────────

  const attachAudio = useCallback(
    (url: string, startAt = 0, onEnded?: () => void) => {
      audioRef.current?.pause();
      // Use preloaded audio if URL matches, otherwise create fresh
      const preloaded = preloadRef.current;
      const audio = (preloaded && preloaded.src === url && startAt === 0)
        ? preloaded
        : new Audio(url);
      preloadRef.current = null; // clear so next track can preload
      if (startAt > 0) audio.currentTime = startAt;
      audioRef.current = audio;

      audio.onloadedmetadata = () => setDuration(audio.duration);

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          const frac = audio.currentTime / audio.duration;
          setProgress(frac);

          // Preload next track at 70% through current
          if (frac > 0.7) {
            const nextIdx = currentIdxRef.current + 1;
            const nextTopic = topicsWithAudio[nextIdx];
            if (nextTopic && preloadRef.current === null) {
              const nextUrl = language === "hi"
                ? nextTopic.audioUrlHi!
                : (nextTopic.audioUrlEn ?? (nextTopic as any).audioUrl)!;
              if (nextUrl) {
                const preload = new Audio(nextUrl);
                preload.preload = "auto";
                preloadRef.current = preload;
              }
            }
          }

          const now = Date.now();
          if (now - lastSaveRef.current > 5000) {
            lastSaveRef.current = now;
            try {
              localStorage.setItem(RESUME_KEY, JSON.stringify({
                idx: currentIdxRef.current,
                time: audio.currentTime,
                date: briefing?.date ?? "",
                lang: language,
              }));
            } catch {}
            const topic = topicsWithAudio[currentIdxRef.current];
            if (topic && audio.currentTime > 2) saveStoryPosition(topic.id, audio.currentTime);
          }
        }
      };

      audio.onplay  = () => setState("playing");
      audio.onpause = () => {
        pauseTimeRef.current = audio.currentTime;
        setState((s) => (s === "listening" || s === "answering" ? s : "paused"));
      };
      audio.onended = () => {
        setProgress(0);
        // Clear saved position — story finished, next play restarts from 0
        const topic = topicsWithAudio[currentIdxRef.current];
        if (topic) clearStoryPosition(topic.id);
        if (onEnded) onEnded();
        else setState("idle");
      };
      audio.onerror = () => { setState("error"); setError("Audio playback failed."); };

      return audio;
    },
    [briefing, language],
  );

  // ── Topic navigation ───────────────────────────────────────────────────────

  const playTopicAt = useCallback(
    (idx: number, all: boolean, startAt = 0) => {
      if (!briefing) return;
      const topic = topicsWithAudio[idx];
      if (!topic) { setState("idle"); setCurrentTopicIdx(-1); return; }

      const url = language === "hi"
        ? topic.audioUrlHi!
        : (topic.audioUrlEn ?? (topic as any).audioUrl)!;

      setError(null);
      setCurrentTopicIdx(idx);
      setQueueAll(all);

      const onEnded = all
        ? () => {
            const next = currentIdxRef.current + 1;
            if (next >= topicsWithAudio.length) {
              setState("idle"); setCurrentTopicIdx(-1); setQueueAll(false);
              groupLimitRef.current = null;
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              return;
            }
            const limit = groupLimitRef.current;
            if (limit !== null) {
              const nextTopic = topicsWithAudio[next];
              const nextSection = briefing.sections.find((s) => s.category === nextTopic?.section);
              if (nextSection?.group !== limit) {
                setState("idle"); setCurrentTopicIdx(-1); setQueueAll(false);
                groupLimitRef.current = null;
                try { localStorage.removeItem(RESUME_KEY); } catch {}
                return;
              }
            }
            setTimeout(() => playTopicAtRef.current?.(next, true), 50);
          }
        : undefined;

      const audio = attachAudio(url, startAt, onEnded);
      audio.play().catch((e: any) => {
        if (e?.name === "AbortError") {
          setTimeout(() => {
            if (audioRef.current !== audio) return;
            audio.play().catch(() => setState("paused"));
          }, 300);
          return;
        }
        setState("error");
        setError(e?.message ?? "Playback blocked — tap again");
      });
    },
    [briefing, topicsWithAudio, language, attachAudio],
  );

  useEffect(() => { playTopicAtRef.current = playTopicAt; }, [playTopicAt]);

  // ── Public navigation API ──────────────────────────────────────────────────

  const playAll = useCallback(() => {
    groupLimitRef.current = null;
    playTopicAt(0, true);
  }, [playTopicAt]);

  const playGroup = useCallback((group: "india" | "global") => {
    const firstIdx = topicsWithAudio.findIndex((t) => {
      const sec = briefing?.sections.find((s) => s.category === t.section);
      return sec?.group === group;
    });
    if (firstIdx < 0) return;
    groupLimitRef.current = group;
    playTopicAt(firstIdx, true);
  }, [briefing, topicsWithAudio, playTopicAt]);

  /** Play all topics in a section (by index in sectionsWithAudio) */
  const playSection = useCallback(
    (sectionIdx: number) => {
      const section = sectionsWithAudio[sectionIdx];
      if (!section) return;
      groupLimitRef.current = null;
      const firstTopicIdx = topicsWithAudio.findIndex((t) => t.section === section.category);
      if (firstTopicIdx >= 0) playTopicAt(firstTopicIdx, true);
    },
    [sectionsWithAudio, topicsWithAudio, playTopicAt],
  );

  /** Play a single topic by its index in topicsWithAudio */
  const playTopic = useCallback(
    (idx: number) => {
      groupLimitRef.current = null;
      const savedPos = readStoryPositions()[topicsWithAudio[idx]?.id ?? ""] ?? 0;
      playTopicAt(idx, false, savedPos > 2 ? savedPos : 0);
    },
    [playTopicAt, topicsWithAudio],
  );

  /** Play from a topic and auto-advance through all remaining topics */
  const playFrom = useCallback(
    (idx: number) => {
      groupLimitRef.current = null;
      const savedPos = readStoryPositions()[topicsWithAudio[idx]?.id ?? ""] ?? 0;
      playTopicAt(idx, true, savedPos > 2 ? savedPos : 0);
    },
    [playTopicAt, topicsWithAudio],
  );

  const nextTopic = useCallback(() => {
    const next = currentIdxRef.current + 1;
    if (next < topicsWithAudio.length) playTopicAt(next, queueAllRef.current);
  }, [topicsWithAudio, playTopicAt]);

  const prevTopic = useCallback(() => {
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      setProgress(0);
      return;
    }
    const prev = currentIdxRef.current - 1;
    if (prev >= 0) {
      playTopicAt(prev, queueAllRef.current);
    } else {
      if (audioRef.current) { audioRef.current.currentTime = 0; setProgress(0); }
    }
  }, [playTopicAt]);

  // ── Playback controls ──────────────────────────────────────────────────────

  const play = useCallback(() => {
    try {
      const saved = localStorage.getItem(RESUME_KEY);
      if (saved) {
        const { idx, time, date, lang } = JSON.parse(saved) as { idx: number; time: number; date?: string; lang?: string };
        const currentDate = briefing?.date ?? "";
        const langMatch = !lang || lang === language;
        if (idx >= 0 && idx < topicsWithAudio.length && time > 2 && (!date || date === currentDate) && langMatch) {
          playTopicAt(idx, true, time);
          return;
        }
      }
    } catch {}
    playAll();
  }, [topicsWithAudio, language, playTopicAt, playAll]);

  const pause = useCallback(() => {
    if (audioRef.current) { pauseTimeRef.current = audioRef.current.currentTime; audioRef.current.pause(); }
    setState("paused");
  }, []);

  const resume = useCallback(async () => {
    if (audioRef.current && audioRef.current.paused) {
      await audioRef.current.play().catch(() => {});
    } else if (currentTopicIdx >= 0) {
      const topic = topicsWithAudio[currentTopicIdx];
      if (topic) {
        const url = language === "hi"
          ? topic.audioUrlHi!
          : (topic.audioUrlEn ?? (topic as any).audioUrl)!;
        const audio = attachAudio(url, pauseTimeRef.current);
        await audio.play().catch(() => {});
      }
    }
  }, [currentTopicIdx, topicsWithAudio, language, attachAudio]);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
    setProgress(0);
    setDuration(0);
    setCurrentTopicIdx(-1);
    setQueueAll(false);
    groupLimitRef.current = null;
    pauseTimeRef.current = 0;
    try { localStorage.removeItem(RESUME_KEY); } catch {}
  }, []);

  const seek = useCallback((fraction: number) => {
    if (audioRef.current && duration > 0) {
      audioRef.current.currentTime = fraction * duration;
      setProgress(fraction);
    }
  }, [duration]);

  const seekForward  = useCallback((seconds = 10) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.min(audioRef.current.currentTime + seconds, audioRef.current.duration || 0);
  }, []);

  const seekBackward = useCallback((seconds = 10) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(audioRef.current.currentTime - seconds, 0);
  }, []);

  // ── Voice Q&A ──────────────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setError("Voice input not supported in this browser."); setState("error"); return; }
    if (audioRef.current) { pauseTimeRef.current = audioRef.current.currentTime; audioRef.current.pause(); }
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
      const msg = e.error === "not-allowed" ? "Microphone access denied." : e.error === "no-speech" ? "No speech detected." : `Voice error: ${e.error}`;
      setError(msg); setState("paused");
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { audioUrl } = await res.json();
      const answerAudio = new Audio(audioUrl);
      answerAudio.onended = () => resume();
      answerAudio.onerror = () => { setError("Answer audio failed."); setState("paused"); };
      await answerAudio.play().catch((e: any) => { setError(e?.message ?? "Could not play answer."); setState("paused"); });
    } catch (e: any) {
      setError(e?.message ?? "Could not get an answer");
      setState("paused");
    }
  }

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
    language,

    // Topic-level
    currentTopicIdx,
    currentTopic,
    topicsWithAudio,

    // Section-level (derived, for UI)
    currentSectionIdx,
    currentSection,
    sectionsWithAudio,

    // Controls
    play,
    playAll,
    playGroup,
    playSection,
    playTopic,
    playFrom,
    nextSection: nextTopic,   // alias so existing UI still works
    prevSection: prevTopic,   // alias so existing UI still works
    nextTopic,
    prevTopic,
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
