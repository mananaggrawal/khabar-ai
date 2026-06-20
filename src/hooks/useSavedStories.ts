import { useState, useCallback } from "react";
import type { Story } from "@/lib/news/generator";

const STORAGE_KEY = "khabar-saved-stories";

export type SavedStory = Story & { savedAt: string };

function load(): SavedStory[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; }
}

function persist(stories: SavedStory[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stories)); } catch {}
}

export function useSavedStories() {
  const [saved, setSaved] = useState<SavedStory[]>(() =>
    typeof window !== "undefined" ? load() : [],
  );

  const isSaved = useCallback(
    (id: string) => saved.some((s) => s.id === id),
    [saved],
  );

  const toggle = useCallback((story: Story) => {
    setSaved((prev) => {
      const exists = prev.some((s) => s.id === story.id);
      const next = exists
        ? prev.filter((s) => s.id !== story.id)
        : [{ ...story, savedAt: new Date().toISOString() }, ...prev];
      persist(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSaved((prev) => {
      const next = prev.filter((s) => s.id !== id);
      persist(next);
      return next;
    });
  }, []);

  return { saved, isSaved, toggle, remove };
}
