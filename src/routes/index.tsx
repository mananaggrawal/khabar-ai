import { createFileRoute, redirect } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { VoiceOrb } from "@/components/VoiceOrb";

import { StoryCard } from "@/components/StoryCard";
import { PlayerScreen }      from "@/components/PlayerScreen";
import { StoryDetailSheet }  from "@/components/StoryDetailSheet";
import { BottomNav }         from "@/components/BottomNav";
import { fetchBriefing }     from "@/lib/news/briefing.functions";
import { useMonologue, getStoryTitle, getAudioUrl } from "@/hooks/useMonologue";
import { useSavedStories }   from "@/hooks/useSavedStories";
import { initAnalytics, identify, track } from "@/lib/analytics/track";
import { EVENTS } from "@/lib/analytics/events";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";
import type { Story } from "@/lib/news/generator";

// ── Route ─────────────────────────────────────────────────────────────────────

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

// Section display order + legacy mapping — shared by playback ordering and grouping
const SECTION_DISPLAY_ORDER: SectionId[] = ["headlines", "india", "world", "business", "local"];
const LEGACY_SECTION: Record<string, SectionId> = {
  politics: "india", sports: "india",
  techlife: "india", technology: "india", entertainment: "india", science: "india", health: "india",
};
function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (SECTION_DISPLAY_ORDER.includes(s as SectionId)) return s as SectionId;
  return "india";
}

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
  // Use meta duration if available, else estimate from word counts (~150 WPM)
  const listenMins = briefing.meta?.estimatedDurationSec
    ? Math.max(1, Math.round(briefing.meta.estimatedDurationSec / 60))
    : Math.max(1, Math.round(withAudio.reduce((n, s) => n + (s.wordCount ?? 115), 0) / 150));
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "long",
  });

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

          {/* Story count */}
          <div className="flex items-center gap-2.5">
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

  const rawBriefing = briefingQuery.data ?? null;

  // Order stories by section (stable, preserving importance within a section) so that
  // playback order matches the on-screen grouping instead of jumping around.
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
  const savedStories = useSavedStories();

  const [playerOpen, setPlayerOpen] = useState(false);
  const [detailStory, setDetailStory] = useState<Story | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId | null>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // True when the open detail drawer is showing the currently-playing story, so
  // it should follow along as autoplay advances. False when opened on another story.
  const detailFollowsRef = useRef(false);

  // Analytics: init PostHog, identify the user, log app open (once)
  useEffect(() => {
    initAnalytics();
    track(EVENTS.APP_OPEN);
    if (!LOCAL_MODE) {
      import("@/integrations/supabase/client")
        .then(({ supabase }) => supabase.auth.getUser())
        .then(({ data }) => { if (data?.user) identify(data.user.id); })
        .catch(() => {});
    }
  }, []);

  // Analytics: briefing loaded (once per briefing date)
  useEffect(() => {
    if (briefing?.stories?.length) {
      track(EVENTS.BRIEFING_LOADED, { date: briefing.date, stories: briefing.stories.length });
    }
  }, [briefing?.date]);

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

  // If the detail drawer is open ON the playing story, follow autoplay to the next
  useEffect(() => {
    if (detailFollowsRef.current && detailStory && mono.currentStory &&
        mono.currentStory.id !== detailStory.id) {
      setDetailStory(mono.currentStory);
    }
  }, [mono.currentStory, detailStory]);

  // Group stories by section in display order (helpers are module-scope)
  const storiesBySection = SECTION_DISPLAY_ORDER
    .map(sectionId => ({
      sectionId,
      feed: FEED_MAP.get(sectionId),
      stories: (briefing?.stories ?? []).filter(s => resolveSection(s.section) === sectionId),
    }))
    .filter(g => g.stories.length > 0);

  // Active section defaults to the first available section (no "All" view)
  const currentSection = activeSection ?? storiesBySection[0]?.sectionId ?? null;

  // Only the active section is shown
  const groupsToRender = storiesBySection.filter(g => g.sectionId === currentSection);

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

          {/* Section pills */}
          <div
            ref={pillsRef}
            className="flex gap-2 overflow-x-auto px-4 pb-3"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
          >
            {storiesBySection.map((g) => {
              const id       = g.sectionId;
              const label    = g.feed?.label ?? id;
              const isActive = currentSection === id;
              return (
                <button
                  key={id}
                  onClick={() => { setActiveSection(id); track(EVENTS.SECTION_VIEW, { section: id }); }}
                  className={`shrink-0 rounded-full border px-3.5 py-1 text-xs font-semibold transition-all whitespace-nowrap ${
                    isActive
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/60 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Story list — grouped by section, filtered by active pill */}
          <div
            className="flex-1 overflow-y-auto px-4 pb-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 148px)" }}
          >
            {groupsToRender.map(({ sectionId, feed, stories }) => {
              const label = feed?.label ?? sectionId;
              return (
                <section key={sectionId} className="mb-5">
                  {/* Section header */}
                  <div className="flex items-center gap-2 px-1 pt-2 pb-2">
                    <h2 className="truncate text-sm font-semibold text-foreground">{label}</h2>
                    <span className="text-[11px] text-muted-foreground">{stories.length}</span>
                  </div>

                  {/* Stories in this section */}
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
                          onTap={() => {
                            detailFollowsRef.current = mono.currentStory?.id === story.id;
                            setDetailStory(story);
                            track(EVENTS.DETAIL_OPEN, { storyId: story.id, section: story.section, source: "home" });
                          }}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
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
