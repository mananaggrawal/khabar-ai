import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Calendar } from "lucide-react";
import { listBriefings } from "@/lib/news/briefing.functions";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "History · Khabar AI" }] }),
  component: HistoryPage,
});

function HistoryPage() {
  const fn = useServerFn(listBriefings);
  const q = useQuery({ queryKey: ["history"], queryFn: () => fn({ data: undefined as never }) });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-6"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)" }}>
        <Link to="/" className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-serif text-2xl tracking-tight">Past briefings</h1>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.data && q.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No briefings yet.</p>
        )}
        <ul className="space-y-3">
          {q.data?.map((b) => (
            <li key={b.date}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Calendar className="size-4 text-muted-foreground" />
                  {new Date(b.date + "T12:00:00").toLocaleDateString(undefined, {
                    weekday: "long", month: "long", day: "numeric",
                  })}
                </div>
                <span className="text-xs text-muted-foreground">
                  {b.sections} sections · {b.totalTopics} stories
                </span>
              </div>
              {b.generatedAt && (
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Generated {new Date(b.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </p>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
