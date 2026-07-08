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
 *
 * Pure value hook only (2026-07-08) — the "should we ask about onboarding"
 * state machine (first-login detection, the mandatory CityNudge flow, the
 * Home render gate) all moved to useOnboardingGate.ts, which owns it as a
 * single per-user-scoped concern instead of this file tracking its own
 * separate "asked" flag.
 */
import { useCallback, useEffect, useState } from "react";
import { CITIES, type CityId } from "@/lib/news/sources";

const CITY_KEY = "khabar-city";

// Defaults to "mumbai" rather than null (2026-07-06) — same pattern as
// language's readLanguage() defaulting to "en". Mumbai is the one real city
// today, so it should show pre-selected everywhere (Settings, the "local"
// section filter) without requiring the user to have gone through CityNudge
// first, exactly like language never required an explicit first choice.
export function readCity(): CityId {
  try {
    const v = localStorage.getItem(CITY_KEY);
    return CITIES.some((c) => c.id === v) ? (v as CityId) : "mumbai";
  } catch {
    return "mumbai";
  }
}

export function useCityPreference() {
  const [city, setCityState] = useState<CityId>(readCity);

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
    setCityState(id);
  }, []);

  return { city, selectCity };
}
