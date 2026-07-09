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
import { EVENTS, HEARTBEAT_SEC } from "@/lib/analytics/events";

export type MonologueState = "idle" | "playing" | "paused" | "error";
export type Language = "en" | "hi";

// Legacy/removed section names → current section (2026-07-09 bug fix) — every
// OTHER file that reads a story's `.section` (routes/index.tsx, StoryCard.tsx,
// PlayerScreen.tsx, context/player.tsx) already normalizes it through an
// equivalent map before touching FEED_MAP; this file was the one place that
// didn't, and did `FEED_MAP.get(story.section)!` (non-null asserted). Any
// story still carrying an old tag no longer in FEED_MAP — most concretely
// "local" (removed 2026-07-08), but also the older politics/techlife/
// entertainment tags — made that assertion lie and crashed the whole app on
// "Cannot read properties of undefined (reading 'label')" the moment such a
// story showed up in a loaded briefing.
const LEGACY_SECTION: Record<string, SectionId> = { politics: "india", techlife: "technology", entertainment: "india" };
function resolveSection(s: SectionId): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (FEED_MAP.has(s)) return s;
  return "india";
}

const RESUME_KEY    = "khabar-resume-pos";
const LANGUAGE_KEY  = "khabar-language";
const COMPLETED_KEY = "khabar-completed";   // { date, ids: [] } — persists "listened" marks

// How early (seconds) to advance to the next clip when the app is backgrounded.
// iOS freezes page JS during the silent gap between clips, so we swap just before
// the current clip ends — while audio is still playing — to avoid the gap. In the
// foreground clips play fully (advance on 'ended'); only background trims this much.
const BG_ADVANCE_LEAD_SEC = 0.5;

const SUPPORTED_LANGS: Language[] = ["en", "hi"];

function readLanguage(): Language {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY) as Language;
    return SUPPORTED_LANGS.includes(v) ? v : "en";
  } catch { return "en"; }
}

// Exported (2026-07-06) so PlayerProvider can read "already heard" stories
// synchronously when building a Quick 15 batch — that happens before
// useMonologue (and its own completedIds state) necessarily exists yet, so
// it can't just read `mono.completedIds`. This is the same localStorage
// source of truth, just callable without a hook. Since skipping a story now
// marks it completed everywhere (not just playing it to the end — see
// playAt's skip-marks-completed fix), this one set already reflects
// "heard/skipped in EITHER Full or Quick mode."
export function readCompletedIds(date: string | undefined): Set<string> {
  if (!date) return new Set();
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj?.date === date && Array.isArray(obj.ids) ? new Set(obj.ids) : new Set();
  } catch {
    return new Set();
  }
}

export function getAudioUrl(story: import("@/lib/news/generator").Story, lang: Language): string | undefined {
  if (lang === "en") return story.audioUrlEn;
  if (lang === "hi") return story.audioUrlHi;
  return undefined;
}

export function getStoryTitle(story: import("@/lib/news/generator").Story, lang: Language): string {
  if (lang === "hi") return story.titleHi || story.title;
  return story.title;
}

// Language-aware section label. Previously every call site hardcoded
// `language === "hi" ? labelHi : label`, so listeners saw English section
// headers (Headlines/India/World/…) everywhere even though their story
// titles and scripts were correctly localized — centralising here so every
// screen (StoryCard, PlayerScreen, MiniPlayer, StoryDetailSheet) picks up
// both languages the same way.
export function getSectionLabel(
  feed: { label: string; labelHi: string } | null | undefined,
  lang: Language,
): string {
  if (!feed) return "";
  if (lang === "hi") return feed.labelHi || feed.label;
  return feed.label;
}

const IS_LOCAL = typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_LOCAL_MODE === "true";

// ── Per-account "listened" sync (Supabase) ─────────────────────────────────
// Marks are cached in localStorage for instant paint, and mirrored to Supabase
// (keyed by user + briefing date) so they follow the account across devices.
async function syncCompletedUp(date: string, id: string): Promise<void> {
  if (IS_LOCAL || !date) return;
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await (supabase as any).from("listened_stories").upsert(
      { user_id: user.id, briefing_date: date, story_id: id },
      { onConflict: "user_id,briefing_date,story_id" },
    );
  } catch { /* offline / not signed in — localStorage still holds it */ }
}
async function fetchCompleted(date: string): Promise<string[]> {
  if (IS_LOCAL || !date) return [];
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await (supabase as any)
      .from("listened_stories").select("story_id")
      .eq("user_id", user.id).eq("briefing_date", date);
    return (data ?? []).map((r: any) => r.story_id as string);
  } catch { return []; }
}

