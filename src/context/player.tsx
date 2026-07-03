/**
 * PlayerProvider — owns briefing + playback ABOVE the routes so audio keeps
 * playing (and the mini-player stays visible) when the user switches tabs
 * (Home → Saved → Settings). Previously this lived in the Home route, so
 * navigating away unmounted it and paused the audio.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue, getStoryTitle } from "@/hooks/useMonologue";
import { useSavedStories } from "@/hooks/useSavedStories";
import { PlayerScreen } from "@/components/PlayerScreen";
import { type SectionId, matchPublisher, readPreferredPublishers, PUBLISHERS_KEY } from "@/lib/news/sources";
import type { Story, DailyBriefing } from "@/lib/news/generator";

const SECTION_DISPLAY_ORDER: SectionId[] = ["headlines", "india", "world", "business", "technology", "sports", "science", "health"];
const LEGACY_SECTION: Record<string, SectionId> = { politics: "india", techlife: "technology", entertainment: "india", local: "india" };
function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (SECTION_DISPLAY_ORDER.includes(s as SectionId)) return s as SectionId;
  return "india";
}

type PlayerContextValue = {
  mono: ReturnType<typeof useMonologue>;
  highlightsMono: ReturnType<typeof useMonologue>;
  briefing: DailyBriefing | null;
  isLoading: boolean;
  saved: ReturnType<typeof useSavedStories>;
  openPlayer: () => void;
};

const PlayerCtx = createContext<PlayerContextValue | null>(null);

// ── Mini Player (portal) — persists across routes ───────────────────────────
// Shows whichever queue is currently active — the main story list, or the
// 15-minute Highlights briefing — so Highlights gets the same persistent
// mini-player/controls as normal playback instead of only the home hero card.
function MiniPlayer({
  mono, isHighlights, onOpen,
}: {
  mono: ReturnType<typeof useMonologue>;
  isHighlights: boolean;
  onOpen: () => void;
}) {
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
                  {isHighlights ? "15-Minute Highlights" : currentFeed ? (language === "hi" ? currentFeed.labelHi : currentFeed.label) : "Playing"}
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

  // Reader's preferred publisher(s) — set in Settings → Sources. Default = all 7
  // allowed mastheads (no narrowing). Re-read live when Settings updates it.
  const [preferredPublishers, setPreferredPublishers] = useState(readPreferredPublishers);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PUBLISHERS_KEY) setPreferredPublishers(readPreferredPublishers());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const rawBriefing = briefingQuery.data ?? null;
  const briefing = useMemo(() => {
    if (!rawBriefing) return null;
    const rank = (s: Story) => {
      const i = SECTION_DISPLAY_ORDER.indexOf(resolveSection(s.section));
      return i < 0 ? SECTION_DISPLAY_ORDER.length : i;
    };
    const stories = rawBriefing.stories
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => {
        const key = matchPublisher(s.source);
        // Stories from outside the 7-publisher allowlist (shouldn't happen post-generation,
        // but be defensive) are never filtered out by preference — only allowlisted
        // publishers are narrowed by the reader's picks.
        return key === null || preferredPublishers.has(key);
      })
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map((x) => x.s);
    return { ...rawBriefing, stories };
  }, [rawBriefing, preferredPublishers]);

  const mono = useMonologue({ briefing });

  // 15-minute Highlights briefing — a handful of pre-scripted multi-story
  // segments (see generator.ts buildHighlightSegments), played from the home
  // screen's hero card as a separate, shorter alternative to the full story
  // list. Reuses the same "synthetic briefing" trick as history.tsx's saved-
  // stories player: useMonologue just needs an array of Story-shaped objects,
  // so each HighlightSegment is wrapped as one.
  const highlightsBriefing: DailyBriefing | null = useMemo(() => {
    const segs = rawBriefing?.highlights?.filter(h => h.audioUrlEn);
    if (!segs || segs.length === 0) return null;
    const stories: Story[] = [...segs]
      .sort((a, b) => a.order - b.order)
      .map(h => ({
        id: h.id, title: h.label, source: "Khabar AI", link: "",
        publishedAt: rawBriefing!.generatedAt, section: "headlines",
        scriptEn: h.scriptEn, scriptHi: "", audioUrlEn: h.audioUrlEn,
        wordCount: h.wordCount,
      }));
    return { date: rawBriefing!.date, generatedAt: rawBriefing!.generatedAt, stories };
  }, [rawBriefing]);
  const highlightsMono = useMonologue({ briefing: highlightsBriefing });

  const saved = useSavedStories();
  const [playerOpen, setPlayerOpen] = useState(false);

  // Whichever queue is actually active drives the mini-player/full-player —
  // the main story list takes priority if both are somehow active at once
  // (shouldn't normally happen since starting one doesn't stop the other,
  // but the main list is the primary experience).
  const monoActive = mono.state === "playing" || mono.state === "paused";
  const highlightsActive = highlightsMono.state === "playing" || highlightsMono.state === "paused";
  const activeIsHighlights = !monoActive && highlightsActive;
  const activeMono = activeIsHighlights ? highlightsMono : mono;

  // Close the full player when playback stops
  useEffect(() => {
    if (mono.state === "idle" && highlightsMono.state === "idle") setPlayerOpen(false);
  }, [mono.state, highlightsMono.state]);

  // Persist which languages are available in this briefing
  useEffect(() => {
    if (!briefing?.stories?.length) return;
    const langs = ["en", "hi", "ta", "mr"].filter((lang) =>
      briefing.stories.some((s) => {
        if (lang === "en") return !!s.audioUrlEn;
        if (lang === "hi") return !!s.audioUrlHi;
        if (lang === "ta") return !!(s as any).audioUrlTa;
        if (lang === "mr") return !!(s as any).audioUrlMr;
        return false;
      }),
    );
    try { localStorage.setItem("khabar-available-languages", JSON.stringify(langs)); } catch {}
  }, [briefing]);

  const value: PlayerContextValue = {
    mono,
    highlightsMono,
    briefing,
    isLoading: briefingQuery.isLoading,
    saved,
    openPlayer: () => setPlayerOpen(true),
  };

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      <MiniPlayer mono={activeMono} isHighlights={activeIsHighlights} onOpen={() => setPlayerOpen(true)} />
      <PlayerScreen
        mono={activeMono}
        visible={playerOpen}
        onClose={() => setPlayerOpen(false)}
        // Saving doesn't apply to Highlights segments (no real article behind them)
        isSaved={!activeIsHighlights && activeMono.currentStory ? saved.isSaved(activeMono.currentStory.id) : false}
        onSave={() => !activeIsHighlights && activeMono.currentStory && saved.toggle(activeMono.currentStory)}
      />
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
