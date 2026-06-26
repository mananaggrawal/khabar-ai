/**
 * Client analytics wrapper — fires every event to TWO sinks:
 *   1. PostHog (funnels, retention, replay)            — if VITE_POSTHOG_KEY is set
 *   2. Our own /api/track → Supabase `events` table    — powers the admin dashboards
 *
 * One taxonomy (see events.ts), shared with the future Flutter app.
 * SSR-safe (all browser access guarded) and respects a local opt-out flag.
 */
import type { EventName, EventProps } from "./events";

const OPTOUT_KEY   = "khabar-analytics-optout";
const LANGUAGE_KEY = "khabar-language";
const APP_VERSION  = (import.meta as any).env?.VITE_APP_VERSION ?? "web";

let _posthog: any = null;
let _initStarted = false;
let _userId: string | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function optedOut(): boolean {
  if (!isBrowser()) return true;
  try { return localStorage.getItem(OPTOUT_KEY) === "true"; } catch { return false; }
}

export function setAnalyticsOptOut(optOut: boolean): void {
  if (!isBrowser()) return;
  try { localStorage.setItem(OPTOUT_KEY, optOut ? "true" : "false"); } catch {}
  if (optOut && _posthog) { try { _posthog.opt_out_capturing(); } catch {} }
  if (!optOut && _posthog) { try { _posthog.opt_in_capturing(); } catch {} }
}

function currentLanguage(): string {
  if (!isBrowser()) return "en";
  try { return localStorage.getItem(LANGUAGE_KEY) || "en"; } catch { return "en"; }
}

function superProps(): EventProps {
  return { platform: "web", appVersion: APP_VERSION, language: currentLanguage() };
}

/** Initialise PostHog on the client. Safe to call multiple times. */
export async function initAnalytics(): Promise<void> {
  if (!isBrowser() || _initStarted) return;
  _initStarted = true;
  const key  = (import.meta as any).env?.VITE_POSTHOG_KEY as string | undefined;
  const host = (import.meta as any).env?.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
  if (!key) return; // no PostHog configured — /api/track still works
  try {
    const mod = await import("posthog-js");
    const posthog = (mod as any).default ?? mod;
    posthog.init(key, {
      api_host: host,
      capture_pageview: true,
      autocapture: true,
      persistence: "localStorage",
      opt_out_capturing_by_default: optedOut(),
    });
    _posthog = posthog;
  } catch {
    /* PostHog optional — ignore load failures */
  }
}

/** Associate subsequent events with a user id (Supabase user id). */
export function identify(userId: string, traits?: EventProps): void {
  _userId = userId || null;
  if (optedOut()) return;
  try { _posthog?.identify(userId, traits); } catch {}
}

export function resetIdentity(): void {
  _userId = null;
  try { _posthog?.reset(); } catch {}
}

/** Track an event to PostHog + our own ingestion endpoint. Fire-and-forget. */
export function track(event: EventName, props: EventProps = {}): void {
  if (!isBrowser() || optedOut()) return;
  const enriched = { ...superProps(), ...props };

  try { _posthog?.capture(event, enriched); } catch {}

  try {
    const body = JSON.stringify({
      event,
      userId: _userId,
      ts: new Date().toISOString(),
      props: enriched,
    });
    // keepalive so the event still sends if the page is navigating/closing
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
