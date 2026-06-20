import { usePlayer } from "@/contexts/PlayerContext";
import { VoiceOrb } from "@/components/VoiceOrb";
import {
  ArrowLeft, Bookmark, SkipBack, SkipForward,
  Play, Pause, Mic,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

/** Deterministic bar height 20–99 from index */
function barH(i: number): number {
  const s = ((i * 1664525 + 1013904223) & 0x7fffffff) >>> 0;
  return 20 + (s % 80);
}

function WaveformScrubber({
  progress,
  duration,
  onSeek,
}: {
  progress: number;
  duration: number;
  onSeek: (f: number) => void;
}) {
  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const BARS = 60;

  return (
    <div>
      <div
        className="flex items-center gap-[2px] h-12 cursor-pointer select-none"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - rect.left) / rect.width);
        }}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") onSeek(Math.min(1, progress + 0.02));
          if (e.key === "ArrowLeft") onSeek(Math.max(0, progress - 0.02));
        }}
      >
        {Array.from({ length: BARS }, (_, i) => {
          const played = i / BARS < progress;
          return (
            <div
              key={i}
              className={played ? "bg-foreground/75" : "bg-foreground/12"}
              style={{
                width: 3,
                height: `${barH(i)}%`,
                borderRadius: 1.5,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">
          {fmt(progress * duration)}
        </span>
        <span className="text-[10px] text-muted-foreground">{fmt(duration)}</span>
      </div>
    </div>
  );
}

export function PlayerSheet() {
  const { mono, briefing, showPlayer, setShowPlayer } = usePlayer();

  const nowPlaying =
    mono.currentSectionIdx >= 0
      ? mono.sectionsWithAudio[mono.currentSectionIdx]
      : briefing?.sections?.[0] ?? null;

  const categoryLabel = nowPlaying
    ? `${nowPlaying.label.toUpperCase()} · ${Math.ceil((mono.duration || 240) / 60)} MIN`
    : "KHABAR AI";

  const headline =
    nowPlaying?.topics?.[0]?.headline ?? "Today's Briefing";

  const orbState: "idle" | "speaking" | "listening" =
    mono.state === "playing"
      ? "speaking"
      : mono.state === "paused"
      ? "listening"
      : "idle";

  const hasPrev =
    mono.currentSectionIdx > 0 ||
    (mono.currentSectionIdx === 0 && mono.progress > 0.05);
  const hasNext =
    mono.currentSectionIdx >= 0 &&
    mono.currentSectionIdx < mono.sectionsWithAudio.length - 1;

  return (
    <AnimatePresence>
      {showPlayer && (
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
          className="fixed inset-0 z-50 flex flex-col bg-background"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 flex-shrink-0">
            <button
              onClick={() => setShowPlayer(false)}
              className="size-9 flex items-center justify-center text-muted-foreground rounded-full hover:bg-muted transition-colors"
              aria-label="Close player"
            >
              <ArrowLeft className="size-5" />
            </button>
            <span className="text-[10px] tracking-[0.15em] text-muted-foreground uppercase">
              Today's Briefing
            </span>
            <button
              className="size-9 flex items-center justify-center text-muted-foreground rounded-full hover:bg-muted transition-colors"
              aria-label="Bookmark"
            >
              <Bookmark className="size-5" />
            </button>
          </div>

          {/* Orb */}
          <div className="flex-1 flex items-center justify-center min-h-0 pb-2">
            <VoiceOrb
              state={orbState}
              size={200}
              onClick={() =>
                mono.state === "playing" ? mono.pause() : mono.orbTap()
              }
            />
          </div>

          {/* Track info + controls */}
          <div className="px-6 flex-shrink-0 pb-8">
            <p className="text-[10px] tracking-[0.1em] text-primary font-semibold mb-1.5">
              {categoryLabel}
            </p>
            <p className="font-serif text-xl leading-snug text-foreground mb-1">
              {headline}
            </p>
            <p className="text-xs text-muted-foreground mb-5">
              Khabar AI · Voice of Aanya
            </p>

            {/* Waveform */}
            <WaveformScrubber
              progress={mono.progress}
              duration={mono.duration}
              onSeek={mono.seek}
            />

            {/* Transport */}
            <div className="flex items-center justify-between mt-5 mb-4">
              <span className="text-xs text-muted-foreground tracking-wider cursor-pointer">
                SAVE
              </span>
              <button
                onClick={mono.prevSection}
                disabled={!hasPrev}
                className="size-10 flex items-center justify-center text-foreground disabled:opacity-30 transition-opacity"
                aria-label="Previous section"
              >
                <SkipBack className="size-5" />
              </button>
              <button
                onClick={
                  mono.state === "playing" ? mono.pause : mono.resume
                }
                className="size-14 rounded-full bg-foreground flex items-center justify-center shadow-sm active:scale-95 transition-transform"
                aria-label={mono.state === "playing" ? "Pause" : "Play"}
              >
                {mono.state === "playing" ? (
                  <Pause className="size-6 text-background" />
                ) : (
                  <Play className="size-6 text-background ml-0.5" />
                )}
              </button>
              <button
                onClick={mono.nextSection}
                disabled={!hasNext}
                className="size-10 flex items-center justify-center text-foreground disabled:opacity-30 transition-opacity"
                aria-label="Next section"
              >
                <SkipForward className="size-5" />
              </button>
              <span className="text-xs text-muted-foreground tracking-wider cursor-pointer">
                TELL MORE
              </span>
            </div>

            {/* Voice hint */}
            <div className="flex items-center justify-center gap-2 rounded-full border border-border bg-muted/40 py-2.5 px-4">
              <Mic className="size-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Just say "next" to skip ahead
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
