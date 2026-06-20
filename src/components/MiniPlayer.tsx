import { usePlayer } from "@/contexts/PlayerContext";
import { Play, Pause, Mic } from "lucide-react";

export function MiniPlayer() {
  const { mono, setShowPlayer } = usePlayer();

  if (mono.state === "idle") return null;

  const nowPlaying =
    mono.currentSectionIdx >= 0
      ? mono.sectionsWithAudio[mono.currentSectionIdx]
      : null;

  // Show section label + lead story headline
  const sectionLabel = nowPlaying?.label ?? "Khabar AI";
  const leadHeadline = nowPlaying?.topics?.[0]?.headline ?? null;

  return (
    <div
      className="fixed bottom-[68px] left-0 right-0 z-40 h-[64px] border-t border-border bg-card/95 backdrop-blur-sm"
    >
      {/* Progress strip at top */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-primary/15">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${mono.progress * 100}%` }}
        />
      </div>

      <div
        className="flex h-full items-center gap-3 px-4 cursor-pointer"
        onClick={() => setShowPlayer(true)}
      >
        {/* Orb thumb */}
        <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 border border-primary/20">
          <div className="size-5 rounded-full bg-primary/30 flex items-center justify-center">
            <div className="size-2.5 rounded-full bg-primary" />
          </div>
        </div>

        {/* Section + headline */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-primary truncate">
            {sectionLabel}
          </p>
          {leadHeadline ? (
            <p className="text-xs text-foreground truncate leading-tight">{leadHeadline}</p>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              Section {(mono.currentSectionIdx ?? 0) + 1} of {mono.sectionsWithAudio.length}
            </p>
          )}
        </div>

        {/* Mic icon */}
        <button
          className="size-8 flex items-center justify-center text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
          aria-label="Voice"
        >
          <Mic className="size-4" />
        </button>

        {/* Play / Pause */}
        <button
          className="size-8 flex items-center justify-center text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            mono.state === "playing" ? mono.pause() : mono.resume();
          }}
          aria-label={mono.state === "playing" ? "Pause" : "Play"}
        >
          {mono.state === "playing"
            ? <Pause className="size-5" />
            : <Play className="size-5" />}
        </button>
      </div>
    </div>
  );
}
