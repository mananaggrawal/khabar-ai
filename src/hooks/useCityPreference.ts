/**
 * City preference (2026-07-06) — localStorage-backed, same pattern as
 * language (khabar-language). Only "mumbai" is a real, selectable value right
 * now (see CITIES in @/lib/news/sources); the rest are listed as "coming
 * soon" so the picker communicates what's planned rather than looking bare.
 *
 * Generation is still single-tenant/global — picking a city doesn't change
 * what content gets generated today, since only Mumbai exists. This is
 * groundwork for when more cities are actually generated: the "local"
 * section's content will then be able to vary by this preference.
 */
import { useCallback, useEffect, useState } from "react";
import { CITIES, type CityId } from "@/lib/news/sources";

const CITY_KEY = "khabar-city";
// Separate "have we ever asked" flag from the value itself, so skipping the
// one-time prompt doesn't look indistinguishable from "no preference yet."
const CITY_ASKED_KEY = "khabar-city-asked";
// Fired once the one-time city prompt has been resolved (selected OR
// skipped) — lets other first-open nudges (e.g. NotificationNudge) wait their
// turn instead of stacking dialogs on top of each other.
export const CITY_RESOLVED_EVENT = "khabar-city-resolved";

export function readCity(): CityId | null {
  try {
    const v = localStorage.getItem(CITY_KEY);
    return CITIES.some((c) => c.id === v) ? (v as CityId) : null;
  } catch {
    return null;
  }
}

export function hasCityBeenAsked(): boolean {
  try {
    return localStorage.getItem(CITY_ASKED_KEY) === "1";
  } catch {
    return true; // fail open — don't nag if storage is unavailable
  }
}

function markCityAsked(): void {
  try { localStorage.setItem(CITY_ASKED_KEY, "1"); } catch {}
  try { window.dispatchEvent(new Event(CITY_RESOLVED_EVENT)); } catch {}
}

export function useCityPreference() {
  const [city, setCityState] = useState<CityId | null>(readCity);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === CITY_KEY) setCityState(readCity());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const selectCity = useCallback((id: CityId) => {
    try {
      localStorage.setItem(CITY_KEY, id);
      window.dispatchEvent(new StorageEvent("storage", { key: CITY_KEY, newValue: id }));
    } catch {}
    markCityAsked();
    setCityState(id);
  }, []);

  return { city, selectCity };
}

/** Drives the one-time CityNudge dialog — true until the user answers once. */
export function useShouldPromptCity() {
  const [shouldPrompt, setShouldPrompt] = useState(false);

  useEffect(() => {
    setShouldPrompt(!hasCityBeenAsked());
  }, []);

  const dismiss = useCallback(() => {
    markCityAsked();
    setShouldPrompt(false);
  }, []);

  return { shouldPrompt, dismiss };
}
