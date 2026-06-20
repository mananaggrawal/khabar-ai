import { Play, Pause, Newspaper, Flag, Globe, TrendingUp, Laptop, Film, Trophy, Microscope, Heart, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP, type SectionId } from "@/lib/news/sources";

// Lucide icon per section — replaces emoji fallback thumbnails
const SECTION_COLORS: Record<SectionId, string> = {
  headlines:     "bg-[#4A2FA0]",
  india:         "bg-[#C94A1E]",
  world:         "bg-[#0A6B5E]",
  business:      "bg-[#2D6A1F]",
  technology:    "bg-[#185FA5]",
  entertainment: "bg-[#8E2A6E]",
  sports:        "bg-[#A83020]",
  science:       "bg-[#1A6B8A]",
  health:        "bg-[#C44B6B]",
  local:         "bg-[#6B4E1A]",
};

const SECTION_ICON: Record<SectionId, React.ReactNode> = {
  headlines:     <Newspaper className="size-5 text-white" />,
  india:         <Flag      className="size-5 text-white" />,
  world:         <Globe     className="size-5 text-white" />,
  business:      <TrendingUp className="size-5 text-white" />,
  technology:    <Laptop    className="size-5 text-white" />,
  entertainment: <Film      className="size-5 text-white" />,
  sports:        <Trophy    className="size-5 text-white" />,
  science:       <Microscope className="size-5 text-white" />,
  health:        <Heart     className="size-5 text-white" />,
  local:         <MapPin    className="size-5 text-white" />,
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

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
  onPlay: () => void;
  onPause: () => void;
  onTap?: () => void;
}

export function StoryCard({ story, isPlaying, hasAudio, onPlay, onPause, onTap }: StoryCardProps) {
  const feed = FEED_MAP.get(story.section);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => e.key === "Enter" && onTap?.()}
      className={cn(
        "flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors cursor-pointer",
        isPlaying
          ? "bg-primary/[0.12]"
          : "bg-card hover:bg-muted/50",
      )}
    >
      {/* Thumbnail — left */}
      {story.imageUrl ? (
        <div className="shrink-0">
          <img
            src={story.imageUrl}
            alt=""
            className="h-[52px] w-[52px] rounded-xl object-cover"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = "none";
              const placeholder = el.nextElementSibling as HTMLElement | null;
              if (placeholder) placeholder.style.display = "flex";
            }}
          />
          {/* Fallback icon shown on image error */}
          <div
            className={cn(
              "hidden h-[52px] w-[52px] items-center justify-center rounded-xl",
              SECTION_COLORS[story.section] ?? "bg-muted",
            )}
            style={{ display: "none" }}
          >
            {SECTION_ICON[story.section]}
          </div>
        </div>
      ) : (
        <div className={cn(
          "flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-xl",
          SECTION_COLORS[story.section] ?? "bg-muted",
        )}>
          {SECTION_ICON[story.section]}
        </div>
      )}

      {/* Text — centre */}
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-primary/80">
          {feed?.label ?? story.section}
        </p>
        <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
          {story.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">
          {story.source} · {timeAgo(story.publishedAt)}
        </p>
      </div>

      {/* Play / pause — right circle */}
      {hasAudio && (
        <button
          onClick={(e) => { e.stopPropagation(); isPlaying ? onPause() : onPlay(); }}
          aria-label={isPlaying ? "Pause" : "Play"}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors",
            isPlaying
              ? "border-primary bg-primary text-white"
              : "border-white/[0.15] bg-white/[0.04] text-muted-foreground hover:border-white/30 hover:text-foreground",
          )}
        >
          {isPlaying
            ? <WaveformIcon />
            : <Play className="size-3.5 fill-current ml-0.5" />}
        </button>
      )}
    </div>
  );
}
