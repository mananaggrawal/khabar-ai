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
import { track } from "@/lib/analytics/track";
import { EVENTS } from "@/lib/analytics/events";

export type MonologueState = "idle" | "playing" | "paused" | "error";
export type Language = "en" | "hi" | "ta" | "mr";

const RESUME_KEY   = "khabar-resume-pos";
const LANGUAGE_KEY = "khabar-language";

// How early (seconds) to advance to the next clip when the app is backgrounded.
// iOS freezes page JS during the silent gap between clips, so we swap just before
// the current clip ends — while audio is still playing — to avoid the gap. In the
// foreground clips play fully (advance on 'ended'); only background trims this much.
const BG_ADVANCE_LEAD_SEC = 0.5;

const SUPPORTED_LANGS: Language[] = ["en", "hi", "ta", "mr"];

function readLanguage(): Language {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY) as Language;
    return SUPPORTED_LANGS.includes(v) ? v : "en";
  } catch { return "en"; }
}

export function getAudioUrl(story: import("@/lib/news/generator").Story, lang: Language): string | undefined {
  if (lang === "en") return story.audioUrlEn;
  if (lang === "hi") return story.audioUrlHi;
  if (lang === "ta") return story.audioUrlTa;
  if (lang === "mr") return story.audioUrlMr;
  return undefined;
}

export function getStoryTitle(story: import("@/lib/news/generator").Story, lang: Language): string {
  if (lang === "hi") return story.titleHi || story.title;
  if (lang === "ta") return (story as any).titleTa || story.title;
  if (lang === "mr") return (story as any).titleMr || story.title;
  return story.title;
}

