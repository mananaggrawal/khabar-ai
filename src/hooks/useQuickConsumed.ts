/**
 * Tracks which story ids have been "consumed" in Quick 15 mode today
 * (2026-07-06). Deliberately separate from useMonologue's `completedIds` —
 * that tracker only marks a story once it's heard all the way to the end,
 * which is the right definition for the normal "listened" checkmark
 * elsewhere in the app. Quick mode behaves more like radio: per explicit
 * product decision, skipping a story in Quick mode should still keep it from
 * repeating in the next Quick 15 batch, even though it shouldn't falsely show
 * up as "listened" in Home's normal per-section list. Hence its own
 * localStorage key, reset daily just like COMPLETED_KEY.
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
