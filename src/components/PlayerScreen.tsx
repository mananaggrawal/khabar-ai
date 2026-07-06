/**
 * PlayerScreen — full-screen player sheet (Spotify-style).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown, SkipBack, SkipForward, Play, Pause,
  RotateCcw, RotateCw, Bookmark, FileText,
  Flame, LandmarkIcon, Globe, TrendingUp, Cpu, Trophy, FlaskConical, HeartPulse, MapPin,
} from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { StoryDetailSheet } from "./StoryDetailSheet";
import type { useMonologue } from "@/hooks/useMonologue";
import { getStoryTitle, getSectionLabel } from "@/hooks/useMonologue";
import type { SectionId } from "@/lib/news/sources";

type MonoHook = ReturnType<typeof useMonologue>;

interface PlayerScreenProps {
  mono: MonoHook;
  visible: boolean;
  onClose: () => void;
  isSaved?: boolean;
  onSave?: () => void;
}

const LEGACY_SECTION: Record<string, SectionId> = {
  politics: "india", techlife: "technology", entertainment: "india",
};
function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (["headlines", "local", "india", "world", "business", "technology", "sports", "science", "health"].includes(s)) return s as SectionId;
  return "india";
}

const SECTION_COLOR: Record<SectionId, string> = {
  headlines:  "#EF4444",
  local:      "#8B5CF6",
  india:      "#F97316",
  world:      "#0D9488",
  business:   "#16A34A",
  technology: "#6366F1",
  sports:     "#DB2777",
  science:    "#0EA5E9",
  health:     "#65A30D",
};

const SECTION_ICON: Record<SectionId, React.ReactNode> = {
  headlines:  <Flame        className="size-8" />,
  local:      <MapPin       className="size-8" />,
  india:      <LandmarkIcon className="size-8" />,
  world:      <Globe        className="size-8" />,
  business:   <TrendingUp   className="size-8" />,
  technology: <Cpu          className="size-8" />,
  sports:     <Trophy       className="size-8" />,
  science:    <FlaskConical className="size-8" />,
  health:     <HeartPulse   className="size-8" />,
};

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlayerScreen({ mono, visible, onClose, isSaved, onSave }: PlayerScreenProps) {
  const [showDetails, setShowDetails] = useState(false);

  if (typeof document === "undefined") return null;

  const {
    state, progress, duration, currentStory, currentFeed,
    storiesWithAudio, language,
    pause, resume, next, prev, seek, seekBackward, seekForward,
  } = mono;

  const isPlaying = state === "playing";
  const elapsed   = progress * duration;
  const accent    = currentStory ? (SECTION_COLOR[resolveSection(currentStory.section)] ?? "#EF4444") : "#EF4444";

  const sectionStories = currentFeed
    ? storiesWithAudio.filter((s) => s.section === currentFeed.id)
    : [];
  const storyPosInSection = currentStory
    ? sectionStories.findIndex((s) => s.id === currentStory.id) + 1
    : 0;

  const orbState = state === "playing" ? "speaking" : "idle";

  return createPortal(
    <>
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 32, stiffness: 300 }}
          className="fixed inset-0 z-[60] flex flex-col bg-white"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <button onClick={onClose} aria-label="Close player"
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors">
              <ChevronDown className="size-5" />
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
              Today's Briefing
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => currentStory && setShowDetails(true)} aria-label="Summary & sources" disabled={!currentStory}
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors disabled:opacity-40">
                <FileText className="size-4" />
              </button>
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSave?.(); }} aria-label={isSaved ? "Unsave" : "Save"}
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 transition-colors">
                <Bookmark className="size-4" fill={isSaved ? "currentColor" : "none"} style={isSaved ? { color: accent } : undefined} />
              </button>
            </div>
          </div>

          {/* Artwork / Orb */}
          <div className="flex flex-1 items-center justify-center px-8">
            {currentStory?.imageUrl ? (
              <div className="relative w-full max-w-[280px] aspect-square">
                <img src={currentStory.imageUrl} alt=""
                  className="w-full h-full rounded-3xl object-cover shadow-2xl"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                    const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                    if (fallback) fallback.style.display = "flex";
                  }}
                />
                <div className="hidden w-full h-full rounded-3xl items-center justify-center shadow-2xl absolute inset-0"
                  style={{ backgroundColor: `${accent}20` }}>
                  <span style={{ color: accent }}>
                    {currentStory?.section ? SECTION_ICON[resolveSection(currentStory.section)] : null}
                  </span>
                </div>
                {isPlaying && (
                  <div className="absolute bottom-3 right-3 opacity-80">
                    <VoiceOrb state={orbState} amplitude={0.5} size={56} onClick={pause} />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-3xl shadow-inner"
                style={{ width: 280, height: 280, backgroundColor: `${accent}15` }}>
                <VoiceOrb state={orbState} amplitude={isPlaying ? 0.6 : 0.1} size={200} onClick={isPlaying ? pause : resume} />
              </div>
            )}
          </div>

          {/* Story info — tap to open summary, sources & dive deeper */}
          <div
            role={currentStory ? "button" : undefined}
            onClick={() => currentStory && setShowDetails(true)}
            className="px-6 pb-2 cursor-pointer"
          >
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] mb-1.5" style={{ color: accent }}>
              {currentFeed && <span>{getSectionLabel(currentFeed, language)}</span>}
              {sectionStories.length > 0 && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground/60 normal-case font-normal tracking-normal">
                    {storyPosInSection} of {sectionStories.length}
                  </span>
                </>
              )}
            </div>
            <p className="font-serif text-xl leading-snug text-foreground line-clamp-3">
              {(currentStory ? getStoryTitle(currentStory, language) : null) ?? "—"}
            </p>
            <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary font-medium">
              <FileText className="size-3" /> Summary, sources & more
            </p>
          </div>

          {/* Seek bar */}
          <div className="px-6 pb-3">
            <input type="range" min={0} max={1} step={0.001} value={progress}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="w-full h-1 cursor-pointer rounded-full accent-primary"
              style={{ background: `linear-gradient(to right, var(--primary) ${progress * 100}%, oklch(0 0 0 / 0.12) ${progress * 100}%)` }}
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/60">
              <span>{formatTime(elapsed)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-6 px-6"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2rem)" }}>
            <button onClick={prev} aria-label="Previous story"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors">
              <SkipBack className="size-5 fill-current" />
            </button>
            <button onClick={() => seekBackward(10)} aria-label="Rewind 10s"
              className="flex flex-col size-10 items-center justify-center gap-0.5 rounded-full text-muted-foreground hover:text-foreground transition-colors">
              <RotateCcw className="size-5" />
              <span className="text-[9px] font-semibold leading-none">10</span>
            </button>
            <button onClick={isPlaying ? pause : resume} aria-label={isPlaying ? "Pause" : "Play"}
              className="flex size-14 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95"
              style={{ backgroundColor: accent }}>
              {isPlaying ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current ml-0.5" />}
            </button>
            <button onClick={() => seekForward(10)} aria-label="Forward 10s"
              className="flex flex-col size-10 items-center justify-center gap-0.5 rounded-full text-muted-foreground hover:text-foreground transition-colors">
              <RotateCw className="size-5" />
              <span className="text-[9px] font-semibold leading-none">10</span>
            </button>
            <button onClick={next} aria-label="Next story"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors">
              <SkipForward className="size-5 fill-current" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Same detail popup as the home screen — summary, sources & dive deeper */}
    <StoryDetailSheet
      story={showDetails ? currentStory : null}
      language={language}
      onClose={() => setShowDetails(false)}
      onPlay={() => {}}
      isPlaying={isPlaying}
      isSaved={isSaved}
      onSave={onSave}
      elevated
    />
    </>,
    document.body,
  );
}
