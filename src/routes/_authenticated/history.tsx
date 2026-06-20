import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock } from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import { fetchBriefing } from "@/lib/news/briefing.functions";
import { FEED_MAP } from "@/lib/news/sources";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "History · Khabar AI" }] }),
  component: HistoryPage,
});

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function HistoryPage() {
  const fn = useServerFn(fetchBriefing);
  const { data: briefing, isLoading } = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fn({ data: undefined as never }),
    staleTime: 5 * 60_000,
  });

  const today = briefing
    ? new Date(briefing.generatedAt).toLocaleDateString("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      })
    : null;

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 72px)" }}
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
        <h1 className="font-serif text-2xl mb-1">History</h1>
        <p className="text-xs text-muted-foreground mb-5">Your past briefings</p>

        {isLoading && (
          <div className="flex flex-col gap-2 mt-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 rounded-2xl bg-black/[0.04] animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && !briefing && (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
            <Clock className="size-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground/60">No briefings yet</p>
            <p className="text-xs text-muted-foreground">
              Generate one from the home screen.
            </p>
          </div>
        )}

        {briefing && (
          <div className="rounded-2xl border border-border/40 bg-white shadow-sm overflow-hidden">
            {/* Briefing header */}
            <div className="px-4 py-3 border-b border-border/30">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary/70 mb-0.5">
                Latest Briefing
              </p>
              <p className="text-sm font-medium text-foreground">{today}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {briefing.stories.length} stories · {timeAgo(briefing.generatedAt)}
              </p>
            </div>

            {/* Story list */}
            <div className="divide-y divide-border/20">
              {briefing.stories.map((story) => {
                const feed = FEED_MAP.get(story.section);
                return (
                  <div key={story.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
                        {feed?.label ?? story.section}
                      </p>
                      <p className="text-sm text-foreground line-clamp-1">{story.title}</p>
                    </div>
                    <p className="shrink-0 text-[10px] text-muted-foreground/50">
                      {timeAgo(story.publishedAt)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
