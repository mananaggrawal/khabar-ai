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
import type { BriefingSection } from "@/lib/news/generator";

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

  // Current playing section info
  const nowPlayingSection = mono.currentSectionIdx >= 0
    ? mono.sectionsWithAudio[mono.currentSectionIdx]
    : null;
  const hasPrev = mono.currentSectionIdx > 0 || (mono.currentSectionIdx === 0 && mono.progress > 0.05);
  const hasNext = mono.currentSectionIdx >= 0 && mono.currentSectionIdx < mono.sectionsWithAudio.length - 1;

  return (
    <>
      <TopBar isDark={isDark} onToggleTheme={toggleTheme} />
      <main className="flex flex-1 flex-col items-center px-4 pb-10">

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
        <div className="flex min-h-[2.5rem] flex-col items-center gap-0.5 text-center">
          {nowPlayingSection ? (
            <>
              <p className="font-serif text-xl tracking-tight">{nowPlayingSection.label}</p>
              <p className="text-xs text-muted-foreground">
                {mono.currentSectionIdx + 1} of {mono.sectionsWithAudio.length} sections
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

        {/* ── Music player controls ─────────────────────────────────────── */}
        <div className="mt-4 w-full max-w-sm space-y-3">

          {/* Progress bar — shown when playing or paused */}
          {(mono.state === "playing" || mono.state === "paused") && (
            <ProgressBar progress={mono.progress} duration={mono.duration} onSeek={mono.seek} />
          )}

          {/* Transport row */}
          {(mono.state === "playing" || mono.state === "paused") && (
            <div className="flex items-center justify-center gap-2">
              {/* Prev section */}
              <button
                onClick={mono.prevSection}
                disabled={!hasPrev}
                aria-label="Previous section"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
              >
                <SkipBack className="size-4" />
              </button>

              {/* –10s */}
              <button
                onClick={() => mono.seekBackward(10)}
                aria-label="Rewind 10 seconds"
                className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <RotateCcw className="size-4" />
                <span className="absolute bottom-0.5 text-[8px] font-semibold leading-none">10</span>
              </button>

              {/* Play / Pause (large) */}
              <button
                onClick={mono.state === "playing" ? mono.pause : mono.resume}
                aria-label={mono.state === "playing" ? "Pause" : "Resume"}
                className="flex size-14 items-center justify-center rounded-full bg-white/[0.08] transition-colors hover:bg-white/[0.14]"
              >
                {mono.state === "playing"
                  ? <Pause className="size-6" />
                  : <Play className="size-6 ml-0.5" />}
              </button>

              {/* +10s */}
              <button
                onClick={() => mono.seekForward(10)}
                aria-label="Forward 10 seconds"
                className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <RotateCw className="size-4" />
                <span className="absolute bottom-0.5 text-[8px] font-semibold leading-none">10</span>
              </button>

              {/* Next section */}
              <button
                onClick={mono.nextSection}
                disabled={!hasNext}
                aria-label="Next section"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
              >
                <SkipForward className="size-4" />
              </button>

            </div>
          )}


          {/* Idle — hint to tap orb */}
          {mono.state === "idle" && !briefingQuery.isLoading && hasAudio && (
            <p className="text-center text-sm text-muted-foreground">
              Tap the orb to start listening
            </p>
          )}
        </div>

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
  allSections: BriefingSection[];
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
        const globalIdx = allSections.findIndex((s) => s.category === section.category);
        const isPlaying = mono.currentSectionIdx === globalIdx && mono.state === "playing";
        const isPaused = mono.currentSectionIdx === globalIdx && mono.state === "paused";
        return (
          <SectionRow
            key={section.category}
            section={section}
            isPlaying={isPlaying}
            isPaused={isPaused}
            hasAudio={!!section.audioUrl}
            onPlay={() => globalIdx >= 0 ? mono.playSection(globalIdx) : undefined}
            onPause={mono.pause}
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
  onPlay,
  onPause,
  progress,
  showDivider,
}: {
  section: BriefingSection;
  isPlaying: boolean;
  isPaused: boolean;
  hasAudio: boolean;
  onPlay: () => void;
  onPause: () => void;
  progress: number;
  showDivider: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = isPlaying || isPaused;

  return (
    <div className={`transition-colors ${active ? "bg-primary/[0.07]" : ""}`}>
      {showDivider && <div className="mx-4 h-px bg-white/[0.05]" />}

      <div className="flex items-center gap-3 px-4 py-3">
        {/* Play/pause button */}
        <button
          onClick={isPlaying ? onPause : onPlay}
          disabled={!hasAudio}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 disabled:opacity-30"
        >
          {isPlaying
            ? <WaveformIcon />
            : <Play className="size-3.5 ml-0.5" />}
        </button>

        {/* Section name */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm ${active ? "font-medium text-foreground" : "text-foreground/80"}`}>
            {section.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {section.topics.length} {section.topics.length === 1 ? "story" : "stories"}
            {!hasAudio && " · no audio"}
          </p>
        </div>

        {/* Expand stories */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Toggle stories"
        >
          <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Progress strip (active section) */}
      {active && (
        <div className="h-[2px] bg-white/[0.05]">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {/* Expanded stories */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1">
              <BriefingList topics={section.topics} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ progress, duration, onSeek }: {
  progress: number; duration: number; onSeek: (f: number) => void;
}) {
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div className="space-y-1">
      <div
        role="slider" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)} tabIndex={0}
        className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/10"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - rect.left) / rect.width);
        }}
      >
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{fmt(progress * duration)}</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
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
