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

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

const CITY_KEY = "khabar-city";
// Separate "have we ever asked" flag from the value itself, so skipping the
// one-time prompt doesn't look indistinguishable from "no preference yet."
const CITY_ASKED_KEY = "khabar-city-asked";
// Fired once the one-time city prompt has been resolved (selected OR
// skipped) — lets other first-open nudges (e.g. NotificationNudge) wait their
// turn instead of stacking dialogs on top of each other.
export const CITY_RESOLVED_EVENT = "khabar-city-resolved";

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
    markCityAsked();
    setCityState(id);
  }, []);

  return { city, selectCity };
}

// A brand-new account's very first sign-in has `created_at` and
// `last_sign_in_at` within a second or two of each other (both set at
// account creation). On every later login `last_sign_in_at` moves forward
// while `created_at` stays fixed, so the gap grows. This is what "new login,
// not existing user" actually means for an app with no separate onboarding
// step — checking wall-clock "was this just now" would also catch an
// EXISTING user's normal re-login a minute after opening the app.
const FIRST_LOGIN_WINDOW_MS = 2 * 60_000;

async function isFirstEverLogin(): Promise<boolean> {
  if (LOCAL_MODE) return false; // never nag in local dev
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;
    if (error || !user?.created_at || !user?.last_sign_in_at) return false;
    const created = new Date(user.created_at).getTime();
    const lastSignIn = new Date(user.last_sign_in_at).getTime();
    return Math.abs(lastSignIn - created) < FIRST_LOGIN_WINDOW_MS;
  } catch {
    return false; // fail closed — don't nag existing users on an auth hiccup
  }
}

/**
 * Drives the one-time CityNudge dialog. Only true for a genuinely new
 * account's first-ever login (2026-07-06 fix — this feature shipping after
 * existing users already had accounts meant EVERY existing user looked
 * "never asked" by the plain localStorage flag alone, so they were all
 * getting prompted like new signups). Also still respects the flag once
 * answered, so a real new user doesn't see it again after their first open.
 */
export function useShouldPromptCity() {
  const [shouldPrompt, setShouldPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (hasCityBeenAsked()) return;
    isFirstEverLogin().then((isNew) => {
      if (!cancelled && isNew) setShouldPrompt(true);
    });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    markCityAsked();
    setShouldPrompt(false);
  }, []);

  return { shouldPrompt, dismiss };
}
