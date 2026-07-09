/**
 * AppHeader — the top logo/tagline/share bar, identical on every page
 * (2026-07-09). Previously each route (Home, Saved, Settings) hand-copied
 * this markup, and only Home actually had the share/invite button — Saved
 * and Settings silently drifted from it. Single source of truth now; the
 * invite link/userId fetch lives here too so the button works the same way
 * regardless of which page mounts it.
 */
import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { track } from "@/lib/analytics/track";
import { EVENTS } from "@/lib/analytics/events";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

export function AppHeader() {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    if (LOCAL_MODE) return;
    import("@/integrations/supabase/client")
      .then(({ supabase }) => supabase.auth.getUser())
      .then(({ data }) => setUserId(data?.user?.id ?? null))
      .catch(() => {});
  }, []);

  async function handleInvite() {
    const code = userId ?? "";
    const url = `${window.location.origin}/?ref=${code}`;
    const text = "I listen to my daily news on Khabar AI — it reads the day's top stories to me in a few minutes. Give it a try:";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Khabar AI", text, url });
      } else {
        await navigator.clipboard.writeText(url);
        alert("Link copied — share it with a friend!");
      }
      track(EVENTS.INVITE_SHARED);
    } catch { /* user cancelled the share sheet */ }
  }

  return (
    <header
      className="sticky top-0 z-20 flex items-center justify-between px-5 pb-3 bg-background/95 backdrop-blur-sm"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
    >
      <span className="font-serif text-xl tracking-tight">
        Khabar <em className="italic text-primary">AI</em>
      </span>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Today's news, <em className="font-semibold italic">spoken.</em>
        </span>
        <button
          onClick={handleInvite}
          aria-label="Invite a friend"
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
        >
          <Share2 className="size-4" />
        </button>
      </div>
    </header>
  );
}
