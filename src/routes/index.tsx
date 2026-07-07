import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Share2, RotateCw } from "lucide-react";
import { VoiceOrb } from "@/components/VoiceOrb";

import { StoryCard } from "@/components/StoryCard";
import { StoryDetailSheet }  from "@/components/StoryDetailSheet";
import { BottomNav }         from "@/components/BottomNav";
import { InstallNudge }      from "@/components/InstallNudge";
import { NotificationNudge } from "@/components/NotificationNudge";
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

// Shown while beforeLoad's async supabase.auth.getUser() check is in flight
// (2026-07-06) — most visible right after the Google OAuth redirect lands
// back on "/", where that check also has to wait for supabase-js to finish
// parsing the #access_token=... hash before it can resolve. Without this,
// TanStack Router renders nothing in the outlet for however long that takes,
// which is exactly the "blank screen after logging in" users reported.
function AuthCheckingScreen() {
  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-background">
      <VoiceOrb state="idle" size={160} />
      <div className="flex flex-col items-center gap-1">
        <span className="font-serif text-2xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <p className="text-xs text-muted-foreground animate-pulse">Signing you in…</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Khabar AI" }] }),
  ssr: false,
  pendingComponent: AuthCheckingScreen,
  pendingMs: 200,
  pendingMinMs: 300,
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
    // getSession() reads the persisted session from local storage (fast, no
    // network round trip needed unless the token is actually expired) —
    // switched from getUser() (2026-07-06), which always calls out to the
    // Supabase Auth server to revalidate. That network dependency is exactly
    // the kind of thing that can hang on a freshly-installed PWA's very first
    // cold start (new storage/network context, install often coincides with
    // a network transition), leaving beforeLoad stuck and the screen blank
    // until force-quit — reported repeatedly as "dark screen after install."
    // Belt-and-suspenders: also hard-cap the check at 8s so a genuine hang
    // can never block the app forever — falls through to /auth instead,
    // which is a much better failure mode than an indefinite blank screen.
    const timeout = new Promise<{ hasSession: false }>((resolve) =>
      setTimeout(() => resolve({ hasSession: false }), 8000),
    );
    const check = supabase.auth.getSession().then(({ data, error }) => ({
      hasSession: !error && !!data.session,
    }));
    const { hasSession } = await Promise.race([check, timeout]);
    if (!hasSession) throw redirect({ to: "/auth" });
  },
  component: HomePage,
});

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard({
  stories,
  estimatedDurationSec,
  mono,
}: {
  // Whichever list is actually queued right now — the full day's briefing in
  // Full mode, or the curated 15-story batch in Quick mode (2026-07-06) — so
  // the hero's story count / listen time always matches what Play queues up.
  stories: Story[];
  estimatedDurationSec?: number;
  mono: ReturnType<typeof usePlayer>["mono"];
}) {
  const displayStory = mono.currentStory ?? stories[0];

  const withAudio = stories.filter((s) => !!getAudioUrl(s, mono.language));
  // Use meta duration if available, else estimate from word counts (~150 WPM)
  const listenMins = estimatedDurationSec
    ? Math.max(1, Math.round(estimatedDurationSec / 60))
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
              {stories.length} stories
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────

// Pinned pill id for the Quick 15 section, alongside real SectionIds.
const QUICK_PILL = "quick15" as const;
type PillId = SectionId | typeof QUICK_PILL;

function HomePage() {
  // Player + briefing now live in the app-wide PlayerProvider so audio keeps
  // playing across tab changes. Quick 15 (2026-07-07) is now a permanent
  // pinned pill/section on Home, not a Settings-driven global mode — it
  // coexists with the real topic sections rather than replacing them.
  const { mono, briefing, isLoading, saved: savedStories, quickBatch, quickActive, playFromQuick, playFromFull, canRefreshQuick, refreshQuickBatch } = usePlayer();

  const [detailStory, setDetailStory] = useState<Story | null>(null);
  // Which list a tapped-into detail story came from — needed so its Play
  // button in the sheet resumes into the right queue (Quick batch vs. the
  // real section it belongs to).
  const [detailSource, setDetailSource] = useState<"quick" | "full">("full");
  const [activeSection, setActiveSection] = useState<PillId | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // True when the open detail drawer is showing the currently-playing story, so
  // it should follow along as autoplay advances. False when opened on another story.
  const detailFollowsRef = useRef(false);

  // Stable per-card callbacks so StoryCard (memoized) doesn't re-render the whole
  // list on every section switch / save / playback tick.
  const currentIdRef = useRef<string | undefined>(undefined);
  currentIdRef.current = mono.currentStory?.id;

  // Full-section list, independent of whether Quick 15 is the one actually
  // playing right now (mono.storiesWithAudio tracks whichever queue is bound
  // to `mono`, which may be the Quick batch — this always reflects the real
  // day's briefing, matching useMonologue's own audio filter exactly).
  const fullStoriesWithAudio = (briefing?.stories ?? []).filter((s) => !!getAudioUrl(s, mono.language));

  // Plain list card Play button — unscoped "all" auto-advance, matching the
  // pre-Quick-15 behavior of the full story list.
  const handlePlayFull = useCallback((story: Story) => {
    const idx = fullStoriesWithAudio.findIndex((s) => s.id === story.id);
    if (idx >= 0) playFromFull(idx);
  }, [fullStoriesWithAudio, playFromFull]);
  // Detail sheet Play — section-scoped auto-advance, matching the prior
  // mono.playFromInSection(idx, detailStory.section) behavior.
  const handlePlayFullInSection = useCallback((story: Story) => {
    const idx = fullStoriesWithAudio.findIndex((s) => s.id === story.id);
    if (idx >= 0) playFromFull(idx, resolveSection(story.section));
  }, [fullStoriesWithAudio, playFromFull]);
  const handlePlayQuick = useCallback((story: Story) => {
    const idx = (quickBatch ?? []).findIndex((s) => s.id === story.id);
    if (idx >= 0) playFromQuick(idx);
  }, [quickBatch, playFromQuick]);
  const handlePause = useCallback(() => { mono.pause(); }, [mono.pause]);
  const handleTapFull = useCallback((story: Story) => {
    detailFollowsRef.current = currentIdRef.current === story.id;
    setDetailSource("full");
    setDetailStory(story);
  }, []);
  const handleTapQuick = useCallback((story: Story) => {
    detailFollowsRef.current = currentIdRef.current === story.id;
    setDetailSource("quick");
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

  // Active pill defaults to Quick 15 (pinned first) when it has content,
  // otherwise the first real section (no "All" view).
  const currentSection: PillId | null =
    activeSection ?? (quickBatch && quickBatch.length > 0 ? QUICK_PILL : storiesBySection[0]?.sectionId ?? null);
  const isQuickPillActive = currentSection === QUICK_PILL;

  // Only the active section is shown (irrelevant when the Quick 15 pill is active)
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
      <NotificationNudge />

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
          {/* Hero card — always reflects the full day's briefing now that
              Quick 15 is a coexisting section rather than a global mode. */}
          <HeroCard
            stories={briefing.stories}
            estimatedDurationSec={briefing.meta?.estimatedDurationSec}
            mono={mono}
          />

          {/* Section pills — Quick 15 pinned first, then real topic sections */}
          <div
            ref={pillsRef}
            className="flex gap-2 overflow-x-auto px-4 pb-3"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
          >
            {quickBatch && quickBatch.length > 0 && (
              <button
                onClick={() => setActiveSection(QUICK_PILL)}
                className={`shrink-0 rounded-full border px-3.5 py-1 text-xs font-semibold transition-all whitespace-nowrap ${
                  isQuickPillActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                Quick 15
              </button>
            )}
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

          {/* Story list — Quick 15: one flat curated cross-section list, read
              from `quickBatch` directly (NOT mono.storiesWithAudio, which
              tracks whichever queue is actually bound to playback and may be
              the full briefing even while viewing this pill). Real sections:
              grouped by section, filtered by the active pill, as before. */}
          <div
            className="flex-1 overflow-y-auto px-4 pb-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 148px)" }}
          >
            {isQuickPillActive ? (
              <section className="mb-5">
                <div className="flex items-center gap-2 px-1 pt-2 pb-2">
                  <h2 className="truncate text-sm font-semibold text-foreground">Quick 15</h2>
                  <span className="text-[11px] text-muted-foreground">{quickBatch?.length ?? 0}</span>
                  {/* Refreshes only the already-heard/skipped slots — whatever's
                      currently playing (or not yet reached) is untouched
                      (2026-07-06). Hidden once nothing's been consumed yet in
                      this batch, since there'd be nothing to swap out. */}
                  {canRefreshQuick && (
                    <button
                      onClick={refreshQuickBatch}
                      aria-label="Refresh Quick 15"
                      className="ml-auto flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
                    >
                      <RotateCw className="size-3" />
                      Refresh
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {(quickBatch ?? []).map((story) => (
                    <StoryCard
                      key={story.id}
                      story={story}
                      language={mono.language}
                      isPlaying={quickActive && mono.currentStory?.id === story.id && mono.state === "playing"}
                      hasAudio={!!getAudioUrl(story, mono.language)}
                      isCompleted={mono.completedIds.has(story.id)}
                      onPlay={handlePlayQuick}
                      onPause={handlePause}
                      onTap={handleTapQuick}
                      quickPick
                    />
                  ))}
                </div>
              </section>
            ) : groupsToRender.map(({ sectionId, feed, stories }) => {
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
                        isPlaying={!quickActive && mono.currentStory?.id === story.id && mono.state === "playing"}
                        hasAudio={!!getAudioUrl(story, mono.language)}
                        isCompleted={mono.completedIds.has(story.id)}
                        onPlay={handlePlayFull}
                        onPause={handlePause}
                        onTap={handleTapFull}
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
            if (detailSource === "quick") {
              handlePlayQuick(detailStory);
            } else {
              handlePlayFullInSection(detailStory);
            }
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
