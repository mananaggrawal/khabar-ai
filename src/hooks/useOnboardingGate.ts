/**
 * Owns the entire "does this login need the mandatory city+language
 * onboarding" flow (2026-07-08 consolidation) — previously split across
 * useCityPreference's useShouldPromptCity (its own "asked" flag) and this
 * file's separate "done" flag, both stored as bare booleans rather than
 * scoped to a specific user. Since NEITHER onboarding step is skippable
 * (CityNudge only closes once language is picked), "asked" and "done" are
 * the same event, so there's no reason to track them separately — and doing
 * so was actively buggy: a device-wide (not per-user) flag meant deleting a
 * Supabase auth user and creating a new one on the SAME browser (e.g. while
 * testing) left the stale flag from the deleted account in place, silently
 * skipping onboarding for the brand-new account entirely ("deleted the user
 * and it's still not asking").
 *
 * Drives both CityNudge (via `shouldPrompt`) and the app-wide render gate
 * (via `ready`, see __root.tsx) from one shared check.
 */
import { useEffect, useState } from "react";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

// Stores the id of the user this device has fully completed onboarding for
// — scoped per-user (not a bare "1"/boolean) specifically so switching to a
// different account on the same browser is correctly treated as needing
// onboarding again, rather than inheriting whatever the previous account
// resolved.
const DONE_KEY = "khabar-onboarding-done-user";
const DONE_EVENT = "khabar-onboarding-done-event";

// A brand-new account's very first sign-in has `created_at` and
// `last_sign_in_at` within a second or two of each other (both set at
// account creation). On every later login `last_sign_in_at` moves forward
// while `created_at` stays fixed, so the gap grows. This is what "new
// login, not existing user" means for an app with no separate onboarding
// step — checking wall-clock "was this just now" would also catch an
// EXISTING user's normal re-login a minute after opening the app.
const FIRST_LOGIN_WINDOW_MS = 2 * 60_000;

async function checkLogin(): Promise<{ userId: string | null; isNew: boolean }> {
  if (LOCAL_MODE) return { userId: "local-user", isNew: false };
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;
    if (error || !user) return { userId: null, isNew: false }; // no session (e.g. /auth)
    const isNew = !!user.created_at && !!user.last_sign_in_at &&
      Math.abs(new Date(user.last_sign_in_at).getTime() - new Date(user.created_at).getTime()) < FIRST_LOGIN_WINDOW_MS;
    return { userId: user.id, isNew };
  } catch {
    return { userId: null, isNew: false }; // fail closed — don't nag on an auth hiccup
  }
}

function isDoneFor(userId: string | null): boolean {
  if (!userId) return true; // no session — nothing to gate
  try { return localStorage.getItem(DONE_KEY) === userId; } catch { return true; }
}

export function markOnboardingDone(userId: string | null): void {
  try { if (userId) localStorage.setItem(DONE_KEY, userId); } catch {}
  try { window.dispatchEvent(new Event(DONE_EVENT)); } catch {}
}

/**
 * `userId` — the logged-in user's id, once known (null before the check
 *   resolves, or if there's no session at all). Handed to CityNudge so it
 *   can call markOnboardingDone(userId) once the language step completes.
 * `shouldPrompt` — true only for a genuinely new signup that hasn't
 *   completed onboarding on this device yet. Drives CityNudge's dialog.
 * `ready` — false while blocked (still checking, or a new user mid-flow);
 *   true once it's safe to render the real app. Drives the render gate.
 */
export function useOnboarding(): { userId: string | null; shouldPrompt: boolean; ready: boolean } {
  const [userId, setUserId] = useState<string | null>(null);
  const [shouldPrompt, setShouldPrompt] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { userId: id, isNew } = await checkLogin();
      if (cancelled) return;
      setUserId(id);
      if (isDoneFor(id)) { setDone(true); setResolved(true); return; }
      setShouldPrompt(isNew);
      setResolved(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Fires exactly once, right as CityNudge finishes the flow for whichever
    // user this hook resolved above — safe to just flip `done` directly
    // rather than re-reading localStorage.
    const onDone = () => setDone(true);
    window.addEventListener(DONE_EVENT, onDone);
    return () => window.removeEventListener(DONE_EVENT, onDone);
  }, []);

  const ready = done || (resolved && !shouldPrompt);
  return { userId, shouldPrompt, ready };
}