export function useMonologue({
  briefing,
  onQueueEnd,
  queueSource,
}: {
  briefing: DailyBriefing | null;
  // Fires when an "all"-mode queue runs off the end of storiesWithAudio
  // naturally (2026-07-06, added for Quick 15 mode) — NOT on a manual stop()
  // or a section-mode boundary (that's a different, unrelated early-exit
  // branch below). PlayerProvider uses this single hook to know "the batch
  // finished, build and start the next one" without useMonologue needing to
  // know anything about Quick mode itself.
  onQueueEnd?: () => void;
  // Tags story_start/heartbeat analytics with which curated queue is playing
  // (2026-07-09) — e.g. "quick15" when PlayerProvider has substituted
  // `quickBatch` in as `briefing.stories`. Undefined for ordinary Full-mode
  // playback. Purely a label for handleAnalytics; doesn't affect playback.
  queueSource?: string;
}) {
  const [state, setState]               = useState<MonologueState>("idle");
  const [progress, setProgress]         = useState(0);
  const [duration, setDuration]         = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [currentStoryIdx, setCurrentStoryIdx] = useState(-1);
  const [queueMode, setQueueMode]       = useState<"all" | SectionId | null>(null);
  const [language, setLanguage]         = useState<Language>(readLanguage);
  // Story ids the listener has heard to the end (subtle "listened" marker in the UI)
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set());

  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const preloadRef     = useRef<HTMLAudioElement | null>(null);
  const pauseTimeRef   = useRef(0);
  const currentIdxRef  = useRef(-1);
  const queueModeRef   = useRef<"all" | SectionId | null>(null);
  const lastSaveRef    = useRef(0);
  const playAtRef      = useRef<((idx: number, mode: "all" | SectionId | null, startAt?: number) => void) | null>(null);
  const endedHandlerRef = useRef<(() => void) | null>(null); // current track's advance handler
  const advancedRef     = useRef(false);                     // guard: one advance per track
  const currentDateRef  = useRef<string>("");                // briefing date, for persisting completed marks

  const markCompleted = useCallback((id: string | undefined) => {
    if (!id) return;
    setCompletedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      // Write through so the "listened" marks survive an app kill/relaunch
      try { localStorage.setItem(COMPLETED_KEY, JSON.stringify({ date: currentDateRef.current, ids: [...next] })); } catch {}
      return next;
    });
    syncCompletedUp(currentDateRef.current, id);   // mirror to the account (fire-and-forget)
  }, []);

  // Load persisted "listened" marks for the current briefing (reset on a new day).
  // localStorage paints instantly; the account's rows merge in when they arrive.
  useEffect(() => {
    const d = briefing?.date;
    if (!d) return;
    currentDateRef.current = d;
    setCompletedIds(readCompletedIds(d));
    fetchCompleted(d).then((ids) => {
      if (!ids.length) return;
      setCompletedIds((prev) => {
        const next = new Set(prev); ids.forEach((x) => next.add(x));
        try { localStorage.setItem(COMPLETED_KEY, JSON.stringify({ date: d, ids: [...next] })); } catch {}
        return next;
      });
    });
  }, [briefing?.date]);

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
      const section = resolveSection(story.section);
      if (!seen.has(section)) {
        seen.add(section);
        const feed = FEED_MAP.get(section)!;
        result.push({ id: section, label: feed.label, labelHi: feed.labelHi, emoji: feed.emoji, stories: [] });
      }
      result.find((s) => s.id === section)!.stories.push(story);
    }
    return result;
  }, [storiesWithAudio]);

  const currentStory: Story | null =
    currentStoryIdx >= 0 ? storiesWithAudio[currentStoryIdx] ?? null : null;

  const currentFeed = currentStory ? FEED_MAP.get(resolveSection(currentStory.section)) ?? null : null;

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
        // Reflect the resume position on the progress bar even before play starts
        if (startAt > 0 && audio.duration > 0) setProgress(startAt / audio.duration);
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
            markCompleted(storiesWithAudio[currentIdxRef.current]?.id);
            endedHandlerRef.current();
            return;
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
        markCompleted(storiesWithAudio[currentIdxRef.current]?.id);
        if (onEnded) onEnded();
        else setState("idle");
      };
      audio.onerror = () => { setState("error"); setError("Audio playback failed."); };

      return audio;
    },
    [briefing, language, storiesWithAudio, markCompleted],
  );

  // ── Resume on relaunch ──────────────────────────────────────────────────────
  // If the app was killed mid-briefing, bring back the mini-player showing the last
  // story, cued to where we left off. iOS blocks autoplay without a gesture, so we
  // restore in the PAUSED state — one tap on play resumes from the saved position.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !storiesWithAudio.length) return;
    hydratedRef.current = true;
    try {
      const saved = localStorage.getItem(RESUME_KEY);
      if (!saved) return;
      const { idx, time, date, lang } = JSON.parse(saved);
      const dateMatch = !date || date === briefing?.date;
      const langMatch = !lang || lang === language;
      if (idx >= 0 && idx < storiesWithAudio.length && time > 2 && dateMatch && langMatch) {
        if (!getAudioUrl(storiesWithAudio[idx], language)) return;
        // Cue the mini-player WITHOUT attaching audio. The first play() goes through
        // playAt (via resume), which fully wires queue auto-advance. Attaching here
        // would leave an un-wired element that plays one clip then stops.
        setCurrentStoryIdx(idx);
        setQueueMode("all");
        pauseTimeRef.current = time;
        setState("paused");
      }
    } catch {}
  }, [storiesWithAudio, briefing, language]);

  // ── Core play function ────────────────────────────────────────────────────

  const playAt = useCallback(
    (idx: number, mode: "all" | SectionId | null, startAt = 0) => {
      const story = storiesWithAudio[idx];
      if (!story) { setState("idle"); setCurrentStoryIdx(-1); return; }

      // BUG FIX/FEATURE (2026-07-06): skipping away from a story — next(),
      // prev(), tapping a different story, or auto-advance — now marks it
      // "listened" too, not just playing it to the very end. currentIdxRef
      // still holds the OLD story here (it's only synced to currentStoryIdx
      // by a separate effect, which hasn't run yet for this synchronous
      // call), so this fires exactly once per real transition away from a
      // story. Auto-advance already calls markCompleted itself in the
      // 'ended' handler before reaching here — markCompleted no-ops on an
      // id it's already recorded, so that overlap is harmless.
      const prevIdx = currentIdxRef.current;
      if (prevIdx >= 0 && prevIdx !== idx) {
        markCompleted(storiesWithAudio[prevIdx]?.id);
      }

      const url = getAudioUrl(story, language)!;
      const seekTo = startAt > 0 ? startAt : (story.audioStartSec ?? 0);

      setError(null);
      setCurrentStoryIdx(idx);
      setQueueMode(mode);

      const onEnded = mode !== null
        ? () => {
            // Find the next story with a different audio file (next section),
            // ALSO skipping any story already marked "listened" — whether
            // heard/skipped in Full mode or Quick mode, since both write to
            // this same completedIds tracker (2026-07-06, explicit request:
            // auto-advance should never land on something already played,
            // regardless of which mode played it).
            let next = currentIdxRef.current + 1;
            while (next < storiesWithAudio.length) {
              const s = storiesWithAudio[next];
              const sUrl = getAudioUrl(s, language)!;
              const sFilename = sUrl?.split('/').pop() ?? '';
              const sameFileAsCurrent = !!sFilename && url.endsWith(sFilename);
              if (!sameFileAsCurrent && !completedIds.has(s.id)) break;
              next++;
            }
            if (next >= storiesWithAudio.length) {
              setState("idle"); setCurrentStoryIdx(-1); setQueueMode(null);
              try { localStorage.removeItem(RESUME_KEY); } catch {}
              if (mode === "all") onQueueEnd?.();
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

      track(EVENTS.STORY_START, { storyId: story.id, section: story.section, index: idx, mode: mode ?? "single", queueSource });

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
    [storiesWithAudio, language, attachAudio, onQueueEnd, markCompleted, completedIds, queueSource],
  );

  useEffect(() => { playAtRef.current = playAt; }, [playAt]);

  // ── Public API ────────────────────────────────────────────────────────────

  // Starts at the first not-yet-heard story rather than always index 0
  // (2026-07-06) — same "never auto-play something already played" rule as
  // the auto-advance skip above. Falls back to 0 (replay from the top) once
  // genuinely everything has been heard, rather than doing nothing.
  const playAll = useCallback(() => {
    const startIdx = storiesWithAudio.findIndex((s) => !completedIds.has(s.id));
    playAt(startIdx >= 0 ? startIdx : 0, "all");
  }, [playAt, storiesWithAudio, completedIds]);

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
    const pos = audioRef.current?.currentTime ?? 0;
    if (audioRef.current) { pauseTimeRef.current = pos; audioRef.current.pause(); }
    setState("paused");
  }, []);

  const resume = useCallback(async () => {
    const a = audioRef.current;
    if (a && !a.ended && a.paused) { await a.play().catch(() => {}); return; }
    // No live audio element (e.g. resumed after relaunch) — (re)start via playAt so
    // queue auto-advance is properly wired instead of playing an un-wired element.
    const idx = currentIdxRef.current;
    if (idx >= 0) playAtRef.current?.(idx, queueModeRef.current ?? "all", pauseTimeRef.current || 0);
  }, []);

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

  // ── Analytics heartbeat ───────────────────────────────────────────────────
  // Every HEARTBEAT_SEC while the app is open, log one tick tagged with whether
  // audio is playing and whether the app is foreground. Minutes listened =
  // playing ticks; time on app = foreground ticks. That's the whole measurement.
  useEffect(() => {
    const id = setInterval(() => {
      const a = audioRef.current;
      const playing = !!a && !a.paused && !a.ended && a.currentTime > 0;
      const visible = typeof document === "undefined" ? true : !document.hidden;
      if (!playing && !visible) return;
      const s = playing ? storiesWithAudio[currentIdxRef.current] : undefined;
      track(EVENTS.HEARTBEAT, {
        seconds: HEARTBEAT_SEC,
        playing,
        visible,
        storyId: s?.id ?? null,
        section: s?.section ?? null,
        queueSource: playing ? queueSource ?? null : null,
      });
    }, HEARTBEAT_SEC * 1000);
    return () => clearInterval(id);
  }, [storiesWithAudio, queueSource]);

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
    completedIds,

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
