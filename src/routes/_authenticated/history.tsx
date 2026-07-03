import { createFileRoute } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bookmark, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import { StoryCard } from "@/components/StoryCard";
import { StoryDetailSheet } from "@/components/StoryDetailSheet";
import { PlayerScreen } from "@/components/PlayerScreen";
import { useSavedStories } from "@/hooks/useSavedStories";
import { useMonologue } from "@/hooks/useMonologue";
import type { DailyBriefing, Story } from "@/lib/news/generator";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "Saved · Khabar AI" }] }),
  component: SavedPage,
});

function formatGroup(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long" });
}

// Mini player for the saved page
function SavedMiniPlayer({ mono, onOpen, flush = false }: { mono: ReturnType<typeof useMonologue>; onOpen: () => void; flush?: boolean }) {
  if (typeof document === "undefined") return null;
  const { state, progress, currentStory, currentFeed, pause, resume, language } = mono;
  const visible = state === "playing" || state === "paused";
  const isPlaying = state === "playing";

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 320 }}
          style={{ bottom: flush ? "calc(env(safe-area-inset-bottom, 0px) + 12px)" : "calc(env(safe-area-inset-bottom, 0px) + 62px)" }}
          // z-[58]: above the story-detail summary drawer (z-55/56) so play/pause
          // stays reachable while it's open, but below the full-screen player (z-60).
          className="fixed inset-x-3 z-[58]"
        >
          <div className="relative overflow-hidden rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-xl cursor-pointer" onClick={onOpen}>
            <div className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300" style={{ width: `${progress * 100}%` }} />
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentFeed ? (language === "hi" ? currentFeed.labelHi : currentFeed.label) : "Playing"}
                </p>
                <p className="truncate text-sm font-medium text-foreground leading-tight">{currentStory?.title ?? "—"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => mono.prev()} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <SkipBack className="size-4 fill-current" />
                </button>
                <button onClick={isPlaying ? pause : resume}
                  className="flex size-8 items-center justify-center rounded-full bg-primary text-white transition-transform active:scale-95">
                  {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                </button>
                <button onClick={() => mono.next()} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <SkipForward className="size-4 fill-current" />
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function SavedPage() {
  const { saved, loading, isSaved, toggle, remove } = useSavedStories();
  const [detailStory, setDetailStory] = useState<Story | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);

  // Build synthetic briefing from saved stories so useMonologue can play them
  const syntheticBriefing: DailyBriefing | null = saved.length > 0
    ? { date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), stories: saved }
    : null;

  const mono = useMonologue({ briefing: syntheticBriefing });

  useEffect(() => { if (mono.state === "idle") setPlayerOpen(false); }, [mono.state]);

  // Group by save date
  const groups: { label: string; stories: typeof saved }[] = [];
  for (const story of saved) {
    const label = formatGroup(story.savedAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.stories.push(story); else groups.push({ label, stories: [story] });
  }

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 148px)" }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-5 pb-2 bg-background/95 backdrop-blur-sm"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <span className="text-xs text-muted-foreground">
          Today's news, <em className="font-semibold italic">spoken.</em>
        </span>
      </header>

      <main className="flex-1 px-4 py-4">
        <h1 className="font-serif text-2xl mb-1">Saved</h1>
        <p className="text-xs text-muted-foreground mb-5">
          {saved.length > 0
            ? `${saved.length} saved ${saved.length === 1 ? "story" : "stories"}`
            : "Stories you save appear here"}
        </p>

        {loading && (
          <div className="flex flex-col gap-2 mt-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-[76px] rounded-2xl bg-black/[0.04] animate-pulse" />
            ))}
          </div>
        )}

        {!loading && saved.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            <Bookmark className="size-10 text-muted-foreground/25" />
            <p className="text-sm font-medium text-foreground/50">Nothing saved yet</p>
            <p className="text-xs text-muted-foreground/60">
              Tap the bookmark inside any story to save it here.
            </p>
          </div>
        )}

        {!loading && groups.length > 0 && (
          <div className="flex flex-col gap-6">
            {groups.map(({ label, stories }) => (
              <section key={label}>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-2 px-1">
                  {label}
                </p>
                <div className="flex flex-col gap-1.5">
                  {stories.map((story) => {
                    const hasAudio = mono.language === "hi" ? !!story.audioUrlHi
                      : mono.language === "ta" ? !!story.audioUrlTa
                      : mono.language === "mr" ? !!story.audioUrlMr
                      : !!story.audioUrlEn;
                    const storyIdx = mono.storiesWithAudio.findIndex((s) => s.id === story.id);
                    const isActive = mono.currentStory?.id === story.id;
                    return (
                      <StoryCard
                        key={story.id}
                        story={story}
                        isPlaying={isActive && mono.state === "playing"}
                        hasAudio={hasAudio}
                        onPlay={() => storyIdx >= 0 && mono.playFromInSection(storyIdx, story.section)}
                        onPause={mono.pause}
                        onTap={() => setDetailStory(story)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      <BottomNav />
      <SavedMiniPlayer mono={mono} onOpen={() => setPlayerOpen(true)} flush={!!detailStory} />

      <PlayerScreen
        mono={mono}
        visible={playerOpen}
        onClose={() => setPlayerOpen(false)}
        isSaved={mono.currentStory ? isSaved(mono.currentStory.id) : false}
        onSave={() => mono.currentStory && toggle(mono.currentStory)}
      />

      <StoryDetailSheet
        story={detailStory}
        language={mono.language}
        onClose={() => setDetailStory(null)}
        onPlay={() => {
          if (detailStory) {
            const idx = mono.storiesWithAudio.findIndex((s) => s.id === detailStory.id);
            if (idx >= 0) mono.playFromInSection(idx, detailStory.section);
          }
          setDetailStory(null);
        }}
        isPlaying={!!detailStory && mono.currentStory?.id === detailStory.id && mono.state === "playing"}
        isSaved={detailStory ? isSaved(detailStory.id) : false}
        onSave={() => detailStory && toggle(detailStory)}
      />
    </div>
  );
}
