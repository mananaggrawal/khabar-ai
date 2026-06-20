import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { usePlayer } from "@/contexts/PlayerContext";
import {
  Play, Pause,
  Landmark, TrendingUp, Trophy, Cpu, Clapperboard,
  Globe, Heart, Radio, type LucideIcon,
} from "lucide-react";
import type { BriefingSection } from "@/lib/news/generator";

export const Route = createFileRoute("/_authenticated/browse")({
  head: () => ({ meta: [{ title: "Browse · Khabar AI" }] }),
  component: BrowsePage,
});

// ── Mirrors index.tsx catStyle ────────────────────────────────────────────────

interface CatStyle {
  Icon: LucideIcon;
  tileBg: string;
  tileText: string;
  iconBg: string;
  iconColor: string;
  orb: string;
}

const CAT_STYLES: Record<string, CatStyle> = {
  "india-national":      { Icon: Landmark,     tileBg: "bg-orange-100", tileText: "text-orange-700", iconBg: "bg-orange-200",  iconColor: "text-orange-700", orb: "rgba(234,88,12,0.2)"  },
  "india-business":      { Icon: TrendingUp,   tileBg: "bg-blue-100",   tileText: "text-blue-700",   iconBg: "bg-blue-200",    iconColor: "text-blue-700",   orb: "rgba(37,99,235,0.2)"  },
  "india-sports":        { Icon: Trophy,       tileBg: "bg-green-100",  tileText: "text-green-700",  iconBg: "bg-green-200",   iconColor: "text-green-700",  orb: "rgba(22,163,74,0.2)"  },
  "india-tech":          { Icon: Cpu,          tileBg: "bg-violet-100", tileText: "text-violet-700", iconBg: "bg-violet-200",  iconColor: "text-violet-700", orb: "rgba(124,58,237,0.2)" },
  "india-entertainment": { Icon: Clapperboard, tileBg: "bg-pink-100",   tileText: "text-pink-700",   iconBg: "bg-pink-200",    iconColor: "text-pink-700",   orb: "rgba(219,39,119,0.2)" },
  "global-world":        { Icon: Globe,        tileBg: "bg-sky-100",    tileText: "text-sky-700",    iconBg: "bg-sky-200",     iconColor: "text-sky-700",    orb: "rgba(2,132,199,0.2)"  },
  "global-business":     { Icon: TrendingUp,   tileBg: "bg-indigo-100", tileText: "text-indigo-700", iconBg: "bg-indigo-200",  iconColor: "text-indigo-700", orb: "rgba(79,70,229,0.2)"  },
  "global-sports":       { Icon: Trophy,       tileBg: "bg-emerald-100",tileText: "text-emerald-700",iconBg: "bg-emerald-200", iconColor: "text-emerald-700",orb: "rgba(16,185,129,0.2)" },
  "global-tech":         { Icon: Cpu,          tileBg: "bg-purple-100", tileText: "text-purple-700", iconBg: "bg-purple-200",  iconColor: "text-purple-700", orb: "rgba(147,51,234,0.2)" },
  "global-health":       { Icon: Heart,        tileBg: "bg-rose-100",   tileText: "text-rose-700",   iconBg: "bg-rose-200",    iconColor: "text-rose-700",   orb: "rgba(225,29,72,0.2)"  },
};

