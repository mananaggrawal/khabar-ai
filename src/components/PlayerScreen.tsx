/**
 * PlayerScreen — full-screen player sheet (Spotify-style).
 * Opens when user taps the mini-player.
 * Contains the VoiceOrb, story info, seek bar, and transport controls.
 */
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown, SkipBack, SkipForward, Play, Pause,
  RotateCcw, RotateCw, ExternalLink,
} from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import type { useMonologue } from "@/hooks/useMonologue";

type MonoHook = ReturnType<typeof useMonologue>;

interface PlayerScreenProps {
  mono: MonoHook;
  visible: boolean;
  onClose: () => void;
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlayerScreen({ mono, visible, onClose }: PlayerScreenProps) {
  if (typeof document === "undefined") return null;

  const {
    state, progress, duration, currentStory, currentFeed,
    storiesWithAudio, currentStoryIdx, language,
    pause, resume, next, prev, seek, seekBackward, seekForward,
  } = mono;

  const isPlaying = state === "playing";
  const elapsed = progress * duration;

  const orbState =
    state === "playing" ? "speaking"
    : state === "paused" ? "idle"
    : "idle";

  // Section + story count within section
  const sectionStories = currentFeed
    ? storiesWithAudio.filter((s) => s.section === currentFeed.id)
    : [];
  const storyPosInSection = currentStory
    ? sectionStories.findIndex((s) => s.id === currentStory.id) + 1
    : 0;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 32, stiffness: 300 }}
          className="fixed inset-0 z-[60] flex flex-col bg-background"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <button
              onClick={onClose}
              aria-label="Close player"
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
            >
              <ChevronDown className="size-5" />
            </button>
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground/60">
              Now playing
            </span>
            {currentStory?.link ? (
              <a
                href={currentStory.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
                aria-label="Open article"
              >
                <ExternalLink className="size-4" />
              </a>
            ) : <div className="size-9" />}
          </div>

          {/* Orb — centered */}
          <div className="flex flex-1 items-center justify-center">
            <VoiceOrb
              state={orbState}
              amplitude={isPlaying ? 0.6 : 0.1}
              size={220}
              onClick={isPlaying ? pause : resume}
            />
          </div>

          {/* Story info */}
          <div className="px-6 pb-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              {currentFeed && (
                <span>{currentFeed.emoji} {language === "hi" ? currentFeed.labelHi : currentFeed.label}</span>
              )}
              {sectionStories.length > 0 && (
                <>
                  <span>·</span>
                  <span>{storyPosInSection} / {sectionStories.length}</span>
                </>
              )}
            </div>

            <p className="font-serif text-xl leading-snug text-foreground line-clamp-3">
              {currentStory?.title ?? "—"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {currentStory?.source ?? ""}
            </p>
          </div>

          {/* Seek bar */}
          <div className="px-6 pb-3">
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={progress}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="w-full h-1 cursor-pointer rounded-full accent-primary"
              style={{
                background: `linear-gradient(to right, hsl(var(--primary)) ${progress * 100}%, rgba(255,255,255,0.15) ${progress * 100}%)`,
              }}
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/60">
              <span>{formatTime(elapsed)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Transport controls */}
          <div
            className="flex items-center justify-center gap-6 pb-8 px-6"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2rem)" }}
          >
            <button
              onClick={() => prev()}
              aria-label="Previous story"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <SkipBack className="size-5 fill-current" />
            </button>

            <button
              onClick={() => seekBackward(10)}
              aria-label="Rewind 10s"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="size-5" />
              <span className="sr-only">−10s</span>
            </button>

            <button
              onClick={isPlaying ? pause : resume}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="flex size-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition-transform active:scale-95"
            >
              {isPlaying
                ? <Pause className="size-6 fill-current" />
                : <Play  className="size-6 fill-current ml-0.5" />}
            </button>

            <button
              onClick={() => seekForward(10)}
              aria-label="Forward 10s"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCw className="size-5" />
              <span className="sr-only">+10s</span>
            </button>

            <button
              onClick={() => next()}
              aria-label="Next story"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <SkipForward className="size-5 fill-current" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
