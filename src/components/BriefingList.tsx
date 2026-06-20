import { useState, type CSSProperties } from "react";
import { ChevronDown, ExternalLink, Play, Pause } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { BriefingTopic } from "@/lib/news/generator";

interface Props {
  topics: BriefingTopic[];
  currentTopicId?: string;
  playingState?: "playing" | "paused" | "idle";
  onPlay?: (topicId: string) => void;
  onPause?: () => void;
}

export function BriefingList({ topics, currentTopicId, playingState = "idle", onPlay, onPause }: Props) {
  if (topics.length === 0) return null;
  return (
    <div className="space-y-2">
      {topics.map((t, i) => (
        <TopicCard
          key={t.id}
          topic={t}
          index={i}
          isActive={t.id === currentTopicId}
          playingState={t.id === currentTopicId ? playingState : "idle"}
          onPlay={onPlay ? () => onPlay(t.id) : undefined}
          onPause={onPause}
        />
      ))}
    </div>
  );
}

// ── Brand logos ───────────────────────────────────────────────────────────────

function PerplexityLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 .014L.086 6.9v13.771h2.157V8.256L12 2.443l9.757 5.813v12.415h2.157V6.9L12 .014zm.643 11.104V8.63h-1.286v2.488L7.51 8.63 6.867 9.7l3.87 2.3-3.87 2.3.643 1.072 3.847-2.288v2.488h1.286v-2.488l3.847 2.288.643-1.072-3.87-2.3 3.87-2.3z" />
    </svg>
  );
}

function ChatGPTLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

// ── Deep-dive services ────────────────────────────────────────────────────────

const SERVICES: {
  name: string;
  Logo: (props: { className?: string }) => JSX.Element;
  color: string;
  url: (q: string) => string;
}[] = [
  {
    name: "Perplexity",
    Logo: PerplexityLogo,
    color: "#20B8CD",
    url: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "ChatGPT",
    Logo: ChatGPTLogo,
    color: "#10A37F",
    url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Google",
    Logo: GoogleLogo,
    color: "transparent",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
];


function buildQuery(t: BriefingTopic): string {
  // Concise but context-rich prompt — auto-submitted as-is
  const base = t.explanation
    ? `${t.headline}. ${t.explanation}`
    : t.headline;
  return `${base} — explain the full background, key players, and what happens next.`;
}

// ── Waveform animation (for currently playing story) ─────────────────────────

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

// ── Topic card ────────────────────────────────────────────────────────────────

interface TopicCardProps {
  topic: BriefingTopic;
  index: number;
  isActive?: boolean;
  playingState?: "playing" | "paused" | "idle";
  onPlay?: () => void;
  onPause?: () => void;
}

function TopicCard({ topic: t, index: i, isActive, playingState = "idle", onPlay, onPause }: TopicCardProps) {
  const [open, setOpen] = useState(false);
  const query = buildQuery(t);
  const hasAudio = !!(onPlay);
  const isPlaying = isActive && playingState === "playing";
  const isPaused = isActive && playingState === "paused";

  function handlePlayPause(e: React.MouseEvent) {
    e.stopPropagation();
    if (isPlaying) onPause?.();
    else onPlay?.();
  }

  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
      {/* Header row */}
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none"
      >
        {/* Play / pause button (left) */}
        {hasAudio ? (
          <button
            onClick={handlePlayPause}
            aria-label={isPlaying ? "Pause" : "Play"}
            className={`mt-1 flex size-5 shrink-0 items-center justify-center outline-none transition-colors ${
              isActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isPlaying ? <WaveformIcon /> : <Play className="size-3.5 ml-0.5" />}
          </button>
        ) : (
          <span className="mt-1 w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
            {String(i + 1).padStart(2, "0")}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="font-serif text-base leading-snug">{t.headline}</p>
          {t.hook && <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">{t.hook}</p>}
        </div>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </div>

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-4 pb-4 pl-[3.25rem]">
              {/* Explanation */}
              {t.explanation && (
                <p className="text-sm leading-relaxed text-foreground/85">{t.explanation}</p>
              )}

              {/* Source link */}
              {t.sourceUrl && (
                <a
                  href={t.sourceUrl} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  <ExternalLink className="size-3" />
                  Go to article
                </a>
              )}

              {/* Go deeper */}
              <div className="pt-1">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground/40">
                  Go deeper
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {SERVICES.map((svc) => (
                    <a
                      key={svc.name}
                      href={svc.url(query)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={`Open in ${svc.name}`}
                      className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-foreground"
                    >
                      <span
                        className="inline-flex shrink-0"
                        style={svc.color !== "transparent" ? { color: svc.color } as CSSProperties : undefined}
                      >
                        <svc.Logo className="size-3.5" />
                      </span>
                      {svc.name}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