export function useMonologue({ briefing }: { briefing: DailyBriefing | null }) {
  const [state, setState]               = useState<MonologueState>("idle");
  const [progress, setProgress]         = useState(0);
  const [duration, setDuration]         = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [currentStoryIdx, setCurrentStoryIdx] = useState(-1);
  const [queueMode, setQueueMode]       = useState<"all" | SectionId | null>(null);
  const [language, setLanguage]         = useState<Language>(readLanguage);

  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const preloadRef     = useRef<HTMLAudioElement | null>(null);
  const pauseTimeRef   = useRef(0);
  const currentIdxRef  = useRef(-1);
  const queueModeRef   = useRef<"all" | SectionId | null>(null);
  const lastSaveRef    = useRef(0);
  const playAtRef      = useRef<((idx: number, mode: "all" | SectionId | null, startAt?: number) => void) | null>(null);
  const endedHandlerRef = useRef<(() => void) | null>(null); // current track's advance handler
  const advancedRef     = useRef(false);                     // guard: one advance per track

  // Keep refs in sync
  useEffect(() => { currentIdxRef.current = currentStoryIdx; }, [currentStoryIdx]);
  useEffect(() => { queueModeRef.current = queueMode; }, [queueMode]);

  // React to language changes from settings
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_KEY) {
        const v = e.newValue as Language;
        setLanguage(SUPPORTED_LANGS.includes(v) ? v : "en");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Global keyboard shortcuts: Space = play/pause, ←/→ = seek ±10s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        const audio = audioRef.current;
        if (!audio) return;
        audio.paused ? audio.play().catch(() => {}) : audio.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (audioRef.current) audioRef.current.currentTime = Math.max(audioRef.current.currentTime - 10, 0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.currentTime + 10, audioRef.current.duration || 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Derived lists ─────────────────────────────────────────────────────────

  /** All stories that have audio in the current language */
  const storiesWithAudio = useMemo(
    () => (briefing?.stories ?? []).filter((s) => !!getAudioUrl(s, language)),
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
      // Reuse ONE persistent <audio> element for the whole session. On iOS PWA,
      // an element that started playing via a user gesture is allowed to keep
      // playing AND switch its src while the app is in the background; creating a
      // *new* Audio() in the background is blocked by the OS. That's why
      // auto-advance used to stop when the app was backgrounded — each story was a
      // fresh element. Reusing the element keeps advancing in the background.
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.preload = "auto";
      }
      const audio = audioRef.current;
      preloadRef.current = null;

      // Match by filename in case one URL is absolute and the other relative
      const filename = url.split('/').pop() ?? '';
      const srcChanged = !filename || !audio.src.endsWith(filename);
      if (srcChanged) {
        audio.src = url;
        audio.load();
      }
      if (startAt > 0) audio.currentTime = startAt;
      else if (srcChanged && audio.currentTime !== 0) audio.currentTime = 0;

      audio.onloadedmetadata = () => {
        setDuration(audio.duration);
        // Apply resume offset once metadata (and thus seekable range) is known
        if (startAt > 0 && Math.abs(audio.currentTime - startAt) > 0.5) {
          audio.currentTime = startAt;
        }
      };

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          const ct = audio.currentTime;
          setProgress(ct / audio.duration);

          // Background auto-advance: when the app is hidden/locked, iOS freezes JS in
          // the silent gap after a clip ends, so 'ended' never gets to start the next
          // one. While still playing (timeupdate keeps firing), advance just before the
          // end so there's no gap. Foreground keeps playing fully (advances on 'ended').
          if (
            typeof document !== "undefined" && document.hidden &&
            queueModeRef.current !== null &&
            endedHandlerRef.current &&
            !advancedRef.current &&
            audio.duration - ct <= BG_ADVANCE_LEAD_SEC
          ) {
            advancedRef.current = true;
            endedHandlerRef.current();
            return;
          }

          // Advance story index when crossing audioStartSec boundary (same section audio)
          const nextIdx = currentIdxRef.current + 1;
          const next = storiesWithAudio[nextIdx];
          if (next) {
            const nextUrl = getAudioUrl(next, language)!;
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
              const sUrl = getAudioUrl(s, language)!;
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

      const url = getAudioUrl(story, language)!;
      const seekTo = startAt > 0 ? startAt : (story.audioStartSec ?? 0);

      setError(null);
      setCurrentStoryIdx(idx);
      setQueueMode(mode);

      const onEnded = mode !== null
        ? () => {
            // Completion of the story that just finished
            const finished = storiesWithAudio[currentIdxRef.current];
            if (finished) {
              track(EVENTS.STORY_COMPLETE, {
                storyId: finished.id,
                section: finished.section,
                durationSec: Math.round(audioRef.current?.duration ?? 0),
              });
            }
            // Find the next story with a different audio file (next section)
            let next = currentIdxRef.current + 1;
            while (next < storiesWithAudio.length) {
              const s = storiesWithAudio[next];
              const sUrl = getAudioUrl(s, language)!;
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
            // Advance synchronously (no setTimeout — iOS throttles timers in the
            // background, which would stall auto-advance). Reusing the same audio
            // element lets play() succeed while backgrounded.
            playAtRef.current?.(next, queueModeRef.current, 0);
          }
        : undefined;

      // Register this track's advance handler for the background early-swap path
      endedHandlerRef.current = onEnded ?? null;
      advancedRef.current = false;

      // If same audio already loaded, just seek — no reload
      const curAudio = audioRef.current;
      const filename = url.split('/').pop() ?? '';
      if (curAudio && !curAudio.ended && filename && curAudio.src.endsWith(filename)) {
        if (seekTo > 0) curAudio.currentTime = seekTo;
        if (curAudio.paused) curAudio.play().catch(() => {});
        return;
      }

      track(EVENTS.STORY_START, { storyId: story.id, section: story.section, index: idx, mode: mode ?? "single" });

      const audio = attachAudio(url!, seekTo, onEnded);
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
    track(EVENTS.PLAY, {});
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
    const pos = audioRef.current?.currentTime ?? 0;
    if (audioRef.current) { pauseTimeRef.current = pos; audioRef.current.pause(); }
    setState("paused");
    track(EVENTS.PAUSE, { positionSec: Math.round(pos) });
  }, []);

  const resume = useCallback(async () => {
    if (audioRef.current?.paused) {
      await audioRef.current.play().catch(() => {});
    } else if (currentStoryIdx >= 0) {
      const story = storiesWithAudio[currentStoryIdx];
      if (story) {
        const url = getAudioUrl(story, language)!;
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

  // ── MediaSession API — enables background audio on iOS PWA ────────────────
  // Without this, iOS suspends audio the moment you switch apps.
  // With it, playback continues and Lock Screen / Control Centre controls work.

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!currentStory) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  getStoryTitle(currentStory, language),
      artist: currentFeed?.label ?? "Khabar AI",
      album:  "Khabar AI — Today's Briefing",
      artwork: currentStory.imageUrl
        ? [{ src: currentStory.imageUrl, sizes: "512x512", type: "image/jpeg" }]
        : [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
  }, [currentStory, language, currentFeed]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play",          () => resume());
    navigator.mediaSession.setActionHandler("pause",         () => pause());
    navigator.mediaSession.setActionHandler("nexttrack",     () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("stop",          () => stop());
    return () => {
      (["play", "pause", "nexttrack", "previoustrack", "stop"] as const).forEach(a => {
        try { navigator.mediaSession.setActionHandler(a, null); } catch {}
      });
    };
  }, [resume, pause, next, prev, stop]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState =
      state === "playing" ? "playing" :
      state === "paused"  ? "paused"  : "none";
  }, [state]);

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
