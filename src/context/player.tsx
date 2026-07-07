/**
 * PlayerProvider — owns briefing + playback ABOVE the routes so audio keeps
 * playing (and the mini-player stays visible) when the user switches tabs
 * (Home → Saved → Settings). Previously this lived in the Home route, so
 * navigating away unmounted it and paused the audio.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue, getStoryTitle, getSectionLabel, getAudioUrl, readCompletedIds } from "@/hooks/useMonologue";
import { useSavedStories } from "@/hooks/useSavedStories";
import { useCityPreference } from "@/hooks/useCityPreference";
import { useListenMode } from "@/hooks/useListenMode";
import { useQuickConsumed } from "@/hooks/useQuickConsumed";
import { buildQuickQueue, refreshQuickQueue } from "@/lib/news/quickQueue";
import { PlayerScreen } from "@/components/PlayerScreen";
import { type SectionId, type CityId } from "@/lib/news/sources";
import type { Story, DailyBriefing } from "@/lib/news/generator";

const SECTION_DISPLAY_ORDER: SectionId[] = ["headlines", "local", "india", "world", "business", "technology", "sports", "science", "health"];
const LEGACY_SECTION: Record<string, SectionId> = { politics: "india", techlife: "technology", entertainment: "india" };
function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (SECTION_DISPLAY_ORDER.includes(s as SectionId)) return s as SectionId;
  return "india";
}

type PlayerContextValue = {
  mono: ReturnType<typeof useMonologue>;
  briefing: DailyBriefing | null;
  isLoading: boolean;
  saved: ReturnType<typeof useSavedStories>;
  openPlayer: () => void;
  // Which cities actually have "local" content in TODAY's briefing (2026-07-06)
  // — computed from the UNFILTERED raw briefing, since `briefing` above is
  // already narrowed to the reader's own city. Lets Settings/CityNudge offer
  // a city as soon as the admin has generated it, without waiting for its
  // static `available` flag in sources.ts to be flipped in a deploy.
  generatedCities: Set<CityId>;
  // Full vs Quick 15 (2026-07-06) — Home reads this to swap its browse list
  // (section-grouped vs the single diverse Quick 15 batch) to match what
  // Play actually queues up; `mono.storiesWithAudio` already IS that batch
  // when this is "quick", in the exact curated order.
  listenMode: import("@/hooks/useListenMode").ListenMode;
  // Manual refresh (2026-07-06) — swaps only already-consumed slots in the
  // current Quick 15 batch for fresh unconsumed stories, in place. Disabled
  // (canRefreshQuick false) when nothing in the current batch has been
  // heard/skipped yet, since there'd be nothing to replace.
  canRefreshQuick: boolean;
  refreshQuickBatch: () => void;
};

const PlayerCtx = createContext<PlayerContextValue | null>(null);

// ── Mini Player (portal) — persists across routes ───────────────────────────
function MiniPlayer({ mono, onOpen }: { mono: ReturnType<typeof useMonologue>; onOpen: () => void }) {
  if (typeof document === "undefined") return null;
  const { state, progress, currentStory, currentFeed, pause, resume, language } = mono;
  const visible = state === "playing" || state === "paused";
  const isPlaying = state === "playing";

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 320 }}
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 62px)" }}
          className="fixed inset-x-3 z-50"
        >
          <div
            className="relative overflow-hidden rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-xl cursor-pointer"
            onClick={onOpen}
          >
            <div className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300" style={{ width: `${progress * 100}%` }} />
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentFeed ? getSectionLabel(currentFeed, language) : "Playing"}
                </p>
                <p className="truncate text-sm font-medium text-foreground leading-tight">
                  {currentStory ? getStoryTitle(currentStory, language) : "—"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => mono.prev()} aria-label="Previous"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors">
                  <SkipBack className="size-4 fill-current" />
                </button>
                <button onClick={isPlaying ? pause : resume} aria-label={isPlaying ? "Pause" : "Play"}
                  className="flex size-8 items-center justify-center rounded-full bg-primary text-white transition-transform active:scale-95">
                  {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                </button>
                <button onClick={() => mono.next()} aria-label="Next"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors">
                  <SkipForward className="size-4 fill-current" />
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const fn = useServerFn(fetchBriefing);
  const briefingQuery = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fn({ data: undefined as never }),
    staleTime: 5 * 60_000,
    enabled: typeof window !== "undefined",
  });

  const rawBriefing = briefingQuery.data ?? null;
  // 2026-07-06: several cities' local stories can share the one "local"
  // section in a single generation run (see generator.ts Story.city / the
  // admin panel's city checkboxes). Readers only see their OWN city's local
  // stories — this is the one place that filter is applied, so Home's list
  // and the playback order (which both read this same `briefing`) stay in
  // sync automatically. Stories with no `.city` tag (non-local sections, or
  // pre-this-change local stories) are never filtered out.
  const { city } = useCityPreference();
  const briefing = useMemo(() => {
    if (!rawBriefing) return null;
    const myCity = city ?? "mumbai";
    const rank = (s: Story) => {
      const i = SECTION_DISPLAY_ORDER.indexOf(resolveSection(s.section));
      return i < 0 ? SECTION_DISPLAY_ORDER.length : i;
    };
    const stories = rawBriefing.stories
      .filter((s) => resolveSection(s.section) !== "local" || !s.city || s.city === myCity)
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map((x) => x.s);
    return { ...rawBriefing, stories };
  }, [rawBriefing, city]);

  // Computed from rawBriefing (pre-city-filter) — see PlayerContextValue note.
  const generatedCities = useMemo(() => {
    const set = new Set<CityId>();
    for (const s of rawBriefing?.stories ?? []) {
      if (resolveSection(s.section) === "local" && s.city) set.add(s.city);
    }
    return set;
  }, [rawBriefing]);

  // ── Quick 15 mode (2026-07-06) ──────────────────────────────────────────
  // `briefing` above stays the full, normal per-section list — Home's browse
  // list is unaffected by listen mode. Only the PLAYBACK queue fed into
  // useMonologue changes: in "quick" mode it's a diverse, importance-weighted
  // batch (see buildQuickQueue) instead of the full briefing, in the same
  // `date`/shape useMonologue already expects, so resume/progress/completed
  // tracking all keep working unmodified.
  const { mode: listenMode } = useListenMode();
  const quick = useQuickConsumed(briefing?.date);
  const [quickBatch, setQuickBatch] = useState<Story[] | null>(null);

  // Avoids re-running the "build once" effect below every time a story is
  // marked consumed mid-batch — rebuilding on every consumption would yank
  // already-selected-but-not-yet-played stories out from under the queue
  // useMonologue is actively walking through. The ref always has the latest
  // value for the deliberate, explicit rebuild points (mode switch, batch
  // exhaustion) instead.
  const quickConsumedRef = useRef(quick.consumedIds);
  useEffect(() => { quickConsumedRef.current = quick.consumedIds; }, [quick.consumedIds]);

  // Tracks the currently-playing story's id while in Quick mode, so we know
  // what to mark consumed when playback moves away from it (see the effect
  // near the bottom) AND so handleQuickQueueEnd (below) can synchronously
  // exclude the just-finished LAST story of a batch from the next one — that
  // effect only runs on the following render, which is one tick too late for
  // buildNextQuickBatch() to see it via quick.consumedIds/quickConsumedRef.
  const prevQuickStoryIdRef = useRef<string | null>(null);

  // Excludes stories already heard/skipped via EITHER mode (2026-07-06,
  // explicit request) — quickConsumedRef alone only covers what happened in
  // Quick mode itself; a story fully heard in Full mode wouldn't otherwise
  // be excluded from a fresh Quick 15 batch. readCompletedIds() reads the
  // same localStorage source useMonologue's own completedIds is backed by,
  // callable directly (no need to wait on `mono`, which doesn't exist yet
  // when the very first batch is built).
  const buildNextQuickBatch = useCallback((): Story[] | null => {
    if (!briefing) return null;
    const excludeIds = new Set([...quickConsumedRef.current, ...readCompletedIds(briefing.date)]);
    return buildQuickQueue(briefing.stories, excludeIds);
  }, [briefing]);

  // Build the first batch when switching into Quick mode (or once the day's
  // briefing loads while already in it). Deliberately NOT re-run on every
  // quick.consumedIds change — see buildNextQuickBatch note above.
  useEffect(() => {
    if (listenMode !== "quick") { setQuickBatch(null); return; }
    setQuickBatch((prev) => prev ?? buildNextQuickBatch());
  }, [listenMode, buildNextQuickBatch]);

  // "Give me the next 15" — not a button anywhere, it's automatic: once the
  // current batch plays through to the end, load and immediately continue
  // into a fresh batch built from whatever's still unconsumed (per explicit
  // decision: auto-refill, not a manual tap). onQueueEnd only fires for a
  // natural end-of-"all"-queue, never for a manual stop() — see useMonologue.
  const [quickBatchVersion, setQuickBatchVersion] = useState(0);
  // Set when the batch "ends" but some of its OWN stories were never
  // actually heard — e.g. the user tapped a story further down the list,
  // jumping over earlier ones without them ever becoming "current" (so they
  // were never marked consumed). Consumed by the effect below (needs `mono`,
  // which isn't constructed yet at this point in the component).
  const [quickResumeIdx, setQuickResumeIdx] = useState<number | null>(null);
  const handleQuickQueueEnd = useCallback(() => {
    // Explicitly (synchronously) exclude the batch's last story here, rather
    // than waiting for the generic "story changed" effect below to catch it
    // — that effect only fires on the next render, after buildNextQuickBatch
    // has already run in this same tick, which would otherwise let that one
    // story slip into the very next batch.
    const lastId = prevQuickStoryIdRef.current;
    if (lastId) {
      quickConsumedRef.current = new Set(quickConsumedRef.current).add(lastId);
      quick.markConsumed(lastId);
    }

    // Don't refill yet if the CURRENT batch still has an unheard story in it
    // (2026-07-06, explicit decision) — finish the batch that's actually on
    // screen before moving to a new one, rather than leaving a jumped-over
    // story stranded and never played.
    if (quickBatch) {
      const unheardIdx = quickBatch.findIndex((s) => !quickConsumedRef.current.has(s.id));
      if (unheardIdx >= 0) {
        setQuickResumeIdx(unheardIdx);
        return;
      }
    }

    setQuickBatch(buildNextQuickBatch());
    setQuickBatchVersion((v) => v + 1);
  }, [buildNextQuickBatch, quick, quickBatch]);

  // Manual "Refresh" (2026-07-06) — swaps out only the already-consumed
  // (heard or skipped) slots in the CURRENT batch for fresh unconsumed
  // stories, in place at their exact original index. Deliberately NOT a
  // full rebuild: replacing in place means every story that hasn't been
  // reached yet — including whatever's currently playing — keeps the exact
  // same array position, so no resync of currentStoryIdx or the playing
  // <audio> element is needed at all; playback just continues undisturbed.
  const canRefreshQuick = listenMode === "quick" && !!quickBatch?.some((s) => quick.consumedIds.has(s.id));
  const refreshQuickBatch = useCallback(() => {
    if (!briefing || !quickBatch) return;
    // refreshQuickQueue walks the final array left-to-right and picks each
    // replacement against its actual final neighbor — not just a blind
    // splice — which is what actually keeps voices alternating through a
    // refresh (2026-07-06 fix; see quickQueue.ts for the full reasoning).
    // Also never draws a replacement that's already been heard via Full mode.
    setQuickBatch(refreshQuickQueue(quickBatch, briefing.stories, quickConsumedRef.current, readCompletedIds(briefing.date)));
  }, [briefing, quickBatch]);

  const activeBriefing = useMemo((): DailyBriefing | null => {
    if (listenMode !== "quick") return briefing;
    if (!briefing || !quickBatch) return null;
    return { ...briefing, stories: quickBatch };
  }, [listenMode, briefing, quickBatch]);

  const mono = useMonologue({
    briefing: activeBriefing,
    onQueueEnd: listenMode === "quick" ? handleQuickQueueEnd : undefined,
  });

  // Auto-continue into the freshly-built next batch once it lands (see
  // handleQuickQueueEnd above) — without this, the queue would correctly
  // refill but sit silently at idle instead of carrying on like radio.
  useEffect(() => {
    if (quickBatchVersion === 0) return; // skip the very first (non-refill) batch build
    if (listenMode === "quick" && quickBatch && quickBatch.length > 0) mono.playAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickBatchVersion]);

  // Resume into an unheard story still sitting in the CURRENT batch (see
  // handleQuickQueueEnd above) — e.g. one that got jumped over earlier —
  // instead of refilling with a brand new batch while it's stranded.
  useEffect(() => {
    if (quickResumeIdx === null) return;
    mono.playFrom(quickResumeIdx);
    setQuickResumeIdx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickResumeIdx]);

  // Mark a story "consumed" for Quick mode the moment playback moves past it
  // — on completion AND on skip (explicit decision: Quick mode is radio-like,
  // skipping still counts so it won't resurface next batch, even though it
  // stays "unlistened" in the normal per-section list, which uses the
  // separate completedIds/full-listen tracker instead). The batch's very
  // last story is instead handled synchronously in handleQuickQueueEnd above.
  useEffect(() => {
    if (listenMode !== "quick") { prevQuickStoryIdRef.current = null; return; }
    const curId = mono.currentStory?.id ?? null;
    if (prevQuickStoryIdRef.current && prevQuickStoryIdRef.current !== curId) {
      quick.markConsumed(prevQuickStoryIdRef.current);
    }
    prevQuickStoryIdRef.current = curId;
  }, [listenMode, mono.currentStory?.id, quick]);

  const saved = useSavedStories();
  const [playerOpen, setPlayerOpen] = useState(false);

  // Close the full player when playback stops
  useEffect(() => { if (mono.state === "idle") setPlayerOpen(false); }, [mono.state]);

  // Persist which languages are available in this briefing. Requires at least
  // half the stories to have audio in that language (2026-07-05, was "any
  // single story") — with the old any-story threshold, a language with only a
  // handful of successful translations (e.g. after a partial translateAll
  // failure) would show as fully selectable in Settings even though the
  // filtered feed (see routes/index.tsx) would then show almost nothing in it.
  const AVAILABLE_LANG_COVERAGE = 0.5;
  useEffect(() => {
    if (!briefing?.stories?.length) return;
    const total = briefing.stories.length;
    const allLangs: Array<"en" | "hi" | "ta" | "mr"> = ["en", "hi", "ta", "mr"];
    const langs = allLangs.filter((lang) => {
      const withAudio = briefing.stories.filter((s) => !!getAudioUrl(s, lang)).length;
      return withAudio / total >= AVAILABLE_LANG_COVERAGE;
    });
    try { localStorage.setItem("khabar-available-languages", JSON.stringify(langs)); } catch {}
  }, [briefing]);

  const value: PlayerContextValue = {
    mono,
    briefing,
    isLoading: briefingQuery.isLoading,
    saved,
    openPlayer: () => setPlayerOpen(true),
    generatedCities,
    listenMode,
    canRefreshQuick,
    refreshQuickBatch,
  };

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      <MiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} />
      <PlayerScreen
        mono={mono}
        visible={playerOpen}
        onClose={() => setPlayerOpen(false)}
        isSaved={mono.currentStory ? saved.isSaved(mono.currentStory.id) : false}
        onSave={() => mono.currentStory && saved.toggle(mono.currentStory)}
      />
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
