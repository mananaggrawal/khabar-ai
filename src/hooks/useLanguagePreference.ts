/**
 * Preferred narration language (2026-07-08) — localStorage-backed, same
 * pattern as useCityPreference. Extracted out of settings.tsx (which keeps
 * its own copy of the read/write logic inline) so CityNudge's onboarding
 * flow can ask for a language preference too, right after city, using the
 * exact same 'khabar-language' key useMonologue already listens to via
 * storage events — so selecting a language here takes effect immediately,
 * with no extra wiring needed.
 */
import { useCallback, useEffect, useState } from "react";

export const LANGUAGE_KEY = "khabar-language";
// Set by PlayerProvider once the day's briefing loads (2026-07-05) — a
// language only counts "available" once at least half of today's stories
// actually have audio in it. Same fallback default settings.tsx has always
// used for the brief window before that computation lands.
const AVAILABLE_LANGS_KEY = "khabar-available-languages";

export type LanguageCode = "en" | "hi";

export const LANGUAGES: Array<{ code: LanguageCode; label: string; nativeName: string }> = [
  { code: "en", label: "English", nativeName: "English" },
  { code: "hi", label: "हिंदी",   nativeName: "Hindi"   },
];

export function readLanguage(): LanguageCode {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return LANGUAGES.some((l) => l.code === v) ? (v as LanguageCode) : "en";
  } catch {
    return "en";
  }
}

export function readAvailableLanguages(): string[] {
  try {
    const stored = localStorage.getItem(AVAILABLE_LANGS_KEY);
    return stored ? JSON.parse(stored) : ["en", "hi"];
  } catch {
    return ["en", "hi"];
  }
}

export function useLanguagePreference() {
  const [language, setLanguageState] = useState<LanguageCode>(readLanguage);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_KEY) setLanguageState(readLanguage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const selectLanguage = useCallback((code: LanguageCode) => {
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
      window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_KEY, newValue: code }));
    } catch {}
    setLanguageState(code);
  }, []);

  return { language, selectLanguage };
}
