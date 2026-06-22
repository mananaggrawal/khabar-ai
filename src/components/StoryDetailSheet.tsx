/**
 * StoryDetailSheet — bottom sheet with story summary + external search links.
 * Opens when the user taps a story card (not the play button).
 */
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { X, ExternalLink, ArrowUpRight, Bookmark, Newspaper } from "lucide-react";
import type { Story } from "@/lib/news/generator";
import { FEED_MAP } from "@/lib/news/sources";
import { SECTION_COLOR } from "@/components/StoryCard";

interface StoryDetailSheetProps {
  story: Story | null;
  language: "en" | "hi";
  onClose: () => void;
  onPlay: () => void;
  isPlaying: boolean;
  isSaved?: boolean;
  onSave?: () => void;
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

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function PerplexityLogo() {
  return (
    <img
      src="https://www.google.com/s2/favicons?domain=perplexity.ai&sz=32"
      alt="Perplexity"
      className="size-5 rounded-sm"
    />
  );
}

function ChatGPTLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0L4.01 14.25A4.501 4.501 0 0 1 2.34 7.896zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.808 2.773a4.5 4.5 0 0 1-.676 8.122v-5.678a.79.79 0 0 0-.385-.666zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.806-2.772a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
    </svg>
  );
}

const SEARCH_ENGINES = [
  {
    name: "Google",
    Logo: GoogleLogo,
    url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Perplexity",
    Logo: PerplexityLogo,
    url: (q: string) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "ChatGPT",
    Logo: ChatGPTLogo,
    url: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  },
];

export function StoryDetailSheet({
  story,
  language,
  onClose,
  onPlay,
  isPlaying,
  isSaved,
  onSave,
}: StoryDetailSheetProps) {
  if (typeof document === "undefined") return null;

  const feed = story ? FEED_MAP.get(story.section) : null;
  const accent = story ? (SECTION_COLOR[story.section] ?? "#7B5CF0") : "#7B5CF0";
  const script = story
    ? (language === "hi" ? (story.scriptHi || story.scriptEn) : story.scriptEn) || null
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
            className="fixed inset-x-0 bottom-0 z-[56] flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-2xl"
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
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-primary/70 mb-1">
                    {language === "hi" ? feed.labelHi : feed.label}
                  </p>
                )}
                <p className="font-serif text-lg leading-snug text-foreground">
                  {language === "hi" ? (story.titleHi || story.title) : story.title}
                </p>
                {story.source && (
                  <p className="mt-1 text-xs text-muted-foreground">{story.source}</p>
                )}
              </div>
              <div className="ml-3 mt-0.5 flex shrink-0 items-center gap-1">
                {onSave && (
                  <button
                    onClick={onSave}
                    aria-label={isSaved ? "Unsave" : "Save"}
                    className="flex size-8 items-center justify-center rounded-full bg-muted transition-colors hover:text-foreground"
                  >
                    <Bookmark
                      className="size-4"
                      fill={isSaved ? "currentColor" : "none"}
                      style={isSaved ? { color: accent } : undefined}
                    />
                  </button>
                )}
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {/* Summary */}
              {script && (
                <div className="mb-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                    Summary
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/80">
                    {script}
                  </p>
                </div>
              )}

              {/* Sources */}
              {story.sources && story.sources.length > 0 && (
                <div className="mb-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                    Sources ({story.sources.length})
                  </p>
                  <div className="flex flex-col gap-2">
                    {story.sources.map((src, i) => (
                      <a
                        key={i}
                        href={src.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start justify-between rounded-2xl border border-border/40 bg-white shadow-sm px-4 py-3 gap-3 transition-all active:scale-[0.99] hover:shadow"
                      >
                        <div className="flex items-start gap-2.5 min-w-0">
                          <span className="shrink-0 mt-0.5 text-muted-foreground">
                            <Newspaper className="size-3.5" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-0.5">
                              {src.source}
                            </p>
                            <p className="text-xs text-foreground leading-snug line-clamp-2">
                              {src.title}
                            </p>
                          </div>
                        </div>
                        <ArrowUpRight className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Explore further */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Explore further
                </p>
                <div className="flex flex-col gap-2">
                  {SEARCH_ENGINES.map(({ name, Logo, url }) => (
                    <a
                      key={name}
                      href={url(story.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-2xl border border-border/40 bg-white shadow-sm px-4 py-3 text-sm font-medium text-foreground transition-all active:scale-[0.99] hover:shadow"
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="flex size-6 items-center justify-center">
                          <Logo />
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
