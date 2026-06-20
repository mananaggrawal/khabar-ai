import { Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP } from "@/lib/news/sources";

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
}

export function StoryCard({ story, isPlaying, hasAudio, onPlay, onPause }: StoryCardProps) {
  const feed = FEED_MAP.get(story.section);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors",
        isPlaying
          ? "bg-primary/[0.12]"
          : "bg-card hover:bg-card/80",
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
          {/* Placeholder behind — shown on error */}
          <div
            className="hidden h-[52px] w-[52px] items-center justify-center rounded-xl bg-white/[0.06] text-xl"
            style={{ display: "none" }}
          >
            {feed?.emoji ?? "📰"}
          </div>
        </div>
      ) : (
        <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-xl">
          {feed?.emoji ?? "📰"}
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
          onClick={() => isPlaying ? onPause() : onPlay()}
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
