import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "motion/react";
import {
  Settings, AlertTriangle,
  SkipBack, SkipForward, Pause, Play, ChevronDown,
  RotateCcw, RotateCw, Sun, Moon,
} from "lucide-react";

import { VoiceOrb } from "@/components/VoiceOrb";
import { BriefingList } from "@/components/BriefingList";
import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue } from "@/hooks/useMonologue";
import type { BriefingSection, BriefingTopic } from "@/lib/news/generator";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

function useTheme() {
  const [isDark, setIsDark] = useState(false); // light is default

  useEffect(() => {
    const saved = localStorage.getItem("khabar-theme");
    const dark = saved === "dark"; // dark only if explicitly chosen
    setIsDark(dark);
    document.documentElement.classList.toggle("light", !dark);
  }, []);

  const toggle = () => {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("light", !next);
      localStorage.setItem("khabar-theme", next ? "dark" : "light");
      return next;
    });
  };

  return { isDark, toggle };
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Khabar AI — Today's news, spoken." },
      { name: "description", content: "Your daily AI news briefing, spoken aloud." },
    ],
  }),
  component: Home,
});

function Home() {
  const [authReady, setAuthReady] = useState(LOCAL_MODE);
  const [signedIn, setSignedIn] = useState(LOCAL_MODE);

  useEffect(() => {
    if (LOCAL_MODE) return;
    import("@/integrations/supabase/client").then(({ supabase }) => {
      supabase.auth.getSession().then(({ data }) => {
        setSignedIn(!!data.session);
        setAuthReady(true);
        if (!data.session) window.location.href = "/auth";
      });
      supabase.auth.onAuthStateChange((_e, s) => {
        setSignedIn(!!s);
        if (!s) window.location.href = "/auth";
      });
    });
  }, []);

  if (!authReady || !signedIn) {
    return (
      <FullScreenCanvas>
        <div className="flex flex-1 items-center justify-center">
          <VoiceOrb state="idle" size={220} />
        </div>
      </FullScreenCanvas>
    );
  }
  return (
    <FullScreenCanvas>
      <BriefingSurface />
    </FullScreenCanvas>
  );
}

function FullScreenCanvas({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "var(--bg-gradient)" }}
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl flex-col">
        {children}
      </div>
    </div>
  );
}

