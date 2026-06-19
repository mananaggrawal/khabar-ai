import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Clock } from "lucide-react";
import { listBriefings } from "@/lib/voice/messages.functions";
import type { BriefingTopic } from "@/lib/news/briefing.functions";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "History · Khabar AI" }] }),
  component: HistoryPage,
});

function HistoryPage() {
  const fn = useServerFn(listBriefings);
  const q = useQuery({ queryKey: ["history"], queryFn: () => fn({ data: undefined as never }) });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-6 pt-6">
        <Link to="/" className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-serif text-2xl tracking-tight">Past briefings</h1>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.data && q.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No briefings yet. Head back and tap the orb.</p>
        )}
        <ul className="space-y-3">
          {q.data?.map((b: any) => {
            const topics = (b.topics as unknown as BriefingTopic[]) ?? [];
            return (
              <li
                key={b.id}
                className="group rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:bg-white/[0.06]"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="size-3.5" />
                  {new Date(b.generated_at).toLocaleString(undefined, {
                    weekday: "short", month: "short", day: "numeric",
                    hour: "numeric", minute: "2-digit",
                  })}
                  <span>· {topics.length} topics</span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {topics.slice(0, 4).map((t, i) => (
                    <p key={i} className="font-serif text-base leading-snug text-foreground/90">
                      {t.headline}
                    </p>
                  ))}
                  {topics.length > 4 && (
                    <p className="text-xs text-muted-foreground">+{topics.length - 4} more</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
