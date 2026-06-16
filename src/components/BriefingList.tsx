import { useState } from "react";
import { ChevronDown, ExternalLink, Play } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { BriefingTopic } from "@/lib/news/briefing.functions";

interface Props {
  topics: BriefingTopic[];
  onJumpTo?: (index: number) => void;
  activeIndex?: number | null;
}

export function BriefingList({ topics, onJumpTo, activeIndex }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (topics.length === 0) return null;
  return (
    <div className="w-full space-y-2">
      <div className="px-1 pb-2 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        All of today's stories · {topics.length}
      </div>
      {topics.map((t, i) => {
        const isOpen = openId === t.id;
        const isActive = activeIndex === i;
        return (
          <div
            key={t.id}
            className={`rounded-2xl border border-white/5 bg-white/[0.02] transition ${
              isActive ? "ring-1 ring-primary/40" : ""
            }`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => setOpenId(isOpen ? null : t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(isOpen ? null : t.id);
                }
              }}
              className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left"
            >
              <span className="mt-1 w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-serif text-base leading-snug text-foreground">
                  {t.headline}
                </p>
                {t.hook && (
                  <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">{t.hook}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                  <span>{t.sources.length} {t.sources.length === 1 ? "source" : "sources"}</span>
                  {onJumpTo && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onJumpTo(i); }}
                      className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 hover:bg-white/10 hover:text-foreground"
                    >
                      <Play className="size-2.5" /> Read aloud
                    </button>
                  )}
                </div>
              </div>
              <ChevronDown
                className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </div>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-3 px-4 pb-4 pl-[3.25rem] text-sm text-foreground/85">
                    {t.explanation && <p className="leading-relaxed">{t.explanation}</p>}
                    {t.whyItMatters && (
                      <p className="text-muted-foreground">
                        <span className="text-foreground/70">Why it matters — </span>
                        {t.whyItMatters}
                      </p>
                    )}
                    {t.sources.length > 0 && (
                      <ul className="space-y-1 pt-1">
                        {t.sources.map((s, j) => (
                          <li key={j}>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
                            >
                              <ExternalLink className="size-3" /> {s.name}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
