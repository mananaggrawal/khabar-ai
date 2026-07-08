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
import { useRouterState } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue, getStoryTitle, getSectionLabel, getAudioUrl, readCompletedIds } from "@/hooks/useMonologue";
import { useSavedStories } from "@/hooks/useSavedStories";
import { useCityPreference } from "@/hooks/useCityPreference";
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
  // Quick 15 (2026-07-07 rewrite) — no longer a global mode; it's a
  // permanent section/pill on Home that coexists with the real topic
  // sections. `quickBatch` is the current curated 15-story list, built and
  // kept ready regardless of whether anything's actively playing from it —
  // Home renders this directly under the Quick 15 pill. `quickActive` is
  // ONLY true while `mono` is actually bound to and playing through that
  // batch (flips only in response to an explicit play action from either
  // side — see playFromQuick/playFromFull — never just from browsing a
  // pill), so switching which pill you're LOOKING at never disrupts
  // whatever's currently playing.
  quickBatch: Story[] | null;
  quickActive: boolean;
  playFromQuick: (idx: number) => void;
  // `section`, when passed, scopes auto-advance to just that section (mirrors
  // mono.playFromInSection) — needed so opening a story from StoryDetailSheet
  // on a real section still auto-advances only within that section, matching
  // its pre-Quick-15 behavior, instead of falling through into "all" mode.
  playFromFull: (idx: number, section?: SectionId) => void;
  // Manual refresh — swaps only already-consumed slots in the current Quick
  // 15 batch for fresh unconsumed stories, in place. Disabled
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

  // ── Quick 15 (2026-07-07 rewrite — no longer a global mode) ─────────────
  // `briefing` stays the full, normal per-section list at all times — Home's
  // browse list for real sections is never affected by Quick 15 existing.
  // `quickBatch` is built and kept ready as soon as the day's briefing loads,
  // independent of whether it's currently playing or even being viewed, so
  // it's ready the instant someone taps the pill.
  const quick = useQuickConsumed(briefing?.date);
  const [quickBatch, setQuickBatch] = useState<Story[] | null>(null);

  // `quickActive` — true ONLY while `mono` is actually bound to and playing
  // through the quick batch. Deliberately NOT tied to "which pill is being
  // viewed": since Full and Quick share the one playback engine but use
  // DIFFERENT underlying arrays, flipping this just from browsing would yank
  // the array out from under whatever's already playing. It only changes in
  // direct response to an explicit play action (playFromQuick/playFromFull).
  const [quickActive, setQuickActive] = useState(false);
  // Set alongside quickActive when that play action needs to wait for `mono`
  // to actually finish rebinding to the new array before firing — see the
  // effect below for why this can't just call mono.playFrom() synchronously.
  // `section` carries through to playFromFull's section-scoped auto-advance
  // (see PlayerContextValue.playFromFull); null means unscoped ("all" mode).
  const [pendingPlay, setPendingPlay] = useState<{ idx: number; section: SectionId | null } | null>(null);

  // Avoids re-running the "build once" effect below every time a story is
  // marked consumed mid-batch — rebuilding on every consumption would yank
  // already-selected-but-not-yet-played stories out from under the queue
  // useMonologue is actively walking through. The ref always has the latest
  // value for the deliberate, explicit rebuild points (batch exhaustion,
  // refresh) instead.
  const quickConsumedRef = useRef(quick.consumedIds);
  useEffect(() => { quickConsumedRef.current = quick.consumedIds; }, [quick.consumedIds]);

  // Tracks the currently-playing story's id while quickActive, so we know
  // what to mark consumed when playback moves away from it (see the effect
  // near the bottom) AND so handleQuickQueueEnd (below) can synchronously
  // exclude the just-finished LAST story of a batch from the next one — that
  // effect only runs on the following render, which is one tick too late for
  // buildNextQuickBatch() to see it via quick.consumedIds/quickConsumedRef.
  const prevQuickStoryIdRef = useRef<string | null>(null);

  // Excludes stories already heard/skipped via EITHER Full or Quick — a
  // story fully heard in Full mode is excluded from Quick batches too.
  // readCompletedIds() reads the same localStorage source useMonologue's own
  // completedIds is backed by, callable directly (no need to wait on `mono`,
  // which doesn't exist yet when the very first batch is built).
  const buildNextQuickBatch = useCallback((): Story[] | null => {
    if (!briefing) return null;
    const excludeIds = new Set([...quickConsumedRef.current, ...readCompletedIds(briefing.date)]);
    return buildQuickQueue(briefing.stories, excludeIds);
  }, [briefing]);

  // Build the batch as soon as the day's briefing is available — always, not
  // gated by any mode, so it's ready the moment Home renders the pill.
  useEffect(() => {
    if (!briefing) { setQuickBatch(null); return; }
    setQuickBatch((prev) => prev ?? buildNextQuickBatch());
  }, [briefing, buildNextQuickBatch]);

  // "Give me the next 15" — not a button anywhere, it's automatic: once the
  // current batch plays through to the end, load and immediately continue
  // into a fresh batch built from whatever's still unconsumed (per explicit
  // decision: auto-refill, never falls through to another section).
  // onQueueEnd only fires for a natural end-of-"all"-queue, never for a
  // manual stop() — see useMonologue.
  const [quickBatchVersion, setQuickBatchVersion] = useState(0);
  // Set when the batch "ends" but some of its OWN stories were never
  // actually heard — e.g. the user tapped a story further down the list,
  // jumping over earlier ones without them ever becoming "current" (so they
  // were never marked consumed).
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
    // — finish the batch that's actually on screen before moving to a new
    // one, rather than leaving a jumped-over story stranded and never played.
    if (quickBatch) {
      const unheardIdx = quickBatch.findIndex((s) => !quickConsumedRef.current.has(s.id));
      if (unheardIdx >= 0) {
        setPendingPlay({ idx: unheardIdx, section: null });
        return;
      }
    }

    setQuickBatch(buildNextQuickBatch());
    setQuickBatchVersion((v) => v + 1);
  }, [buildNextQuickBatch, quick, quickBatch]);

  const activeBriefing = useMemo((): DailyBriefing | null => {
    if (!quickActive) return briefing;
    if (!briefing || !quickBatch) return null;
    return { ...briefing, stories: quickBatch };
  }, [quickActive, briefing, quickBatch]);

  const mono = useMonologue({
    briefing: activeBriefing,
    onQueueEnd: quickActive ? handleQuickQueueEnd : undefined,
  });

  // Switching between Full and Quick is a deliberate two-step handshake, not
  // a single synchronous call — `activeBriefing`/`mono` only reflect a new
  // `quickActive` value on the NEXT render (React state updates aren't
  // visible until then), so calling mono.playFrom() in the same tick as
  // flipping quickActive would still hit the OLD array. Instead we set
  // pendingPlay and let this effect fire the actual play once `mono` has
  // genuinely rebound — checking storiesWithAudio[idx] exists handles the
  // case where quickBatch itself was still null and needed a moment to build.
  useEffect(() => {
    if (pendingPlay === null) return;
    if (!mono.storiesWithAudio[pendingPlay.idx]) return;
    if (pendingPlay.section) mono.playFromInSection(pendingPlay.idx, pendingPlay.section);
    else mono.playFrom(pendingPlay.idx);
    setPendingPlay(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mono.storiesWithAudio, pendingPlay]);

  const playFromQuick = useCallback((idx: number) => {
    if (quickActive) { mono.playFrom(idx); return; }
    setQuickActive(true);
    setPendingPlay({ idx, section: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickActive]);

  const playFromFull = useCallback((idx: number, section?: SectionId) => {
    if (!quickActive) {
      if (section) mono.playFromInSection(idx, section);
      else mono.playFrom(idx);
      return;
    }
    setQuickActive(false);
    setPendingPlay({ idx, section: section ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickActive]);

  // Auto-continue into the freshly-built next batch once it lands (see
  // handleQuickQueueEnd above) — without this, the queue would correctly
  // refill but sit silently at idle instead of carrying on like radio.
  useEffect(() => {
    if (quickBatchVersion === 0) return; // skip the very first (non-refill) batch build
    if (quickActive && quickBatch && quickBatch.length > 0) mono.playAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickBatchVersion]);

  // Mark a story "consumed" for Quick mode the moment playback moves past it
  // — on completion AND on skip (explicit decision: Quick mode is radio-like,
  // skipping still counts so it won't resurface next batch, even though it
  // stays "unlistened" in the normal per-section list, which uses the
  // separate completedIds/full-listen tracker instead). The batch's very
  // last story is instead handled synchronously in handleQuickQueueEnd above.
  useEffect(() => {
    if (!quickActive) { prevQuickStoryIdRef.current = null; return; }
    const curId = mono.currentStory?.id ?? null;
    if (prevQuickStoryIdRef.current && prevQuickStoryIdRef.current !== curId) {
      quick.markConsumed(prevQuickStoryIdRef.current);
    }
    prevQuickStoryIdRef.current = curId;
  }, [quickActive, mono.currentStory?.id, quick]);

  // Manual "Refresh" — swaps out only the already-consumed (heard or
  // skipped) slots in the CURRENT batch for fresh unconsumed stories, in
  // place at their exact original index. Deliberately NOT a full rebuild:
  // replacing in place means every story that hasn't been reached yet —
  // including whatever's currently playing — keeps the exact same array
  // position, so no resync of currentStoryIdx or the playing <audio> element
  // is needed at all; playback just continues undisturbed. Available
  // whenever the batch itself has consumed slots, regardless of quickActive
  // — you can refresh the list while just browsing it, not only while it's
  // the one playing.
  //
  // BUG FIX (2026-07-07): a story fully heard via FULL mode only ever lands
  // in mono.completedIds, never in quick.consumedIds (the quick-only
  // tracker) — since `quickBatch` is built once and cached, that story just
  // sat in the batch forever looking "already seen" with no way to swap it
  // out, because both canRefreshQuick and the refresh itself only checked
  // quick.consumedIds. Now both also treat a mono.completedIds match as a
  // slot that needs replacing.
  const isQuickSlotStale = useCallback(
    (id: string) => quick.consumedIds.has(id) || mono.completedIds.has(id),
    [quick.consumedIds, mono.completedIds],
  );
  const canRefreshQuick = !!quickBatch?.some((s) => isQuickSlotStale(s.id));
  const refreshQuickBatch = useCallback(() => {
    if (!briefing || !quickBatch) return;
    // Which SLOTS in the current batch need replacing — current-batch-scoped
    // is correct here, since refreshQuickQueue walks exactly this array.
    const staleIds = new Set(quickBatch.filter((s) => isQuickSlotStale(s.id)).map((s) => s.id));
    // BUG FIX (2026-07-08): which ids to AVOID drawing IN as replacements
    // must be the FULL historical quick.consumedIds — not just staleIds
    // above, which only covers what's stale in the CURRENT batch. A story
    // consumed in an EARLIER Quick 15 batch (already scrolled past, no
    // longer present in `quickBatch` at all) was never in that scoped set,
    // so it was eligible to get redrawn as a "fresh" replacement here —
    // exactly the "refresh gives me stories I've already heard" bug.
    const excludeFromPool = new Set([
      ...quickConsumedRef.current,
      ...mono.completedIds,
      ...readCompletedIds(briefing.date),
    ]);
    setQuickBatch(refreshQuickQueue(quickBatch, briefing.stories, staleIds, excludeFromPool));
  }, [briefing, quickBatch, isQuickSlotStale, mono.completedIds]);

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
    quickBatch,
    quickActive,
    playFromQuick,
    playFromFull,
    canRefreshQuick,
    refreshQuickBatch,
  };

  // Defensive guard (2026-07-08) — PlayerProvider deliberately lives above
  // every route so audio survives normal tab navigation (Home → Saved →
  // Settings), but that also means the mini-player would otherwise keep
  // floating on top of /auth if playback was active right when the session
  // ended (e.g. sign-out — now also stopped explicitly at that call site,
  // see settings.tsx's signOut()). Belt-and-suspenders: never render either
  // player surface on the signed-out screen, regardless of how it got there.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onAuthPage = pathname.startsWith("/auth");

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      {!onAuthPage && (
        <>
          <MiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} />
          <PlayerScreen
            mono={mono}
            visible={playerOpen}
            onClose={() => setPlayerOpen(false)}
            isSaved={mono.currentStory ? saved.isSaved(mono.currentStory.id) : false}
            onSave={() => mono.currentStory && saved.toggle(mono.currentStory)}
          />
        </>
      )}
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
