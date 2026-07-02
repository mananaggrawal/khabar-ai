import { memo } from "react";
import { Play, Check, Flame, LandmarkIcon, Globe, TrendingUp, MapPin, Cpu, Trophy, FlaskConical, HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";
import { getStoryTitle } from "@/hooks/useMonologue";

// Per-section accent colors
export const SECTION_COLOR: Record<SectionId, string> = {
  headlines:  "#EF4444",
  india:      "#F97316",
  world:      "#0D9488",
  business:   "#16A34A",
  technology: "#6366F1",
  sports:     "#DB2777",
  science:    "#0EA5E9",
  health:     "#65A30D",
  local:      "#2563EB",
};

// Legacy section names → new section (backward compat for old briefings)
const LEGACY_SECTION: Record<string, SectionId> = {
  politics:      "india",
  techlife:      "technology",
  entertainment: "india",
};

function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (["headlines", "india", "world", "business", "technology", "sports", "science", "health", "local"].includes(s)) return s as SectionId;
  return "india";
}

// Lucide icon per section
const SECTION_ICON: Record<SectionId, React.ReactNode> = {
  headlines:  <Flame        className="size-5" />,
  india:      <LandmarkIcon className="size-5" />,
  world:      <Globe        className="size-5" />,
  business:   <TrendingUp   className="size-5" />,
  technology: <Cpu          className="size-5" />,
  sports:     <Trophy       className="size-5" />,
  science:    <FlaskConical className="size-5" />,
  health:     <HeartPulse   className="size-5" />,
  local:      <MapPin       className="size-5" />,
};

function WaveformIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
      {[2, 5, 8, 11, 14].map((x, i) => (
        <rect
          key={x}
          x={x - 1} y={0} width={2} rx={1}
          style={{
            animation: `waveform 0.9s ease-in-out ${i * 0.12}s infinite alternate`,
            transformOrigin: "center bottom",
          } as React.CSSProperties}
          height={8 + (i % 2) * 4}
          transform={`translate(0, ${4 - (i % 2) * 2})`}
        />
      ))}
      <style>{`
        @keyframes waveform {
          from { transform: scaleY(0.3); }
          to   { transform: scaleY(1); }
        }
      `}</style>
    </svg>
  );
}

interface StoryCardProps {
  story: Story;
  isPlaying: boolean;
  hasAudio: boolean;
  isCompleted?: boolean;
  language?: import("@/hooks/useMonologue").Language;
  onPlay: (story: Story) => void;
  onPause: () => void;
  onTap?: (story: Story) => void;
}

function StoryCardBase({ story, isPlaying, hasAudio, isCompleted = false, language = "en", onPlay, onPause, onTap }: StoryCardProps) {
  const section = resolveSection(story.section);
  const feed    = FEED_MAP.get(section);
  const accent  = SECTION_COLOR[section] ?? "#EF4444";
  const displayTitle  = getStoryTitle(story, language ?? "en");
  const sectionLabel  = language === "hi" ? (feed?.labelHi ?? feed?.label ?? story.section) : (feed?.label ?? story.section);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onTap?.(story)}
      onKeyDown={(e) => e.key === "Enter" && onTap?.(story)}
      className={cn(
        "flex items-center gap-3 rounded-2xl px-3 py-3 transition-all duration-150 cursor-pointer overflow-hidden",
        "border-l-[3px]",
        isPlaying
          ? "bg-primary/[0.06] ring-1 ring-primary/20"
          : "bg-white ring-1 ring-black/[0.07] active:scale-[0.99]",
      )}
      style={{ borderLeftColor: accent }}
    >
      {/* Thumbnail */}
      {story.imageUrl ? (
        <div className="shrink-0">
          <img
            src={story.imageUrl}
            alt=""
            className="h-[56px] w-[56px] rounded-xl object-cover shadow-sm"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = "none";
              const placeholder = el.nextElementSibling as HTMLElement | null;
              if (placeholder) placeholder.style.display = "flex";
            }}
          />
          <div
            className="hidden h-[56px] w-[56px] items-center justify-center rounded-xl"
            style={{ display: "none", backgroundColor: `${accent}18` }}
          >
            <span style={{ color: accent }}>{SECTION_ICON[section]}</span>
          </div>
        </div>
      ) : (
        <div
          className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${accent}18` }}
        >
          <span style={{ color: accent }}>{SECTION_ICON[section]}</span>
        </div>
      )}

      {/* Text */}
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: accent }}>
          <span className="shrink-0">{sectionLabel}</span>
          {story.source && (
            <>
              <span className="shrink-0 opacity-50">·</span>
              <span className="min-w-0 truncate font-medium normal-case tracking-normal text-muted-foreground/80">
                {story.source}
              </span>
            </>
          )}
        </p>
        <p className={cn(
          "text-sm font-medium leading-snug line-clamp-2",
          isCompleted && !isPlaying ? "text-foreground/50" : "text-foreground",
        )}>
          {displayTitle}
        </p>
      </div>

      {/* Play button */}
      <div className="flex shrink-0 flex-col items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {hasAudio && (
          <button
            onClick={() => isPlaying ? onPause() : onPlay(story)}
            aria-label={isPlaying ? "Pause" : "Play"}
            className={cn(
              "relative flex size-9 items-center justify-center rounded-full border transition-all",
              isPlaying
                ? "border-transparent text-white shadow-md"
                : isCompleted
                  ? "border-border bg-background text-muted-foreground/60 hover:text-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
            style={isPlaying ? { backgroundColor: accent } : undefined}
          >
            {isPlaying ? <WaveformIcon /> : <Play className="size-3.5 fill-current ml-0.5" />}
            {isCompleted && !isPlaying && (
              <span
                className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center"
                aria-label="Listened"
              >
                <Check className="size-3" style={{ color: accent }} strokeWidth={3} />
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export const StoryCard = memo(StoryCardBase);
