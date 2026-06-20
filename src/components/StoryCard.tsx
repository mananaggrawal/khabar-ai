import { Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Story } from "@/lib/news/generator";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface StoryCardProps {
  story: Story;
  isPlaying: boolean;
  hasAudio: boolean;
  onPlay: () => void;
  onPause: () => void;
}

export function StoryCard({ story, isPlaying, hasAudio, onPlay, onPause }: StoryCardProps) {
  return (
    <div className={cn(
      "relative flex gap-3 rounded-2xl border px-4 py-3 transition-colors",
      isPlaying
        ? "border-primary/30 bg-primary/[0.06]"
        : "border-white/[0.07] bg-white/[0.02]",
    )}>
      {/* Text block */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70 truncate max-w-[120px]">{story.source}</span>
          <span>·</span>
          <span className="shrink-0">{timeAgo(story.publishedAt)}</span>
        </div>
        <a
          href={story.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium leading-snug text-foreground/90 hover:text-foreground line-clamp-3 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {story.title}
        </a>
      </div>

      {/* Thumbnail */}
      {story.imageUrl && (
        <div className="shrink-0 self-start">
          <img
            src={story.imageUrl}
            alt=""
            className="h-16 w-20 rounded-xl object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        </div>
      )}

      {/* Play button — pinned bottom-right */}
      {hasAudio && (
        <button
          onClick={(e) => { e.stopPropagation(); isPlaying ? onPause() : onPlay(); }}
          aria-label={isPlaying ? "Pause" : "Play"}
          className={cn(
            "absolute bottom-3 right-3 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
            isPlaying
              ? "bg-primary text-white"
              : "bg-white/[0.08] text-muted-foreground hover:bg-white/[0.14] hover:text-foreground",
          )}
        >
          {isPlaying
            ? <Pause className="size-3.5 fill-current" />
            : <Play  className="size-3.5 fill-current ml-0.5" />}
        </button>
      )}
    </div>
  );
}
