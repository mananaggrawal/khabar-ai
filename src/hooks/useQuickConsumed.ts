/**
 * Tracks which story ids have been "consumed" in Quick 15 mode today
 * (2026-07-06). Kept separate from useMonologue's `completedIds` even though
 * skipping now marks a story "listened" there too (2026-07-06 follow-up,
 * applies everywhere, not just Quick mode) — this set exists specifically so
 * buildQuickQueue can exclude a story the instant it's passed, synchronously,
 * without waiting on the async Supabase-backed completedIds round trip.
 * Reset daily, same pattern as useMonologue's COMPLETED_KEY.
 */
import { useCallback, useEffect, useState } from "react";

const QUICK_CONSUMED_KEY = "khabar-quick-consumed";

function readConsumed(date: string): Set<string> {
  try {
    const raw = localStorage.getItem(QUICK_CONSUMED_KEY);
    if (!raw) return new Set();
    const obj = JSON.parse(raw);
    return obj?.date === date && Array.isArray(obj.ids) ? new Set(obj.ids) : new Set();
  } catch {
    return new Set();
  }
}

export function useQuickConsumed(date: string | undefined) {
  const [consumedIds, setConsumedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setConsumedIds(date ? readConsumed(date) : new Set());
  }, [date]);

  const markConsumed = useCallback(
    (id: string | null | undefined) => {
      if (!id || !date) return;
      setConsumedIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev).add(id);
        try {
          localStorage.setItem(QUICK_CONSUMED_KEY, JSON.stringify({ date, ids: [...next] }));
        } catch {}
        return next;
      });
    },
    [date],
  );

  return { consumedIds, markConsumed };
}
