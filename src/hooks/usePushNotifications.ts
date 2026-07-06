/**
 * usePushNotifications — subscribe/unsubscribe this device for the "your
 * briefing is ready" Web Push notifications sent after each cron generation.
 *
 * Platform notes:
 *  - Android/Chrome: works fully, any time.
 *  - iOS Safari: only works if the PWA has been added to the home screen
 *    (installed) — a browser tab can't receive push on iOS. `supported`
 *    reflects the Push API being present at all, not this iOS nuance; there's
 *    no reliable way to detect "installed" ahead of actually trying.
 */
import { useCallback, useEffect, useState } from "react";
import { isIOS, isStandalone } from "@/lib/platform";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function authHeader(): Promise<Record<string, string>> {
  if (LOCAL_MODE) return { Authorization: "Bearer local-dev" };
  const { supabase } = await import("@/integrations/supabase/client");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// iOS Safari silently never completes a push subscription unless the page is
// running as an installed home-screen app — in a regular tab, subscribe()
// just hangs forever instead of rejecting. Without a timeout, the UI would
// sit on "Working…" indefinitely (exactly what happened before this existed).
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export function usePushNotifications() {
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    !!VAPID_PUBLIC_KEY;

  const [permission, setPermission] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "default"),
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Register the service worker once, and check for an existing subscription
  // (e.g. the user enabled this on a previous visit).
  useEffect(() => {
    if (!supported) return;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        setSubscribed(!!existing);
      } catch {
        /* registration failing shouldn't break the rest of the app */
      }
    })();
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported) { setError("Notifications aren't supported in this browser."); return; }
    setLoading(true);
    setError(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError(perm === "denied" ? "Notifications blocked — enable them in your browser settings." : "Permission not granted.");
        return;
      }
      const reg = await withTimeout(
        navigator.serviceWorker.ready,
        10_000,
        "Timed out waiting for the notification service to start. Try closing and reopening the app.",
      );
      const subscription = await withTimeout(
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
        }),
        15_000,
        isIOS() && !isStandalone()
          ? "Timed out. On iPhone, notifications only work when opened from the home-screen icon, not a Safari tab — add this to your home screen first, then open it from there."
          : "Timed out subscribing to notifications. Please try again.",
      );
      const headers = await authHeader();
      const res = await withTimeout(
        fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(subscription.toJSON()),
        }),
        10_000,
        "Timed out saving your subscription — check your connection and try again.",
      );
      if (!res.ok) throw new Error("Failed to save subscription");
      setSubscribed(true);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't enable notifications.");
    } finally {
      setLoading(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        const headers = await authHeader();
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      setSubscribed(false);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't disable notifications.");
    } finally {
      setLoading(false);
    }
  }, [supported]);

  return { supported, permission, subscribed, loading, error, subscribe, unsubscribe };
}
