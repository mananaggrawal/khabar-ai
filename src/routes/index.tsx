import { createFileRoute, Link } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import { Settings, Play, Pause, SkipBack, SkipForward, ChevronRight, Sun, Moon } from "lucide-react";
import { VoiceOrb } from "@/components/VoiceOrb";

import { StoryCard }    from "@/components/StoryCard";
import { PlayerScreen } from "@/components/PlayerScreen";
import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue } from "@/hooks/useMonologue";
import { FEEDS, FEED_MAP, readCity, type SectionId } from "@/lib/news/sources";

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Khabar AI" }] }),
  component: HomePage,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function useTheme() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("khabar-theme");
    if (saved === "dark") { setIsDark(true); document.documentElement.classList.add("dark"); }
  }, []);
  return {
    isDark,
    toggle: () => {
      setIsDark((d) => {
        const next = !d;
        document.documentElement.classList.toggle("dark", next);
        try { localStorage.setItem("khabar-theme", next ? "dark" : "light"); } catch {}
        return next;
      });
    },
  };
}

// ── Mini Player (portal) ──────────────────────────────────────────────────────

function MiniPlayer({
  mono,
  onOpen,
}: {
  mono: ReturnType<typeof useMonologue>;
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
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
          className="fixed inset-x-3 z-50"
        >
          <div
            className="relative overflow-hidden rounded-2xl border border-white/[0.12] bg-background/95 backdrop-blur-md shadow-2xl cursor-pointer"
            onClick={onOpen}
          >
            {/* Progress bar */}
            <div
              className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300"
              style={{ width: `${progress * 100}%` }}
            />

            <div className="flex items-center gap-3 px-4 py-3">
              {/* Section emoji */}
              <span className="shrink-0 text-lg">
                {currentFeed?.emoji ?? "🎙️"}
              </span>

              {/* Story info */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentFeed ? (language === "hi" ? currentFeed.labelHi : currentFeed.label) : "Playing"}
                </p>
                <p className="truncate text-sm font-medium text-foreground leading-tight">
                  {currentStory?.title ?? "—"}
                </p>
              </div>

              {/* Controls */}
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => mono.prev()}
                  aria-label="Previous"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                >
                  <SkipBack className="size-4 fill-current" />
                </button>
                <button
                  onClick={isPlaying ? pause : resume}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  className="flex size-8 items-center justify-center rounded-full bg-primary text-white transition-transform active:scale-95"
                >
                  {isPlaying
                    ? <Pause className="size-4 fill-current" />
                    : <Play  className="size-4 fill-current ml-0.5" />}
                </button>
                <button
                  onClick={() => mono.next()}
                  aria-label="Next"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                >
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

// ── Section Tab Bar ───────────────────────────────────────────────────────────

function SectionTabs({
  activeSection,
  availableSections,
  onSelect,
  language,
}: {
  activeSection: SectionId;
  availableSections: Set<SectionId>;
  onSelect: (id: SectionId) => void;
  language: "en" | "hi";
}) {
  const tabsRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view
  useEffect(() => {
    const el = tabsRef.current?.querySelector(`[data-section="${activeSection}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [activeSection]);

  return (
    <div
      ref={tabsRef}
      className="flex gap-1 overflow-x-auto px-4 py-2 scrollbar-hide"
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      {FEEDS.map((feed) => {
        const hasContent = availableSections.has(feed.id);
        const active = activeSection === feed.id;
        return (
          <button
            key={feed.id}
            data-section={feed.id}
            onClick={() => hasContent && onSelect(feed.id)}
            disabled={!hasContent}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
              active
                ? "bg-primary text-white"
                : hasContent
                ? "bg-white/[0.06] text-foreground/80 hover:bg-white/[0.10]"
                : "bg-white/[0.02] text-muted-foreground/30 cursor-not-allowed"
            }`}
          >
            {feed.emoji} {language === "hi" ? feed.labelHi : feed.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────

function HomePage() {
  const { isDark, toggle } = useTheme();
  const fn = useServerFn(fetchBriefing);
  const briefingQuery = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fn({ data: undefined as never }),
    staleTime: 5 * 60_000,
  });

  const briefing = briefingQuery.data ?? null;
  const mono = useMonologue({ briefing });

  const [activeSection, setActiveSection] = useState<SectionId>("headlines");
  const [playerOpen, setPlayerOpen] = useState(false);

  // City for local section label
  const city = typeof window !== "undefined" ? readCity() : "Mumbai";

  // Which sections actually have stories
  const availableSections = new Set(
    (briefing?.stories ?? []).map((s) => s.section),
  );

  // Auto-select first available section
  useEffect(() => {
    if (availableSections.size > 0 && !availableSections.has(activeSection)) {
      setActiveSection([...availableSections][0]);
    }
  }, [briefing]);

  // Stories for the active tab
  const activeStories = (briefing?.stories ?? []).filter(
    (s) => s.section === activeSection,
  );

  // Close player when playback stops
  useEffect(() => {
    if (mono.state === "idle") setPlayerOpen(false);
  }, [mono.state]);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-5 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">Khabar <em className="italic text-primary">AI</em></span>
        <div className="flex items-center gap-1">
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <Link
            to="/settings"
            aria-label="Settings"
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </header>

      {/* Loading state */}
      {briefingQuery.isLoading && (
        <div className="flex flex-col flex-1 items-center justify-center gap-4">
          <VoiceOrb state="idle" size={160} />
          <p className="text-sm text-muted-foreground animate-pulse">Loading briefing…</p>
        </div>
      )}

      {/* No briefing */}
      {!briefingQuery.isLoading && !briefing && (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <p className="text-foreground/80 font-medium">No briefing yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate one from the{" "}
              <a href="/admin" className="text-primary underline">admin panel</a>.
            </p>
          </div>
        </div>
      )}

      {/* Orb — always visible, reflects play state */}
      {!briefingQuery.isLoading && (
        <div className="flex flex-col items-center pt-2 pb-1">
          <VoiceOrb
            state={
              mono.state === "playing" ? "speaking" :
              mono.state === "paused"  ? "listening" : "idle"
            }
            size={160}
            onClick={mono.orbTap}
          />
          <div className="mt-1 min-h-[2.5rem] flex flex-col items-center gap-0.5 px-6 text-center">
            {mono.currentStory ? (
              <>
                <p className="font-serif text-base leading-snug tracking-tight line-clamp-2">
                  {mono.currentStory.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {mono.currentFeed ? (mono.language === "hi" ? mono.currentFeed.labelHi : mono.currentFeed.label) : ""}
                  {" · "}
                  {mono.currentStoryIdx + 1} of {mono.storiesWithAudio.length}
                </p>
              </>
            ) : (
              <p className="font-serif text-2xl tracking-tight">
                {briefingQuery.isError ? "Couldn't load briefing." : !briefing ? "No briefing yet" : "Khabar AI"}
              </p>
            )}
          </div>
        </div>
      )}

      {briefing && (
        <>
          {/* Section tabs */}
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-white/[0.05]">
            <SectionTabs
              activeSection={activeSection}
              availableSections={availableSections}
              onSelect={setActiveSection}
              language={mono.language}
            />
          </div>

          {/* Story list */}
          <div
            className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)" }}
          >
            {/* Section play-all button */}
            {activeStories.some((s) =>
              mono.language === "hi" ? !!s.audioUrlHi : !!s.audioUrlEn,
            ) && (
              <div className="flex items-center justify-between px-1 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                  {mono.language === "hi" ? "खबरें" : "Stories"}
                  {" · "}
                  {activeStories.filter((s) =>
                    mono.language === "hi" ? !!s.audioUrlHi : !!s.audioUrlEn,
                  ).length}
                </p>
                <button
                  onClick={() => {
                    if (mono.state === "playing" && mono.currentStory?.section === activeSection) {
                      mono.pause();
                    } else {
                      mono.playSection(activeSection);
                    }
                  }}
                  className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
                >
                  {mono.state === "playing" && mono.currentStory?.section === activeSection
                    ? <><Pause className="size-3.5 fill-current" />{mono.language === "hi" ? "रोकें" : "Pause all"}</>
                    : <><Play  className="size-3.5 fill-current ml-0.5" />{mono.language === "hi" ? "सभी सुनें" : "Play all"}</>}
                </button>
              </div>
            )}

            {activeStories.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No stories in this section yet.
              </p>
            ) : (
              activeStories.map((story) => {
                const hasAudio = mono.language === "hi" ? !!story.audioUrlHi : !!story.audioUrlEn;
                const storyIdx = mono.storiesWithAudio.findIndex((s) => s.id === story.id);
                const isActive = mono.currentStory?.id === story.id;
                return (
                  <StoryCard
                    key={story.id}
                    story={story}
                    isPlaying={isActive && mono.state === "playing"}
                    hasAudio={hasAudio}
                    onPlay={() => storyIdx >= 0 && mono.playFromInSection(storyIdx, activeSection)}
                    onPause={mono.pause}
                  />
                );
              })
            )}
          </div>
        </>
      )}

      {/* Mini player */}
      <MiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} />

      {/* Full player screen */}
      <PlayerScreen
        mono={mono}
        visible={playerOpen}
        onClose={() => setPlayerOpen(false)}
      />
    </div>
  );
}
