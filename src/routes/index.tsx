import { createFileRoute, redirect } from "@tanstack/react-router";
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
import { useMonologue, getStoryTitle, getAudioUrl } from "@/hooks/useMonologue";
import { useSavedStories }   from "@/hooks/useSavedStories";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";
import type { Story } from "@/lib/news/generator";

// ── Route ─────────────────────────────────────────────────────────────────────

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Khabar AI" }] }),
  ssr: false,
  beforeLoad: async () => {
    if (LOCAL_MODE) return;
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
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
                  {currentStory ? getStoryTitle(currentStory, language) : "—"}
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

// ── Section Divider ───────────────────────────────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-2 pb-1">
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground/60">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard({
  briefing,
  mono,
}: {
  briefing: NonNullable<Awaited<ReturnType<typeof fetchBriefing>>>;
  mono: ReturnType<typeof useMonologue>;
}) {
  const displayStory = mono.currentStory ?? briefing.stories[0];

  const withAudio = briefing.stories.filter((s) => !!getAudioUrl(s, mono.language));
  const listenMins = Math.max(1, Math.round(withAudio.length * 1.5));
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "long",
  });

  const isPlaying = mono.state === "playing";

  return (
    <div
      className="mx-4 mb-4 relative overflow-hidden rounded-3xl"
      style={{
        height: 220,
        background: [
          "radial-gradient(ellipse 65% 80% at 72% 60%, rgba(148,55,255,0.92) 0%, rgba(100,35,210,0.70) 28%, rgba(55,15,140,0.35) 55%, transparent 75%)",
          "radial-gradient(circle at 58% 38%, rgba(210,165,255,0.40) 0%, transparent 32%)",
          "radial-gradient(ellipse at 20% 80%, rgba(18,10,70,0.75) 0%, transparent 55%)",
          "linear-gradient(160deg, #03030d 0%, #060518 45%, #07051c 100%)",
        ].join(", "),
      }}
    >
      {/* Overlay */}
      <div
        className="absolute inset-0"
        style={{
          background: "linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.80) 100%)",
        }}
      />

      {/* Content */}
      <div className="absolute inset-0 flex flex-col justify-between p-4 pt-3.5">

        {/* Top row: date + duration */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-white/50">
            {today}
          </span>
          <span className="text-[10px] font-medium text-white/40">
            {listenMins} min listen
          </span>
        </div>

        {/* Bottom section */}
        <div className="flex flex-col gap-2.5">
          {/* Story title */}
          <p className="font-serif text-[17px] leading-snug text-white line-clamp-2">
            {displayStory ? getStoryTitle(displayStory, mono.language) : "Today's Briefing"}
          </p>

          {/* Play button + story count */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => isPlaying ? mono.pause() : mono.playAll()}
              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold text-foreground transition-transform active:scale-95"
              style={{
                background: "rgba(255,255,255,0.92)",
                boxShadow: "0 2px 12px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.1)",
              }}
            >
              {isPlaying ? (
                <><Pause className="size-3 fill-current" />Pause</>
              ) : (
                <><Play className="size-3 fill-current ml-0.5" />Play briefing</>
              )}
            </button>
            <span className="text-[11px] text-white/45 font-medium">
              {briefing.stories.length} stories
            </span>
          </div>
        </div>
      </div>
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

  const [playerOpen, setPlayerOpen] = useState(false);
  const [detailStory, setDetailStory] = useState<Story | null>(null);

  // Persist which languages are available in this briefing to localStorage
  useEffect(() => {
    if (!briefing?.stories?.length) return;
    const langs = ["en", "hi", "ta", "mr"].filter(lang =>
      briefing.stories.some(s => {
        if (lang === "en") return !!s.audioUrlEn;
        if (lang === "hi") return !!s.audioUrlHi;
        if (lang === "ta") return !!(s as any).audioUrlTa;
        if (lang === "mr") return !!(s as any).audioUrlMr;
        return false;
      })
    );
    try { localStorage.setItem("khabar-available-languages", JSON.stringify(langs)); } catch {}
  }, [briefing]);

  // Close player when playback stops
  useEffect(() => {
    if (mono.state === "idle") setPlayerOpen(false);
  }, [mono.state]);

  // Group stories by section in display order
  const SECTION_DISPLAY_ORDER: SectionId[] = [
    "headlines", "india", "world", "business", "technology",
    "sports", "health", "entertainment", "science", "local",
  ];
  const storiesBySection = SECTION_DISPLAY_ORDER
    .map(sectionId => ({
      sectionId,
      feed: FEED_MAP.get(sectionId),
      stories: (briefing?.stories ?? []).filter(s => s.section === sectionId),
    }))
    .filter(g => g.stories.length > 0);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-5 pb-3 bg-background/95 backdrop-blur-sm"
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
        <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-background">
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
            <p className="text-foreground/80 font-medium">Today's briefing is being prepared</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Check back shortly — your news is on its way.
            </p>
          </div>
        </div>
      )}

      {briefing && (
        <>
          {/* Hero card */}
          <HeroCard briefing={briefing} mono={mono} />

          {/* Flat story list with inline section dividers */}
          <div
            className="flex-1 overflow-y-auto px-4 pb-4 space-y-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 148px)" }}
          >
            {storiesBySection.map(({ sectionId, feed, stories }) => (
              <div key={sectionId}>
                <SectionDivider
                  label={`${feed?.emoji ?? ""} ${mono.language === "hi" ? (feed?.labelHi ?? sectionId) : (feed?.label ?? sectionId)}`}
                />
                <div className="space-y-2">
                  {stories.map((story) => {
                    const hasAudio = !!getAudioUrl(story, mono.language);
                    const storyIdx = mono.storiesWithAudio.findIndex((s) => s.id === story.id);
                    const isActive = mono.currentStory?.id === story.id;
                    return (
                      <StoryCard
                        key={story.id}
                        story={story}
                        language={mono.language}
                        isPlaying={isActive && mono.state === "playing"}
                        hasAudio={hasAudio}
                        onPlay={() => storyIdx >= 0 && mono.playFrom(storyIdx)}
                        onPause={mono.pause}
                        onTap={() => setDetailStory(story)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
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
