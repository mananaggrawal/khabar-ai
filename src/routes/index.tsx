import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { VoiceOrb } from "@/components/VoiceOrb";

import { StoryCard } from "@/components/StoryCard";
import { StoryDetailSheet }  from "@/components/StoryDetailSheet";
import { BottomNav }         from "@/components/BottomNav";
import { InstallNudge }      from "@/components/InstallNudge";
import { getStoryTitle, getAudioUrl } from "@/hooks/useMonologue";
import { usePlayer }         from "@/context/player";
import { initAnalytics, identify, track } from "@/lib/analytics/track";
import { EVENTS } from "@/lib/analytics/events";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";
import type { Story } from "@/lib/news/generator";

// ── Route ─────────────────────────────────────────────────────────────────────

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

// Section display order + legacy mapping — shared by playback ordering and grouping
const SECTION_DISPLAY_ORDER: SectionId[] = ["headlines", "local", "india", "world", "business", "technology", "sports", "science", "health"];
const LEGACY_SECTION: Record<string, SectionId> = {
  politics: "india", techlife: "technology", entertainment: "india",
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
    // Capture a referral code from the link BEFORE any auth redirect can drop the
    // query string. Stored in localStorage so it survives the OAuth round-trip.
    if (typeof window !== "undefined") {
      try {
        const ref = new URLSearchParams(window.location.search).get("ref");
        if (ref) {
          localStorage.setItem("khabar-ref", ref);
          import("@/lib/analytics/track").then(({ track }) => track(EVENTS.REFERRAL_VISIT, { ref })).catch(() => {});
        }
      } catch {}
    }
    if (LOCAL_MODE) return;
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
  component: HomePage,
});

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard({
  briefing,
  mono,
}: {
  briefing: NonNullable<ReturnType<typeof usePlayer>["briefing"]>;
  mono: ReturnType<typeof usePlayer>["mono"];
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
      className="mx-4 mb-4 relative overflow-hidden rounded-3xl bg-cover bg-center"
      style={{
        height: 220,
        backgroundImage: "url(/hero-orb.jpg)",
        backgroundColor: "#07051c",
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
  // Player + briefing now live in the app-wide PlayerProvider so audio keeps
  // playing across tab changes.
  const { mono, briefing, isLoading, saved: savedStories } = usePlayer();

  const [detailStory, setDetailStory] = useState<Story | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // True when the open detail drawer is showing the currently-playing story, so
  // it should follow along as autoplay advances. False when opened on another story.
  const detailFollowsRef = useRef(false);

  // Stable per-card callbacks so StoryCard (memoized) doesn't re-render the whole
  // list on every section switch / save / playback tick.
  const currentIdRef = useRef<string | undefined>(undefined);
  currentIdRef.current = mono.currentStory?.id;
  const handlePlay = useCallback((story: Story) => {
    const idx = mono.storiesWithAudio.findIndex((s) => s.id === story.id);
    if (idx >= 0) mono.playFrom(idx);
  }, [mono.storiesWithAudio, mono.playFrom]);
  const handlePause = useCallback(() => { mono.pause(); }, [mono.pause]);
  const handleTap = useCallback((story: Story) => {
    detailFollowsRef.current = currentIdRef.current === story.id;
    setDetailStory(story);
  }, []);

  // Analytics: init PostHog, identify the user FIRST, then log app open so the
  // event carries the user id (avoids anonymous first events).
  useEffect(() => {
    initAnalytics();
    if (LOCAL_MODE) { track(EVENTS.APP_OPEN); return; }
    import("@/integrations/supabase/client")
      .then(({ supabase }) => supabase.auth.getUser())
      .then(({ data }) => {
        if (!data?.user) return;
        identify(data.user.id, { email: data.user.email ?? undefined });
        setUserId(data.user.id);
        // Attribute a referral once, on the first login carrying a stored code.
        try {
          const ref = localStorage.getItem("khabar-ref");
          const claimed = localStorage.getItem("khabar-ref-claimed");
          if (ref && !claimed && ref !== data.user.id) {
            const ageSec = (Date.now() - new Date(data.user.created_at).getTime()) / 1000;
            track(EVENTS.REFERRAL_SIGNUP, { ref, isNew: ageSec < 86400 });
            localStorage.setItem("khabar-ref-claimed", "1");
          }
          if (ref) localStorage.removeItem("khabar-ref");
        } catch {}
      })
      .catch(() => {})
      .finally(() => track(EVENTS.APP_OPEN));
  }, []);

  // Share / invite via the native share sheet, carrying the user's referral code.
  async function handleInvite() {
    const code = userId ?? "";
    const url = `${window.location.origin}/?ref=${code}`;
    const text = "I listen to my daily news on Khabar AI — it reads the day's top stories to me in a few minutes. Give it a try:";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Khabar AI", text, url });
      } else {
        await navigator.clipboard.writeText(url);
        alert("Link copied — share it with a friend!");
      }
      track(EVENTS.INVITE_SHARED);
    } catch { /* user cancelled the share sheet */ }
  }

  // If the detail drawer is open ON the playing story, follow autoplay to the next
  useEffect(() => {
    if (detailFollowsRef.current && detailStory && mono.currentStory &&
        mono.currentStory.id !== detailStory.id) {
      setDetailStory(mono.currentStory);
    }
  }, [mono.currentStory, detailStory]);

  // Group stories by section in display order (helpers are module-scope).
  // Excludes stories with no audio in the selected language (2026-07-05) — a
  // translation gap (rare now, but not impossible even with the retry added to
  // translateAll) previously left the story in the list anyway, showing an
  // English-titled, unplayable card mixed into an otherwise-Hindi list. This
  // matches the filter HeroCard and useMonologue's storiesWithAudio already
  // apply; the feed list was the one place still showing every story regardless.
  const storiesBySection = SECTION_DISPLAY_ORDER
    .map(sectionId => ({
      sectionId,
      feed: FEED_MAP.get(sectionId),
      stories: (briefing?.stories ?? [])
        .filter(s => resolveSection(s.section) === sectionId)
        .filter(s => !!getAudioUrl(s, mono.language)),
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
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Today's news, <em className="font-semibold italic">spoken.</em>
          </span>
          <button
            onClick={handleInvite}
            aria-label="Invite a friend"
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
          >
            <Share2 className="size-4" />
          </button>
        </div>
      </header>

      <InstallNudge variant="banner" />

      {/* Loading state */}
      {isLoading && (
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
      {!isLoading && !briefing && (
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
                  onClick={() => setActiveSection(id)}
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
                    {stories.map((story) => (
                      <StoryCard
                        key={story.id}
                        story={story}
                        language={mono.language}
                        isPlaying={mono.currentStory?.id === story.id && mono.state === "playing"}
                        hasAudio={!!getAudioUrl(story, mono.language)}
                        isCompleted={mono.completedIds.has(story.id)}
                        onPlay={handlePlay}
                        onPause={handlePause}
                        onTap={handleTap}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {/* Bottom nav */}
      <BottomNav />

      {/* Mini player + full player now render app-wide in PlayerProvider */}

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
