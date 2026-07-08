/**
 * Gates rendering of the authenticated app until CityNudge's mandatory
 * onboarding flow (city + language, both non-skippable — 2026-07-08) has
 * been resolved for a brand-new signup, so Home never flashes its content
 * for a moment underneath the dialog right after login.
 *
 * Three states, not two:
 *  - still checking (the one-time async isFirstEverLogin() lookup hasn't
 *    finished) — blocked, nothing rendered yet either way.
 *  - checked, nothing to ask (existing user, or city already asked before)
 *    — unblocked immediately; CityNudge's dialog never opens for them.
 *  - checked, genuinely new — blocked until markOnboardingDone() fires,
 *    which CityNudge calls once the LAST step (language) has been picked.
 *
 * Lives in the route shell (see _authenticated/route.tsx), which owns the
 * single useShouldPromptCity() call and hands `shouldPrompt` down to
 * CityNudge as a prop — avoids running the async check twice.
 */
import { useEffect, useState } from "react";

const ONBOARDING_DONE_KEY = "khabar-onboarding-done";
const ONBOARDING_DONE_EVENT = "khabar-onboarding-done-event";

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return true; // fail open — never hard-block the app on a storage hiccup
  }
}

export function markOnboardingDone(): void {
  try { localStorage.setItem(ONBOARDING_DONE_KEY, "1"); } catch {}
  try { window.dispatchEvent(new Event(ONBOARDING_DONE_EVENT)); } catch {}
}

export function useOnboardingGate(shouldPrompt: boolean, resolved: boolean): boolean {
  const [done, setDone] = useState(isOnboardingDone);

  useEffect(() => {
    if (done) return;
    const onDone = () => setDone(true);
    window.addEventListener(ONBOARDING_DONE_EVENT, onDone);
    return () => window.removeEventListener(ONBOARDING_DONE_EVENT, onDone);
  }, [done]);

  if (done) return true;
  if (!resolved) return false; // still running the one-time first-login check
  return !shouldPrompt; // checked, and there's nothing this user needs to answer
}
