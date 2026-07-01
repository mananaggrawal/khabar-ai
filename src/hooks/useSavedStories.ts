import { useState, useEffect, useCallback } from "react";
import type { Story } from "@/lib/news/generator";

export type SavedStory = Story & { savedAt: string };

const LOCAL_KEY = "khabar-saved-stories";
const IS_LOCAL = typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_LOCAL_MODE === "true";

// ── localStorage fallback (local mode only) ────────────────────────────────

function localLoad(): SavedStory[] {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]"); } catch { return []; }
}
function localSave(stories: SavedStory[]) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(stories)); } catch {}
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useSavedStories() {
  const [saved, setSaved] = useState<SavedStory[]>([]);
  const [loading, setLoading] = useState(true);

  // Load on mount
  useEffect(() => {
    if (IS_LOCAL) {
      setSaved(localLoad());
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setLoading(false); return; }
        const { data } = await supabase
          .from("saved_stories")
          .select("story_data, saved_at")
          .eq("user_id", user.id)
          .order("saved_at", { ascending: false });
        if (data) {
          setSaved(data.map((r) => ({ ...(r.story_data as Story), savedAt: r.saved_at })));
        }
      } catch (e) { console.error("useSavedStories load:", e); }
      finally { setLoading(false); }
    })();
  }, []);

  const isSaved = useCallback((id: string) => saved.some((s) => s.id === id), [saved]);

  const toggle = useCallback(async (story: Story) => {
    const exists = saved.some((s) => s.id === story.id);

    if (IS_LOCAL) {
      setSaved((prev) => {
        const next = exists
          ? prev.filter((s) => s.id !== story.id)
          : [{ ...story, savedAt: new Date().toISOString() }, ...prev];
        localSave(next);
        return next;
      });
      return;
    }

    // Optimistic: flip the UI immediately so the icon colour changes instantly.
    setSaved((prev) =>
      exists
        ? prev.filter((s) => s.id !== story.id)
        : [{ ...story, savedAt: new Date().toISOString() }, ...prev],
    );

    // Persist in the background; revert only if the write fails.
    (async () => {
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        if (exists) {
          await supabase.from("saved_stories").delete().eq("user_id", user.id).eq("story_id", story.id);
        } else {
          await supabase.from("saved_stories").insert({ user_id: user.id, story_id: story.id, story_data: story as any });
        }
      } catch (e) {
        console.error("useSavedStories toggle:", e);
        // revert
        setSaved((prev) =>
          exists
            ? [{ ...story, savedAt: new Date().toISOString() }, ...prev]
            : prev.filter((s) => s.id !== story.id),
        );
      }
    })();
  }, [saved]);

  const remove = useCallback(async (id: string) => {
    if (IS_LOCAL) {
      setSaved((prev) => { const n = prev.filter((s) => s.id !== id); localSave(n); return n; });
      return;
    }
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("saved_stories").delete().eq("user_id", user.id).eq("story_id", id);
      setSaved((prev) => prev.filter((s) => s.id !== id));
    } catch (e) { console.error("useSavedStories remove:", e); }
  }, []);

  return { saved, loading, isSaved, toggle, remove };
}