function catStyle(category: string): CatStyle {
  return (
    CAT_STYLES[category] ??
    { Icon: Radio, tileBg: "bg-muted", tileText: "text-muted-foreground", iconBg: "bg-muted", iconColor: "text-muted-foreground", orb: "rgba(100,100,100,0.1)" }
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function BrowsePage() {
  const { briefing, isLoading, mono, setShowPlayer } = usePlayer();
  const allSections = briefing?.sections ?? [];

  const indiaSections  = allSections.filter((s) => s.group === "india");
  const globalSections = allSections.filter((s) => s.group === "global");

  // Trending = first topic per section
  const trending = allSections.map((s) => ({
    section: s,
    topic: s.topics[0],
    globalIdx: mono.sectionsWithAudio.findIndex((sw) => sw.category === s.category),
  })).filter((x) => x.topic);

  return (
    <AppShell>
      <div className="max-w-xl mx-auto px-4">
        <header
          className="py-3"
          style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
        >
          <h1 className="font-serif text-xl font-medium text-foreground">Browse</h1>
        </header>

        {/* ── India tiles ── */}
        {(indiaSections.length > 0 || isLoading) && (
          <>
            <p className="text-xs text-muted-foreground uppercase tracking-[0.1em] mb-2.5">India</p>
            <div className="grid grid-cols-2 gap-2.5 mb-5">
              {isLoading
                ? [1, 2, 3, 4].map((i) => (
                    <div key={i} className="rounded-xl h-20 bg-muted animate-pulse" />
                  ))
                : indiaSections.map((s) => <CategoryTile key={s.category} section={s} />)}
            </div>
          </>
        )}

        {/* ── Global tiles ── */}
        {(globalSections.length > 0 || isLoading) && (
          <>
            <p className="text-xs text-muted-foreground uppercase tracking-[0.1em] mb-2.5">Global</p>
            <div className="grid grid-cols-2 gap-2.5 mb-6">
              {isLoading
                ? [1, 2, 3, 4].map((i) => (
                    <div key={i} className="rounded-xl h-20 bg-muted animate-pulse" />
                  ))
                : globalSections.map((s) => <CategoryTile key={s.category} section={s} />)}
            </div>
          </>
        )}

        {/* ── Trending now ── */}
        <p className="text-xs text-muted-foreground uppercase tracking-[0.1em] mb-2.5">Trending now</p>
        <div className="space-y-2 mb-6">
          {isLoading &&
            [1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-3 flex gap-3 animate-pulse">
                <div className="size-10 rounded-lg bg-muted flex-shrink-0" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-2 bg-muted rounded w-1/4" />
                  <div className="h-3 bg-muted rounded w-3/4" />
                </div>
              </div>
            ))}

          {trending.map(({ section, topic, globalIdx }, i) => {
            const isActive =
              mono.currentSectionIdx === globalIdx &&
              (mono.state === "playing" || mono.state === "paused");
            const isPlaying =
              mono.currentSectionIdx === globalIdx && mono.state === "playing";
            const { Icon, iconBg, iconColor } = catStyle(section.category);

            return (
              <div
                key={section.category}
                className={`rounded-xl border p-3 flex items-center gap-3 transition-colors ${
                  isActive ? "border-primary/30 bg-primary/5" : "border-border bg-card"
                }`}
              >
                <div className={`size-10 rounded-lg flex-shrink-0 flex items-center justify-center ${iconBg}`}>
                  <Icon className={`size-4 ${iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] tracking-[0.1em] text-muted-foreground uppercase mb-0.5">
                    {section.label}
                  </p>
                  <p className="text-sm text-foreground line-clamp-2 leading-snug">
                    {topic.headline}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (globalIdx >= 0 && section.audioUrl) {
                      mono.playSection(globalIdx);
                      setShowPlayer(true);
                    }
                  }}
                  disabled={!section.audioUrl}
                  className={`size-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-30 ${
                    isActive ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-primary/10"
                  }`}
                >
                  {isPlaying
                    ? <Pause className="size-3.5" />
                    : <Play className="size-3.5 ml-0.5" />}
                </button>
              </div>
            );
          })}

          {trending.length === 0 && !isLoading && (
            <p className="text-sm text-muted-foreground text-center py-6">
              Today's briefing isn't ready yet.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Category tile (2-col grid) ────────────────────────────────────────────────

function CategoryTile({ section }: { section: BriefingSection }) {
  const { mono, setShowPlayer } = usePlayer();
  const globalIdx = mono.sectionsWithAudio.findIndex((s) => s.category === section.category);
  const { Icon, tileBg, tileText, iconColor, orb } = catStyle(section.category);

  function handleTap() {
    if (globalIdx >= 0 && section.audioUrl) {
      mono.playSection(globalIdx);
      setShowPlayer(true);
    }
  }

  return (
    <button
      onClick={handleTap}
      className={`rounded-xl p-3.5 text-left relative overflow-hidden active:scale-[0.97] transition-transform ${tileBg}`}
      style={{
        background: `radial-gradient(ellipse 60% 60% at 80% 20%, ${orb}, transparent 70%)`,
      }}
    >
      <div
        className={`size-8 rounded-lg flex items-center justify-center mb-2 bg-white/50`}
      >
        <Icon className={`size-4 ${iconColor}`} />
      </div>
      <p className={`text-xs font-semibold leading-tight ${tileText}`}>
        {section.label}
      </p>
      <p className="text-[9px] text-muted-foreground mt-0.5">
        {section.topics.length} stories
      </p>
    </button>
  );
}
