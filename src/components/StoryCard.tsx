import { Play, Pause, ExternalLink } from "lucide-react";
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
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <div className="flex w-full items-stretch">

        {/* Play / pause — full-height tap zone on the left */}
        {hasAudio ? (
          <button
            onClick={() => isPlaying ? onPause() : onPlay()}
            aria-label={isPlaying ? "Pause" : "Play"}
            className={`flex w-14 shrink-0 items-center justify-start pl-4 outline-none transition-colors ${
              isPlaying ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isPlaying ? <WaveformIcon /> : <Play className="size-4 ml-0.5" />}
          </button>
        ) : (
          <span className="flex w-14 shrink-0 items-center justify-center text-xs tabular-nums text-muted-foreground/40">
            —
          </span>
        )}

        {/* Content */}
        <div className="flex min-w-0 flex-1 items-start gap-3 py-3 pr-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[11px] text-muted-foreground/70 truncate max-w-[110px]">{story.source}</span>
              <span className="text-muted-foreground/40 text-[11px]">·</span>
              <span className="text-[11px] text-muted-foreground/50 shrink-0">{timeAgo(story.publishedAt)}</span>
            </div>
            <p className="font-serif text-base leading-snug">{story.title}</p>
          </div>

          {/* Thumbnail */}
          {story.imageUrl && (
            <div className="shrink-0 self-start">
              <img
                src={story.imageUrl}
                alt=""
                className="h-14 w-[4.5rem] rounded-xl object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}
        </div>

      </div>

      {/* Article link — bottom strip */}
      {story.link && (
        <div className="border-t border-white/[0.04] px-4 py-2 pl-[3.5rem]">
          <a
            href={story.link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="size-3" />
            Go to article
          </a>
        </div>
      )}
    </div>
  );
}
