/**
 * StoryDetailSheet — bottom sheet with story summary + external search links.
 * Opens when the user taps a story card (not the play button).
 */
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { X, ExternalLink, ArrowUpRight } from "lucide-react";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP } from "@/lib/news/sources";

interface StoryDetailSheetProps {
  story: Story | null;
  language: "en" | "hi";
  onClose: () => void;
  onPlay: () => void;
  isPlaying: boolean;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const SEARCH_ENGINES = [
  {
    name: "Google",
    color: "#4285F4",
    url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Perplexity",
    color: "#20808D",
    url: (q: string) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "ChatGPT",
    color: "#10A37F",
    url: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  },
];

export function StoryDetailSheet({
  story,
  language,
  onClose,
  onPlay,
  isPlaying,
}: StoryDetailSheetProps) {
  if (typeof document === "undefined") return null;

  const feed = story ? FEED_MAP.get(story.section) : null;
  const script = story
    ? (language === "hi" ? story.scriptHi : story.scriptEn) ?? story.scriptEn
    : null;

  return createPortal(
    <AnimatePresence>
      {story && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[55] bg-black/30 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            key="sheet"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-[56] flex max-h-[85vh] flex-col rounded-t-3xl bg-background shadow-2xl"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-border" />
            </div>

            {/* Header */}
            <div className="flex items-start justify-between px-5 py-3">
              <div className="flex-1 min-w-0">
                {feed && (
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-primary/70 mb-1">
                    {language === "hi" ? feed.labelHi : feed.label}
                  </p>
                )}
                <p className="font-serif text-lg leading-snug text-foreground">
                  {story.title}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {story.source} · {timeAgo(story.publishedAt)}
                  </span>
                  {story.link && (
                    <a
                      href={story.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                    >
                      Go to article <ArrowUpRight className="size-3" />
                    </a>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="ml-3 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {/* Summary */}
              {script && (
                <div className="mb-5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Summary
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/80">
                    {script}
                  </p>
                </div>
              )}

              {/* Explore further */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Explore further
                </p>
                <div className="flex flex-col gap-2">
                  {SEARCH_ENGINES.map(({ name, color, url }) => (
                    <a
                      key={name}
                      href={url(story.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-2xl border border-border/40 bg-white shadow-sm px-4 py-3 text-sm font-medium text-foreground transition-all active:scale-[0.99] hover:shadow"
                    >
                      <span className="flex items-center gap-2.5">
                        <span
                          className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ backgroundColor: color }}
                        >
                          {name[0]}
                        </span>
                        Search on {name}
                      </span>
                      <ExternalLink className="size-3.5 text-muted-foreground" />
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
