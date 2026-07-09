import { createFileRoute } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bookmark, Play, Pause, SkipBack, SkipForward, RotateCcw, RotateCw } from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import { AppHeader } from "@/components/AppHeader";
import { StoryCard } from "@/components/StoryCard";
import { StoryDetailSheet } from "@/components/StoryDetailSheet";
import { useSavedStories } from "@/hooks/useSavedStories";
import { useMonologue, getStoryTitle, getSectionLabel, getAudioUrl } from "@/hooks/useMonologue";
import { usePlayer } from "@/context/player";
import { resolveSection } from "@/lib/news/sources";
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

// Mini player for the saved page (2026-07-09 — same two-row layout as the
// global one in player.tsx: row 1 opens the now-playing summary, row 2 has
// a draggable scrub bar + prev/-10s/play-pause/+10s/next).
function SavedMiniPlayer({ mono, onOpen }: { mono: ReturnType<typeof useMonologue>; onOpen: () => void }) {
  if (typeof document === "undefined") return null;
  const { state, progress, currentStory, currentFeed, pause, resume, prev, next, seek, seekBackward, seekForward, language } = mono;
  const visible = state === "playing" || state === "paused";
  const isPlaying = state === "playing";

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 320 }}
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 62px)" }}
          className="fixed inset-x-3 z-50"
        >
          <div className="relative overflow-hidden rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-xl">
            <div className="flex items-center gap-3 px-4 pt-3 pb-1.5 cursor-pointer" onClick={onOpen}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentFeed ? getSectionLabel(currentFeed, language) : "Playing"}
                </p>
                <p className="truncate text-sm font-medium text-foreground leading-tight">
                  {currentStory ? getStoryTitle(currentStory, language) : "—"}
                </p>
              </div>
            </div>
            <div className="px-4 pb-3">
              <input
                type="range" min={0} max={1} step={0.001} value={progress}
                onChange={(e) => seek(parseFloat(e.target.value))}
                aria-label="Seek"
                className="w-full h-1 cursor-pointer rounded-full accent-primary"
                style={{ background: `linear-gradient(to right, var(--primary) ${progress * 100}%, oklch(0 0 0 / 0.12) ${progress * 100}%)` }}
              />
              <div className="mt-2 flex items-center justify-center gap-5">
                <button onClick={prev} aria-label="Previous story" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <SkipBack className="size-4 fill-current" />
                </button>
                <button onClick={() => seekBackward(10)} aria-label="Rewind 10s" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <RotateCcw className="size-4" />
                </button>
                <button onClick={isPlaying ? pause : resume} aria-label={isPlaying ? "Pause" : "Play"}
                  className="flex size-10 items-center justify-center rounded-full bg-primary text-white transition-transform active:scale-95">
                  {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                </button>
                <button onClick={() => seekForward(10)} aria-label="Forward 10s" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <RotateCw className="size-4" />
                </button>
                <button onClick={next} aria-label="Next story" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
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
  const { briefing: liveBriefing } = usePlayer();
  const [detailStory, setDetailStory] = useState<Story | null>(null);
  // "Now playing" summary popup (2026-07-09 — replaces the removed
  // full-screen PlayerScreen), separate from `detailStory` above which is
  // for tapping a card to preview a story that may not be playing at all.
  // Opening this always shows mono.currentStory live, so it follows
  // playback as it advances rather than staying pinned to a snapshot.
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);

  // Saved stories are a snapshot taken at save time (useSavedStories writes the
  // full story object into Supabase). If that story's script/title/audio is
  // later corrected — e.g. via the admin "patch scripts" action, which now
  // clears and regenerates translations/audio (2026-07-05) — the saved
  // snapshot would otherwise keep showing the OLD content forever, since it's
  // a copy, not a live reference. Where today's briefing still has the same
  // story id, prefer its current fields over the stale snapshot; keep the
  // original savedAt so grouping/sorting by save date is unaffected.
  const liveById = new Map((liveBriefing?.stories ?? []).map((s) => [s.id, s]));
  const freshSaved = saved.map((s) => {
    const live = liveById.get(s.id);
    return live ? { ...live, savedAt: s.savedAt } : s;
  });

  // Build synthetic briefing from saved stories so useMonologue can play them
  const syntheticBriefing: DailyBriefing | null = freshSaved.length > 0
    ? { date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), stories: freshSaved }
    : null;

  const mono = useMonologue({ briefing: syntheticBriefing });

  useEffect(() => { if (mono.state === "idle") setNowPlayingOpen(false); }, [mono.state]);

  // Group by save date
  const groups: { label: string; stories: typeof freshSaved }[] = [];
  for (const story of freshSaved) {
    const label = formatGroup(story.savedAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.stories.push(story); else groups.push({ label, stories: [story] });
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header — shared across every page, see AppHeader.tsx */}
      <AppHeader />

      {/* BUG FIX (2026-07-09): this page was the one route missing an inner
          overflow-y-auto scroll container — Home and Settings both scroll an
          inner div, while this <main> previously let the real document/body
          scroll instead. That's exactly the kind of thing that makes iOS
          Safari's position:fixed elements (BottomNav, the mini-player) visibly
          drift/jump during scroll, since they're reliably anchored to the
          viewport only when the page itself never natively scrolls. */}
      <main
        className="flex-1 overflow-y-auto px-4 py-4"
        // Bumped 148 → 220px (2026-07-09) — same mini-player-grew-taller fix
        // as Home, see routes/index.tsx.
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 220px)" }}
      >
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
                    const hasAudio = !!getAudioUrl(story, mono.language);
                    const storyIdx = mono.storiesWithAudio.findIndex((s) => s.id === story.id);
                    const isActive = mono.currentStory?.id === story.id;
                    return (
                      <StoryCard
                        key={story.id}
                        story={story}
                        language={mono.language}
                        isPlaying={isActive && mono.state === "playing"}
                        hasAudio={hasAudio}
                        onPlay={() => storyIdx >= 0 && mono.playFromInSection(storyIdx, resolveSection(story.section))}
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
      <SavedMiniPlayer mono={mono} onOpen={() => setNowPlayingOpen(true)} />

      {/* Unified with the preview sheet below — nowPlayingOpen (tapped the
          mini player) takes precedence and always shows the live current
          story; otherwise falls back to whatever card was tapped to preview
          (2026-07-09, replaces the removed full-screen PlayerScreen). */}
      <StoryDetailSheet
        story={nowPlayingOpen ? mono.currentStory : detailStory}
        language={mono.language}
        onClose={() => { setNowPlayingOpen(false); setDetailStory(null); }}
        onPlay={() => {
          if (nowPlayingOpen) {
            mono.state === "playing" ? mono.pause() : mono.resume();
            return;
          }
          if (detailStory) {
            const idx = mono.storiesWithAudio.findIndex((s) => s.id === detailStory.id);
            if (idx >= 0) mono.playFromInSection(idx, resolveSection(detailStory.section));
          }
          setDetailStory(null);
        }}
        isPlaying={
          nowPlayingOpen
            ? mono.state === "playing"
            : !!detailStory && mono.currentStory?.id === detailStory.id && mono.state === "playing"
        }
        isSaved={
          nowPlayingOpen
            ? (mono.currentStory ? isSaved(mono.currentStory.id) : false)
            : (detailStory ? isSaved(detailStory.id) : false)
        }
        onSave={() => {
          const target = nowPlayingOpen ? mono.currentStory : detailStory;
          if (target) toggle(target);
        }}
      />
    </div>
  );
}
