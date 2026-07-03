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
import { type SectionId } from "@/lib/news/sources";
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
  briefing: DailyBriefing | null;
  isLoading: boolean;
  saved: ReturnType<typeof useSavedStories>;
  openPlayer: () => void;
  // Whether a story-detail summary drawer is currently open somewhere (Home or
  // Saved) — lets the mini-player hug the true bottom edge instead of leaving
  // its usual bottom-nav clearance, since the drawer covers the nav anyway.
  detailSheetOpen: boolean;
  setDetailSheetOpen: (v: boolean) => void;
};

const PlayerCtx = createContext<PlayerContextValue | null>(null);

// ── Mini Player (portal) — persists across routes ───────────────────────────
function MiniPlayer({
  mono, onOpen, flush = false,
}: {
  mono: ReturnType<typeof useMonologue>;
  onOpen: () => void;
  /** True while a summary drawer covers the bottom nav — sit near the literal
   *  bottom edge (same floating-pill look as the home screen) instead of the
   *  usual nav-clearance offset, which would otherwise float mid-drawer. */
  flush?: boolean;
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
          style={{ bottom: flush ? "calc(env(safe-area-inset-bottom, 0px) + 12px)" : "calc(env(safe-area-inset-bottom, 0px) + 62px)" }}
          // z-[58]: above the story-detail summary drawer (z-55/56) so play/pause
          // stays reachable while it's open, but below the full-screen player
          // (z-60), which already has its own transport controls.
          className="fixed inset-x-3 z-[58]"
        >
          <div
            className={
              // Over the drawer (flush), a translucent/blurred card just reads as a
              // mismatched gray patch against its solid white — use a plain white
              // card with a lighter shadow there instead of the blur meant for
              // floating over the story list/images.
              flush
                ? "relative overflow-hidden rounded-2xl border border-border bg-white shadow-md cursor-pointer"
                : "relative overflow-hidden rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-xl cursor-pointer"
            }
            onClick={onOpen}
          >
            <div className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300" style={{ width: `${progress * 100}%` }} />
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentFeed ? (language === "hi" ? currentFeed.labelHi : currentFeed.label) : "Playing"}
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
  const briefing = useMemo(() => {
    if (!rawBriefing) return null;
    const rank = (s: Story) => {
      const i = SECTION_DISPLAY_ORDER.indexOf(resolveSection(s.section));
      return i < 0 ? SECTION_DISPLAY_ORDER.length : i;
    };
    const stories = rawBriefing.stories
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map((x) => x.s);
    return { ...rawBriefing, stories };
  }, [rawBriefing]);

  const mono = useMonologue({ briefing });
  const saved = useSavedStories();
  const [playerOpen, setPlayerOpen] = useState(false);
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);

  // Close the full player when playback stops
  useEffect(() => { if (mono.state === "idle") setPlayerOpen(false); }, [mono.state]);

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
    briefing,
    isLoading: briefingQuery.isLoading,
    saved,
    openPlayer: () => setPlayerOpen(true),
    detailSheetOpen,
    setDetailSheetOpen,
  };

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      <MiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} flush={detailSheetOpen} />
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
