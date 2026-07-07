/**
 * Full-briefing vs "Quick 15" listening mode preference (2026-07-06) —
 * localStorage-backed, same pattern as language (useMonologue) / city
 * (useCityPreference). Lives in Settings, not as a toggle on Home (explicit
 * request) — Home/PlayerProvider just reads whichever mode is currently set
 * and builds the playback queue accordingly.
 */
import { useCallback, useEffect, useState } from "react";

export type ListenMode = "full" | "quick";
const LISTEN_MODE_KEY = "khabar-listen-mode";

export function readListenMode(): ListenMode {
  try {
    return localStorage.getItem(LISTEN_MODE_KEY) === "quick" ? "quick" : "full";
  } catch {
    return "full";
  }
}

export function useListenMode() {
  const [mode, setModeState] = useState<ListenMode>(readListenMode);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LISTEN_MODE_KEY) setModeState(readListenMode());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: ListenMode) => {
    try {
      localStorage.setItem(LISTEN_MODE_KEY, next);
      window.dispatchEvent(new StorageEvent("storage", { key: LISTEN_MODE_KEY, newValue: next }));
    } catch {}
    setModeState(next);
  }, []);

  return { mode, setMode };
}
