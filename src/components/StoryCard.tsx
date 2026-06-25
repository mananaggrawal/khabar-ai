import { Play, Pause, Globe, TrendingUp, Trophy, Zap, LandmarkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";
import { getStoryTitle } from "@/hooks/useMonologue";

// Per-section accent colors — used for left border + label
export const SECTION_COLOR: Record<SectionId, string> = {
  politics: "#E05A2B",
  world:    "#0D9488",
  business: "#16A34A",
  sports:   "#DC2626",
  techlife: "#7B5CF0",
};

// Legacy section names → new section (for briefings generated before the taxonomy change)
const LEGACY_SECTION: Record<string, SectionId> = {
  headlines: "politics",
  india:     "politics",
  local:     "politics",
  technology:"techlife",
  entertainment:"techlife",
  science:   "techlife",
  health:    "techlife",
};

function resolveSection(s: string): SectionId {
  return LEGACY_SECTION[s] ?? (s as SectionId);
}

// Lucide icon per section
const SECTION_ICON: Record<SectionId, React.ReactNode> = {
  politics: <LandmarkIcon className="size-5" />,
  world:    <Globe        className="size-5" />,
  business: <TrendingUp   className="size-5" />,
  sports:   <Trophy       className="size-5" />,
  techlife: <Zap          className="size-5" />,
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
  language?: import("@/hooks/useMonologue").Language;
  onPlay: () => void;
  onPause: () => void;
  onTap?: () => void;
}

export function StoryCard({ story, isPlaying, hasAudio, language = "en", onPlay, onPause, onTap }: StoryCardProps) {
  const section = resolveSection(story.section);
  const feed = FEED_MAP.get(section);
  const accent = SECTION_COLOR[section] ?? "#7B5CF0";
  const displayTitle = getStoryTitle(story, language ?? "en");
  const sectionLabel = language === "hi" ? (feed?.labelHi ?? feed?.label ?? story.section) : (feed?.label ?? story.section);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => e.key === "Enter" && onTap?.()}
      className={cn(
        "flex items-center gap-3 rounded-2xl px-3 py-3 transition-all duration-150 cursor-pointer overflow-hidden",
        "border-l-[3px]",
        isPlaying
          ? "bg-primary/[0.06] ring-1 ring-primary/20"
          : "bg-white ring-1 ring-black/[0.07] active:scale-[0.99]",
      )}
      style={{ borderLeftColor: accent }}
    >
      {/* Thumbnail — left */}
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

      {/* Text — centre */}
      <div className="min-w-0 flex-1">
        <p
          className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: accent }}
        >
          {sectionLabel}
        </p>
        <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
          {displayTitle}
        </p>
      </div>

      {/* Right actions */}
      <div className="flex shrink-0 flex-col items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {/* Play / pause */}
        {hasAudio && (
          <button
            onClick={() => isPlaying ? onPause() : onPlay()}
            aria-label={isPlaying ? "Pause" : "Play"}
            className={cn(
              "flex size-9 items-center justify-center rounded-full border transition-all",
              isPlaying
                ? "border-transparent text-white shadow-md"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
            style={isPlaying ? { backgroundColor: accent } : undefined}
          >
            {isPlaying
              ? <WaveformIcon />
              : <Play className="size-3.5 fill-current ml-0.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
