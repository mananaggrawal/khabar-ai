import { createFileRoute } from "@tanstack/react-router";
import { Bookmark, Trash2 } from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import { useSavedStories } from "@/hooks/useSavedStories";
import { FEED_MAP } from "@/lib/news/sources";
import { SECTION_COLOR } from "@/components/StoryCard";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "Saved · Khabar AI" }] }),
  component: SavedPage,
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterdayStr = new Date(now.getTime() - 86_400_000).toDateString();
  if (date.toDateString() === todayStr) return "Today";
  if (date.toDateString() === yesterdayStr) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long" });
}

function SavedPage() {
  const { saved, remove } = useSavedStories();

  // Group by saved date
  const groups: { label: string; stories: typeof saved }[] = [];
  for (const story of saved) {
    const label = formatDate(story.savedAt);
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.stories.push(story);
    else groups.push({ label, stories: [story] });
  }

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
        <h1 className="font-serif text-2xl mb-1">Saved</h1>
        <p className="text-xs text-muted-foreground mb-5">
          {saved.length > 0 ? `${saved.length} saved ${saved.length === 1 ? "story" : "stories"}` : "Stories you save appear here"}
        </p>

        {saved.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            <Bookmark className="size-10 text-muted-foreground/25" />
            <p className="text-sm font-medium text-foreground/50">Nothing saved yet</p>
            <p className="text-xs text-muted-foreground/60">
              Tap the bookmark on any story to save it here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map(({ label, stories }) => (
              <section key={label}>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-2 px-1">
                  {label}
                </p>
                <div className="flex flex-col gap-1.5">
                  {stories.map((story) => {
                    const feed = FEED_MAP.get(story.section);
                    const accent = SECTION_COLOR[story.section] ?? "#7B5CF0";
                    return (
                      <div
                        key={story.id}
                        className="flex items-center gap-3 rounded-2xl bg-white shadow-sm px-3 py-3 border-l-[3px]"
                        style={{ borderLeftColor: accent }}
                      >
                        {/* Thumbnail */}
                        {story.imageUrl ? (
                          <img
                            src={story.imageUrl}
                            alt=""
                            className="h-[48px] w-[48px] shrink-0 rounded-xl object-cover shadow-sm"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div
                            className="h-[48px] w-[48px] shrink-0 rounded-xl"
                            style={{ backgroundColor: `${accent}18` }}
                          />
                        )}

                        {/* Text */}
                        <div className="min-w-0 flex-1">
                          <p
                            className="mb-0.5 text-[10px] font-bold uppercase tracking-widest"
                            style={{ color: accent }}
                          >
                            {feed?.label ?? story.section}
                          </p>
                          <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
                            {story.title}
                          </p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground/50">
                            Saved {new Date(story.savedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>

                        {/* Remove */}
                        <button
                          onClick={() => remove(story.id)}
                          aria-label="Remove"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/40 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
