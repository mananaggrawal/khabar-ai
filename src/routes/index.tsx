import { createFileRoute } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { VoiceOrb } from "@/components/VoiceOrb";

import { StoryCard }         from "@/components/StoryCard";
import { PlayerScreen }      from "@/components/PlayerScreen";
import { StoryDetailSheet }  from "@/components/StoryDetailSheet";
import { BottomNav }         from "@/components/BottomNav";
import { fetchBriefing }     from "@/lib/news/briefing.functions";
import { useMonologue }      from "@/hooks/useMonologue";
import { useSavedStories }   from "@/hooks/useSavedStories";
import { FEEDS, readCity, type SectionId } from "@/lib/news/sources";
import type { Story } from "@/lib/news/generator";

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Khabar AI" }] }),
  component: HomePage,
});

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
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 62px)" }}
          className="fixed inset-x-3 z-50"
        >
          <div
            className="relative overflow-hidden rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-xl cursor-pointer"
            onClick={onOpen}
          >
            {/* Progress bar */}
            <div
              className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300"
              style={{ width: `${progress * 100}%` }}
            />

            <div className="flex items-center gap-3 px-4 py-3">
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
      className="flex gap-1.5 overflow-x-auto px-4 py-2 scrollbar-hide"
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
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all whitespace-nowrap border ${
              active
                ? "border-primary/40 bg-primary/10 text-foreground"
                : hasContent
                ? "border-border text-foreground/70 hover:border-border/80 hover:bg-black/[0.02]"
                : "border-border/30 text-muted-foreground/30 cursor-not-allowed"
            }`}
          >
            {language === "hi" ? feed.labelHi : feed.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────

function HomePage() {
  const fn = useServerFn(fetchBriefing);
  const briefingQuery = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fn({ data: undefined as never }),
    staleTime: 5 * 60_000,
  });

  const briefing = briefingQuery.data ?? null;
  const mono = useMonologue({ briefing });
  const savedStories = useSavedStories();

  const [activeSection, setActiveSection] = useState<SectionId>("headlines");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [detailStory, setDetailStory] = useState<Story | null>(null);

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
      {/* Header — sticky so it stays visible while scrolling */}
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-5 pb-2 bg-background/95 backdrop-blur-sm"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <span className="text-xs text-muted-foreground">
          Today's news, <em className="font-semibold italic">spoken.</em>
        </span>
      </header>

      {/* Loading state */}
      {briefingQuery.isLoading && (
        <div className="flex flex-col flex-1 items-center justify-center gap-5">
          <VoiceOrb state="idle" size={160} />
          <div className="flex flex-col items-center gap-1">
            <span className="font-serif text-2xl tracking-tight">
              Khabar <em className="italic text-primary">AI</em>
            </span>
            <p className="text-xs text-muted-foreground animate-pulse">Loading briefing…</p>
          </div>
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


      {briefing && (
        <>
          {/* ── Hero card ── */}
          {(() => {
            const topStory = briefing.stories[0];
            const displayStory = mono.currentStory ?? topStory;
            const withAudio = briefing.stories.filter((s) =>
              mono.language === "hi" ? !!s.audioUrlHi : !!s.audioUrlEn,
            );
            const listenMins = Math.max(1, Math.round(withAudio.length * 1.5));
            const today = new Date().toLocaleDateString("en-IN", {
              weekday: "short", day: "numeric", month: "long",
            });
            const firstSection: SectionId = availableSections.has("headlines")
              ? "headlines"
              : ([...availableSections][0] as SectionId);
            const isPlayingAll = mono.state === "playing";
            const bgImage = displayStory?.imageUrl ?? topStory?.imageUrl;

            return (
              <div
                className="mx-4 mb-3 relative overflow-hidden rounded-2xl"
                style={{
                  height: 220,
                  background: bgImage
                    ? undefined
                    : "linear-gradient(135deg, oklch(0.18 0.05 295) 0%, oklch(0.28 0.14 300) 50%, oklch(0.20 0.10 310) 100%)",
                  ...(bgImage ? {
                    backgroundImage: `url(${bgImage})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  } : {}),
                }}
              >
                {/* Dark gradient overlay */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: "linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.88) 100%)",
                  }}
                />
                {/* Content */}
                <div className="absolute inset-0 flex flex-col justify-end p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/60 mb-1.5">
                    {today} · {listenMins} min listen
                  </p>
                  <p className="font-serif text-[17px] leading-snug text-white mb-3 line-clamp-2">
                    {displayStory?.title ?? "Today's Briefing"}
                  </p>
                  <button
                    onClick={() => isPlayingAll ? mono.pause() : mono.playSection(firstSection)}
                    className="self-start flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-foreground transition-transform active:scale-95 shadow-lg"
                  >
                    {isPlayingAll
                      ? <><Pause className="size-3 fill-current" />Pause</>
                      : <><Play className="size-3 fill-current ml-0.5" />Play briefing</>}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Section tabs */}
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/50">
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
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 148px)" }}
          >
            {/* Section play-all header */}
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
                    onTap={() => setDetailStory(story)}
                  />
                );
              })
            )}
          </div>
        </>
      )}

      {/* Bottom nav */}
      <BottomNav />

      {/* Mini player — sits above bottom nav */}
      <MiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} />

      {/* Full player screen */}
      <PlayerScreen
        mono={mono}
        visible={playerOpen}
        onClose={() => setPlayerOpen(false)}
        isSaved={mono.currentStory ? savedStories.isSaved(mono.currentStory.id) : false}
        onSave={() => mono.currentStory && savedStories.toggle(mono.currentStory)}
      />

      {/* Story detail sheet */}
      <StoryDetailSheet
        story={detailStory}
        language={mono.language}
        onClose={() => setDetailStory(null)}
        onPlay={() => {
          if (detailStory) {
            const idx = mono.storiesWithAudio.findIndex((s) => s.id === detailStory.id);
            if (idx >= 0) mono.playFromInSection(idx, detailStory.section);
          }
          setDetailStory(null);
        }}
        isPlaying={!!detailStory && mono.currentStory?.id === detailStory.id && mono.state === "playing"}
        isSaved={detailStory ? savedStories.isSaved(detailStory.id) : false}
        onSave={() => detailStory && savedStories.toggle(detailStory)}
      />
    </div>
  );
}