function BriefingSurface() {
  const { isDark, toggle: toggleTheme } = useTheme();
  const fetchFn = useServerFn(fetchBriefing);
  const briefingQuery = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fetchFn({ data: undefined as never }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const briefing = briefingQuery.data ?? null;
  const mono = useMonologue({ briefing });

  // Keyboard shortcuts: ←/→ = ±10s, Space = pause/resume
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight") { e.preventDefault(); mono.seekForward(10); }
      if (e.key === "ArrowLeft")  { e.preventDefault(); mono.seekBackward(10); }
      if (e.key === " ") {
        e.preventDefault();
        if (mono.state === "playing") mono.pause();
        else if (mono.state === "paused") mono.resume();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mono.state, mono.seekForward, mono.seekBackward, mono.pause, mono.resume]);


  const briefingDate = briefing?.date ?? "";
  const isToday = briefingDate === new Date().toISOString().slice(0, 10);

  const dateLabel = useMemo(() => {
    if (!briefingDate) return new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    return new Date(briefingDate + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }, [briefingDate]);

  const hasSections = (briefing?.sections?.length ?? 0) > 0;
  const hasAudio = briefing?.sections?.some((s) => s.audioUrl) ?? false;
  const totalTopics = briefing?.sections?.reduce((n, s) => n + s.topics.length, 0) ?? 0;

  const orbState = (() => {
    if (briefingQuery.isLoading) return "idle" as const;
    if (mono.state === "playing") return "speaking" as const;
    if (mono.state === "listening" || mono.state === "answering") return "listening" as const;
    if (mono.state === "paused") return "listening" as const;
    return "idle" as const;
  })();

  // Current playing info
  const nowPlayingSection = mono.currentSection;
  const nowPlayingTopic   = mono.currentTopic;
  const hasPrev = mono.currentTopicIdx > 0 || (mono.currentTopicIdx === 0 && mono.progress > 0.05);
  const hasNext = mono.currentTopicIdx >= 0 && mono.currentTopicIdx < mono.topicsWithAudio.length - 1;

  return (
    <>
      <TopBar isDark={isDark} onToggleTheme={toggleTheme} />
      <main className={`flex flex-1 flex-col items-center px-4 transition-[padding] duration-300 ${(mono.state === "playing" || mono.state === "paused") ? "pb-44" : "pb-10"}`}>

        {/* Date + stale badge */}
        <div className="mt-2 flex flex-col items-center gap-1">
          <p className="text-center text-xs uppercase tracking-[0.25em] text-muted-foreground">{dateLabel}</p>
          {briefing && !isToday && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-0.5 text-[10px] uppercase tracking-widest text-amber-400/80">
              Showing previous briefing
            </span>
          )}
        </div>

        {/* Orb */}
        <VoiceOrb state={orbState} size={200} onClick={mono.orbTap} />

        {/* App title / now-playing label */}
        <div className="flex min-h-[2.5rem] flex-col items-center gap-0.5 text-center px-6">
          {nowPlayingTopic ? (
            <>
              <p className="font-serif text-base leading-snug tracking-tight line-clamp-2">{nowPlayingTopic.headline}</p>
              <p className="text-xs text-muted-foreground">
                {nowPlayingSection?.label} · {mono.currentTopicIdx + 1} of {mono.topicsWithAudio.length}
              </p>
            </>
          ) : (
            <>
              <p className="font-serif text-2xl tracking-tight">
                {mono.state === "listening" ? "Listening…" : mono.state === "answering" ? "Answering…" : "Khabar AI"}
              </p>
              {briefingQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {briefingQuery.isError && <p className="text-sm text-muted-foreground">Couldn't load briefing.</p>}
              {!briefingQuery.isLoading && !briefingQuery.isError && hasSections && (
                <p className="text-sm text-muted-foreground">{totalTopics} stories · {briefing!.sections.length} sections</p>
              )}
            </>
          )}
          {mono.state === "listening" && mono.transcript && (
            <p className="mt-1 text-xs italic text-muted-foreground">"{mono.transcript}"</p>
          )}
          {mono.state === "error" && mono.error && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-400/90">
              <AlertTriangle className="size-3.5" />{mono.error}
            </div>
          )}
        </div>

        {/* Idle hint */}
        {mono.state === "idle" && !briefingQuery.isLoading && hasAudio && (
          <p className="mt-3 text-center text-sm text-muted-foreground">
            Tap the orb to start listening
          </p>
        )}

        {/* ── Section playlist ──────────────────────────────────────────── */}
        {hasSections && (
          <div className="mt-8 w-full max-w-2xl space-y-4">
            <SectionGroup
              group="india"
              title="🇮🇳 India"
              sections={briefing!.sections.filter((s) => s.group === "india")}
              mono={mono}
              allSections={mono.sectionsWithAudio}
            />
            <SectionGroup
              group="global"
              title="🌍 Global"
              sections={briefing!.sections.filter((s) => s.group === "global")}
              mono={mono}
              allSections={mono.sectionsWithAudio}
            />
          </div>
        )}

      </main>

      <PlayerCard
        state={mono.state === "playing" || mono.state === "paused" ? mono.state : "idle"}
        nowPlayingTopic={nowPlayingTopic}
        nowPlayingSection={nowPlayingSection}
        progress={mono.progress}
        duration={mono.duration}
        hasPrev={hasPrev}
        hasNext={hasNext}
        currentTopicIdx={mono.currentTopicIdx}
        totalTopics={mono.topicsWithAudio.length}
        onPause={mono.pause}
        onResume={mono.resume}
        onPrev={mono.prevSection}
        onNext={mono.nextSection}
        onSeek={mono.seek}
        onSeekBackward={mono.seekBackward}
        onSeekForward={mono.seekForward}
      />
    </>
  );
}

// ── Section group (bordered container with nested rows) ───────────────────────

function SectionGroup({
  group,
  title,
  sections,
  mono,
  allSections,
}: {
  group: "india" | "global";
  title: string;
  sections: BriefingSection[];
  mono: ReturnType<typeof useMonologue>;
  allSections: ReturnType<typeof useMonologue>["sectionsWithAudio"];
}) {
  if (sections.length === 0) return null;
  const anyAudio = sections.some((s) => s.audioUrl);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
      {/* Group header */}
      <div className="flex items-center justify-between px-4 py-3.5">
        <span className="font-serif text-base text-foreground/90">{title}</span>
        {anyAudio && null /* group-level play removed — use per-row or orb */}
      </div>

      {/* Section rows */}
      {sections.map((section, i) => {
        const sectionIdx = allSections.findIndex((s) => s.category === section.category);
        const isActiveSection = mono.currentSection?.category === section.category;
        const isPlaying = isActiveSection && mono.state === "playing";
        const isPaused  = isActiveSection && mono.state === "paused";
        const hasAudio  = section.topics.some((t) =>
          mono.language === "hi" ? !!t.audioUrlHi : !!t.audioUrlEn,
        );
        return (
          <SectionRow
            key={section.category}
            section={section}
            isPlaying={isPlaying}
            isPaused={isPaused}
            hasAudio={hasAudio}
            currentTopicId={isActiveSection ? mono.currentTopic?.id : undefined}
            playingState={isActiveSection ? mono.state as "playing" | "paused" | "idle" : "idle"}
            onPlay={() => sectionIdx >= 0 ? mono.playSection(sectionIdx) : undefined}
            onPause={mono.pause}
            onPlayTopic={(topicId) => {
              const idx = mono.topicsWithAudio.findIndex((t) => t.id === topicId);
              if (idx >= 0) mono.playFrom(idx);
            }}
            progress={isPlaying || isPaused ? mono.progress : 0}
            showDivider={i > 0}
          />
        );
      })}
    </div>
  );
}

