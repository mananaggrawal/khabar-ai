/**
 * useMonologue — story-aware briefing playback.
 *
 * Playback model:
 *   playAll()              — queue all stories, auto-advance
 *   playSection(id)        — queue stories within a section, auto-advance (stops at end of section)
 *   playStory(idx)         — play a single story (no auto-advance)
 *   playFrom(idx)          — play from idx, auto-advance through all remaining
 *   next() / prev()        — skip / previous (3s restart rule)
 *   pause / resume / stop  — standard controls
 *   orbTap()               — idle→play, playing→pause, paused→resume
 *
 * Language:
 *   Reads 'khabar-language' from localStorage ('en' | 'hi').
 *   Reacts to storage events so settings page can switch live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyBriefing, Story } from "@/lib/news/generator";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";

export type MonologueState = "idle" | "playing" | "paused" | "error";

const RESUME_KEY   = "khabar-resume-pos";
const LANGUAGE_KEY = "khabar-language";

function readLanguage(): "en" | "hi" {
  try { return (localStorage.getItem(LANGUAGE_KEY) as "en" | "hi") || "en"; } catch { return "en"; }
}

export function useMonologue({ briefing }: { briefing: DailyBriefing | null }) {
  const [state, setState]               = useState<MonologueState>("idle");
  const [progress, setProgress]         = useState(0);
  const [duration, setDuration]         = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [currentStoryIdx, setCurrentStoryIdx] = useState(-1);
  const [queueMode, setQueueMode]       = useState<"all" | SectionId | null>(null);
  const [language, setLanguage]         = useState<"en" | "hi">(readLanguage);

  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const preloadRef     = useRef<HTMLAudioElement | null>(null);
  const pauseTimeRef   = useRef(0);
  const currentIdxRef  = useRef(-1);
  const queueModeRef   = useRef<"all" | SectionId | null>(null);
  const lastSaveRef    = useRef(0);
  const playAtRef      = useRef<((idx: number, mode: "all" | SectionId | null, startAt?: number) => void) | null>(null);

  // Keep refs in sync
  useEffect(() => { currentIdxRef.current = currentStoryIdx; }, [currentStoryIdx]);
  useEffect(() => { queueModeRef.current = queueMode; }, [queueMode]);

  // React to language changes from settings
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_KEY) setLanguage((e.newValue as "en" | "hi") || "en");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ── Derived lists ─────────────────────────────────────────────────────────

  /** All stories that have audio in the current language */
  const storiesWithAudio = useMemo(
    () =>
      (briefing?.stories ?? []).filter((s) =>
        language === "hi" ? !!s.audioUrlHi : !!s.audioUrlEn,
      ),
    [briefing, language],
  );

  /** Sections that have at least one playable story */
  const sectionsWithStories = useMemo(() => {
    const seen = new Set<SectionId>();
    const result: Array<{ id: SectionId; label: string; labelHi: string; emoji: string; stories: Story[] }> = [];
    for (const story of storiesWithAudio) {
      if (!seen.has(story.section)) {
        seen.add(story.section);
        const feed = FEED_MAP.get(story.section)!;
        result.push({ id: story.section, label: feed.label, labelHi: feed.labelHi, emoji: feed.emoji, stories: [] });
      }
      result.find((s) => s.id === story.section)!.stories.push(story);
    }
    return result;
  }, [storiesWithAudio]);

  const currentStory: Story | null =
    currentStoryIdx >= 0 ? storiesWithAudio[currentStoryIdx] ?? null : null;

  const currentFeed = currentStory ? FEED_MAP.get(currentStory.section) ?? null : null;

  // ── Audio attachment ──────────────────────────────────────────────────────

  const attachAudio = useCallback(
    (url: string, startAt = 0, onEnded?: () => void) => {
      audioRef.current?.pause();
      const preloaded = preloadRef.current;
      // Match by filename in case one URL is absolute and the other relative
      const filename = url.split('/').pop() ?? '';
      const audio =
        preloaded && filename && preloaded.src.endsWith(filename) && startAt === 0
          ? preloaded
          : new Audio(url);
      preloadRef.current = null;
      if (startAt > 0) audio.currentTime = startAt;
      audioRef.current = audio;

      audio.onloadedmetadata = () => setDuration(audio.duration);

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          const ct = audio.currentTime;
          setProgress(ct / audio.duration);

          // Advance story index when crossing audioStartSec boundary (same section audio)
          const nextIdx = currentIdxRef.current + 1;
          const next = storiesWithAudio[nextIdx];
          if (next) {
            const nextUrl = language === "hi" ? next.audioUrlHi! : next.audioUrlEn!;
            const nextFilename = nextUrl?.split('/').pop() ?? '';
            if (nextFilename && audio.src.endsWith(nextFilename) && next.audioStartSec !== undefined && ct >= next.audioStartSec) {
              setCurrentStoryIdx(nextIdx);
            }
          }

          // Preload next section's audio at 70%
          if (ct / audio.duration > 0.7 && preloadRef.current === null) {
            let preloadIdx = currentIdxRef.current + 1;
            while (preloadIdx < storiesWithAudio.length) {
              const s = storiesWithAudio[preloadIdx];
              const sUrl = language === "hi" ? s.audioUrlHi! : s.audioUrlEn!;
              const sFilename = sUrl?.split('/').pop() ?? '';
              if (sFilename && !audio.src.endsWith(sFilename)) {
                const pre = new Audio(sUrl);
                pre.preload = "auto";
                preloadRef.current = pre;
                break;
              }
              preloadIdx++;
            }
          }

          // Save resume position every 5s
          const now = Date.now();
          if (now - lastSaveRef.current > 5000) {
            lastSaveRef.current = now;
            try {
              localStorage.setItem(RESUME_KEY, JSON.stringify({
                idx: currentIdxRef.current,
                time: ct,
                date: briefing?.date ?? "",
                lang: language,
              }));
            } catch {}
          }
        }
      };

      audio.onplay  = () => setState("playing");
      audio.onpause = () => {
        pauseTimeRef.current = audio.currentTime;
        setState((s) => s === "playing" ? "paused" : s);
      };
      audio.onended = () => {
        setProgress(0);
        if (onEnded) onEnded();
        else setState("idle");
      };
      audio.onerror = () => { setState("error"); setError("Audio playback failed."); };

      return audio;
    },
    [briefing, language, storiesWithAudio],
  );

  // ── Core play function ────────────────────────────────────────────────────

  const playAt = useCallback(
    (idx: number, mode: "all" | SectionId | null, startAt = 0) => {
      const story = storiesWithAudio[idx];
      if (!story) { setState("idle"); setCurrentStoryIdx(-1); return; }

      const url = language === "hi" ? story.audioUrlHi! : story.audioUrlEn!;
      const seekTo = startAt > 0 ? startAt : (story.audioStartSec ?? 0);

      setError(null);
      setCurrentStoryIdx(idx);
      setQueueMode(mode);

      // If same section audio already loaded, just seek — no reload
      const curAudio = audioRef.current;
      const filename = url.split('/').pop() ?? '';
      if (curAudio && !curAudio.ended && filename && curAudio.src.endsWith(filename)) {
        if (seekTo > 0) curAudio.currentTime = seekTo;
        if (curAudio.paused) curAudio.play().catch(() => {});
        return;
      }

      const onEnded = mode !== null
        ? () => {
            // Find the next story with a different audio file (next section)
            let next = currentIdxRef.current + 1;
            while (next < storiesWithAudio.length) {
              const s = storiesWithAudio[next];
              const sUrl = language === "hi" ? s.audioUrlHi! : s.audioUrlEn!;
              const sFilename = sUrl?.split('/').pop() ?? '';
              if (!sFilename || !url.endsWith(sFilename)) break;
              next++;
            }
            if (next >= storiesWithAudio.length) {
              setState("idle"); setCurrentStoryIdx(-1); setQueueMode(null);
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              return;
            }
            if (mode !== "all" && storiesWithAudio[next]?.section !== mode) {
              setState("idle"); setCurrentStoryIdx(-1); setQueueMode(null);
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              return;
            }
            setTimeout(() => playAtRef.current?.(next, queueModeRef.current, 0), 50);
          }
        : undefined;

      const audio = attachAudio(url, seekTo, onEnded);
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
    [storiesWithAudio, language, attachAudio],
  );

  useEffect(() => { playAtRef.current = playAt; }, [playAt]);

  // ── Public API ────────────────────────────────────────────────────────────

  const playAll = useCallback(() => {
    playAt(0, "all");
  }, [playAt]);

  /** Play all stories within a given section */
  const playSection = useCallback(
    (sectionId: SectionId) => {
      const firstIdx = storiesWithAudio.findIndex((s) => s.section === sectionId);
      if (firstIdx >= 0) playAt(firstIdx, sectionId);
    },
    [storiesWithAudio, playAt],
  );

  /** Play a single story (no auto-advance) */
  const playStory = useCallback(
    (idx: number) => {
      playAt(idx, null);
    },
    [playAt],
  );

  /** Play from idx, auto-advance through all */
  const playFrom = useCallback(
    (idx: number) => {
      playAt(idx, "all");
    },
    [playAt],
  );

  /** Play from idx, auto-advance within section only */
  const playFromInSection = useCallback(
    (idx: number, sectionId: SectionId) => {
      playAt(idx, sectionId);
    },
    [playAt],
  );

  const next = useCallback(() => {
    const nextIdx = currentIdxRef.current + 1;
    if (nextIdx < storiesWithAudio.length) playAt(nextIdx, queueModeRef.current);
  }, [storiesWithAudio, playAt]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    const story = storiesWithAudio[currentIdxRef.current];
    const storyStart = story?.audioStartSec ?? 0;
    if (audio && audio.currentTime > storyStart + 3) {
      audio.currentTime = storyStart;
      setProgress(storyStart / (audio.duration || 1));
      return;
    }
    const prevIdx = currentIdxRef.current - 1;
    if (prevIdx >= 0) playAt(prevIdx, queueModeRef.current);
    else if (audio) { audio.currentTime = 0; setProgress(0); }
  }, [playAt, storiesWithAudio]);

  const play = useCallback(() => {
    try {
      const saved = localStorage.getItem(RESUME_KEY);
      if (saved) {
        const { idx, time, date, lang } = JSON.parse(saved);
        const dateMatch = !date || date === briefing?.date;
        const langMatch = !lang || lang === language;
        if (idx >= 0 && idx < storiesWithAudio.length && time > 2 && dateMatch && langMatch) {
          playAt(idx, "all", time);
          return;
        }
      }
    } catch {}
    playAll();
  }, [storiesWithAudio, language, briefing, playAt, playAll]);

  const pause = useCallback(() => {
    if (audioRef.current) { pauseTimeRef.current = audioRef.current.currentTime; audioRef.current.pause(); }
    setState("paused");
  }, []);

  const resume = useCallback(async () => {
    if (audioRef.current?.paused) {
      await audioRef.current.play().catch(() => {});
    } else if (currentStoryIdx >= 0) {
      const story = storiesWithAudio[currentStoryIdx];
      if (story) {
        const url = language === "hi" ? story.audioUrlHi! : story.audioUrlEn!;
        const audio = attachAudio(url, pauseTimeRef.current);
        await audio.play().catch(() => {});
      }
    }
  }, [currentStoryIdx, storiesWithAudio, language, attachAudio]);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
    setProgress(0);
    setDuration(0);
    setCurrentStoryIdx(-1);
    setQueueMode(null);
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
    audioRef.current.currentTime = Math.min(
      audioRef.current.currentTime + seconds,
      audioRef.current.duration || 0,
    );
  }, []);

  const seekBackward = useCallback((seconds = 10) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(audioRef.current.currentTime - seconds, 0);
  }, []);

  const orbTap = useCallback(() => {
    switch (state) {
      case "idle":   play(); break;
      case "playing": pause(); break;
      case "paused": resume(); break;
      case "error":  setError(null); setState("idle"); break;
    }
  }, [state, play, pause, resume]);

  useEffect(() => () => {
    audioRef.current?.pause();
  }, []);

  return {
    state,
    progress,
    duration,
    error,
    language,

    // Story-level
    currentStoryIdx,
    currentStory,
    storiesWithAudio,

    // Section-level (derived, for UI)
    currentFeed,
    sectionsWithStories,

    // Controls
    play,
    playAll,
    playSection,
    playStory,
    playFrom,
    playFromInSection,
    next,
    prev,
    pause,
    resume,
    stop,
    seek,
    seekForward,
    seekBackward,
    orbTap,
  };
}
