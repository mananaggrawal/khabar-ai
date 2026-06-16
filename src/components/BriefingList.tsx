import { useState } from "react";
import { ChevronDown, ExternalLink, Play } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { BriefingTopic, BriefingTier } from "@/lib/news/briefing.functions";

interface Props {
  topics: BriefingTopic[];
  onJumpTo?: (index: number) => void;
  activeIndex?: number | null;
  homeLabel?: string;
}

export function BriefingList({ topics, onJumpTo, activeIndex, homeLabel = "Home" }: Props) {
  if (topics.length === 0) return null;

  // Preserve original index across the flat list for onJumpTo / activeIndex.
  const indexed = topics.map((t, i) => ({ t, i }));
  const home = indexed.filter((x) => x.t.tier === "home");
  const world = indexed.filter((x) => x.t.tier === "world");
  const quick = indexed.filter((x) => x.t.tier === "quick_hit");

  return (
    <div className="w-full space-y-8">
      {home.length > 0 && (
        <Section
          title={`From ${homeLabel}`}
          subtitle={`${home.length} ${home.length === 1 ? "story" : "stories"}`}
          items={home}
          onJumpTo={onJumpTo}
          activeIndex={activeIndex}
          variant="deep"
        />
      )}
      {world.length > 0 && (
        <Section
          title="Around the world"
          subtitle={`${world.length} ${world.length === 1 ? "story" : "stories"}`}
          items={world}
          onJumpTo={onJumpTo}
          activeIndex={activeIndex}
          variant="deep"
        />
      )}
      {quick.length > 0 && (
        <Section
          title="Quick hits"
          subtitle={`${quick.length} bullets`}
          items={quick}
          onJumpTo={onJumpTo}
          activeIndex={activeIndex}
          variant="quick"
        />
      )}
    </div>
  );
}

function Section({
  title, subtitle, items, onJumpTo, activeIndex, variant,
}: {
  title: string;
  subtitle: string;
  items: { t: BriefingTopic; i: number }[];
  onJumpTo?: (index: number) => void;
  activeIndex?: number | null;
  variant: "deep" | "quick";
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between px-1">
        <h2 className="font-serif text-lg tracking-tight">{title}</h2>
        <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{subtitle}</span>
      </div>
      <div className="space-y-2">
        {items.map(({ t, i }) =>
          variant === "deep" ? (
            <DeepCard
              key={t.id}
              topic={t}
              index={i}
              active={activeIndex === i}
              onJumpTo={onJumpTo}
            />
          ) : (
            <QuickRow
              key={t.id}
              topic={t}
              index={i}
              active={activeIndex === i}
              onJumpTo={onJumpTo}
            />
          ),
        )}
      </div>
    </section>
  );
}

function DeepCard({
  topic: t, index: i, active, onJumpTo,
}: { topic: BriefingTopic; index: number; active: boolean; onJumpTo?: (index: number) => void }) {
  const [open, setOpen] = useState(false);
  const hasMore = !!(t.explanation || t.whyItMatters || t.sources.length || (t.followUps && t.followUps.length));
  return (
    <div
      className={`rounded-2xl border border-white/5 bg-white/[0.02] transition ${
        active ? "ring-1 ring-primary/40" : ""
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => hasMore && setOpen(!open)}
        onKeyDown={(e) => {
          if (hasMore && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left"
      >
        <span className="mt-1 w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
          {String(i + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-serif text-base leading-snug text-foreground">{t.headline}</p>
          {t.hook && (
            <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">{t.hook}</p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
            {t.sources.length > 0 && (
              <span>
                {t.sources.length} {t.sources.length === 1 ? "source" : "sources"}
              </span>
            )}
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
        {hasMore && (
          <ChevronDown
            className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && hasMore && (
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
              {t.followUps && t.followUps.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {t.followUps.map((q, j) => (
                    <li key={j}>· {q}</li>
                  ))}
                </ul>
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
}

function QuickRow({
  topic: t, index: i, active, onJumpTo,
}: { topic: BriefingTopic; index: number; active: boolean; onJumpTo?: (index: number) => void }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.015] px-4 py-2.5 ${
        active ? "ring-1 ring-primary/40" : ""
      }`}
    >
      <span className="mt-0.5 w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
        {String(i + 1).padStart(2, "0")}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-foreground">{t.headline}</p>
        {t.hook && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{t.hook}</p>}
      </div>
      {onJumpTo && (
        <button
          type="button"
          onClick={() => onJumpTo(i)}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-white/10 hover:text-foreground"
        >
          <Play className="size-2.5" />
        </button>
      )}
    </div>
  );
}

export type { BriefingTier };