// ── Section row (playlist track) ─────────────────────────────────────────────

function SectionRow({
  section,
  isPlaying,
  isPaused,
  hasAudio,
  currentTopicId,
  playingState,
  onPlay,
  onPause,
  onPlayTopic,
  progress,
  showDivider,
}: {
  section: BriefingSection;
  isPlaying: boolean;
  isPaused: boolean;
  hasAudio: boolean;
  currentTopicId?: string;
  playingState?: "playing" | "paused" | "idle";
  onPlay: () => void;
  onPause: () => void;
  onPlayTopic: (topicId: string) => void;
  progress: number;
  showDivider: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = isPlaying || isPaused;

  return (
    <div className={`transition-colors ${active ? "bg-primary/[0.07]" : ""}`}>
      {showDivider && <div className="mx-4 h-px bg-white/[0.05]" />}

      <div
        role="button" tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left outline-none"
      >
        {/* Section name */}
        <div className="flex-1 min-w-0">
          <p className={`flex items-center gap-2 text-sm ${active ? "font-medium text-foreground" : "text-foreground/80"}`}>
            {section.label}
            {isPlaying && <WaveformIcon />}
          </p>
          <p className="text-xs text-muted-foreground">
            {section.topics.length} {section.topics.length === 1 ? "story" : "stories"}
            {!hasAudio && " · no audio"}
          </p>
        </div>

        {/* Expand chevron */}
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </div>

      {/* Expanded stories */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="pb-3 pt-1">
              <BriefingList
                topics={section.topics}
                currentTopicId={currentTopicId}
                playingState={playingState ?? "idle"}
                progress={progress}
                onPlay={hasAudio ? onPlayTopic : undefined}
                onPause={onPause}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Floating player card ──────────────────────────────────────────────────────

function PlayerCard({
  state, nowPlayingTopic, nowPlayingSection,
  progress, duration, hasPrev, hasNext, currentTopicIdx, totalTopics,
  onPause, onResume, onPrev, onNext, onSeek, onSeekBackward, onSeekForward,
}: {
  state: "playing" | "paused" | "idle";
  nowPlayingTopic?: BriefingTopic | null;
  nowPlayingSection?: BriefingSection | null;
  progress: number;
  duration: number;
  hasPrev: boolean;
  hasNext: boolean;
  currentTopicIdx: number;
  totalTopics: number;
  onPause: () => void;
  onResume: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (f: number) => void;
  onSeekBackward: (s: number) => void;
  onSeekForward: (s: number) => void;
}) {
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const visible = state === "playing" || state === "paused";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 120, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 120, opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 320 }}
          className="fixed inset-x-4 z-50 overflow-hidden rounded-2xl border border-white/[0.12] bg-background"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
        >
          {/* Seek bar */}
          <div
            role="slider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
            className="relative h-1 w-full cursor-pointer bg-white/[0.08]"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek((e.clientX - r.left) / r.width); }}
          >
            <div className="h-full bg-primary transition-[width] duration-100" style={{ width: `${progress * 100}%` }} />
          </div>

          <div className="px-4 py-3">
            {/* Now-playing info */}
            {nowPlayingTopic && (
              <div className="mb-2.5 flex items-baseline justify-between gap-2 min-w-0">
                <p className="truncate font-serif text-sm leading-snug flex-1 min-w-0">{nowPlayingTopic.headline}</p>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {fmt(progress * duration)} / {fmt(duration)}
                </span>
              </div>
            )}
            {nowPlayingSection && (
              <p className="mb-3 text-xs text-muted-foreground">
                {nowPlayingSection.label} · {currentTopicIdx + 1}/{totalTopics}
              </p>
            )}

            {/* Transport */}
            <div className="flex items-center justify-between">
              <button onClick={onPrev} disabled={!hasPrev} aria-label="Previous"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30">
                <SkipBack className="size-4" />
              </button>
              <button onClick={() => onSeekBackward(10)} aria-label="Rewind 10 seconds"
                className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
                <RotateCcw className="size-4" />
                <span className="absolute bottom-0.5 text-[8px] font-semibold leading-none">10</span>
              </button>
              <button onClick={state === "playing" ? onPause : onResume}
                aria-label={state === "playing" ? "Pause" : "Resume"}
                className="flex size-12 items-center justify-center rounded-full bg-white/[0.08] transition-colors hover:bg-white/[0.14]">
                {state === "playing" ? <Pause className="size-5" /> : <Play className="size-5 ml-0.5" />}
              </button>
              <button onClick={() => onSeekForward(10)} aria-label="Forward 10 seconds"
                className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
                <RotateCw className="size-4" />
                <span className="absolute bottom-0.5 text-[8px] font-semibold leading-none">10</span>
              </button>
              <button onClick={onNext} disabled={!hasNext} aria-label="Next"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30">
                <SkipForward className="size-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Waveform animation ────────────────────────────────────────────────────────

function WaveformIcon() {
  return (
    <span className="flex items-end gap-[2px] h-4">
      {[1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-primary"
          animate={{ height: ["30%", "100%", "30%"] }}
          transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          style={{ display: "block" }}
        />
      ))}
    </span>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({ isDark, onToggleTheme }: { isDark: boolean; onToggleTheme: () => void }) {
  return (
    <header
      className="flex items-center justify-between px-6 pt-6"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)" }}
    >
      <Link to="/" className="font-serif text-xl tracking-tight">
        Khabar <span className="italic text-primary">AI</span>
      </Link>
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleTheme}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <Link to="/settings" className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5" aria-label="Settings">
          <Settings className="size-4" />
        </Link>
      </div>
    </header>
  );
}
