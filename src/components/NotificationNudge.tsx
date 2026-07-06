/**
 * Recurring nudge, shown every time a logged-in user opens the app on a
 * device where they haven't yet decided about notifications, asking them to
 * turn on "your briefing is ready" pushes (2026-07-06: changed from a
 * one-time-ever nudge to every-open, per explicit request — dismissing no
 * longer permanently suppresses it). It still stays hidden for the rest of
 * that permission state: once the browser reports "granted" or "denied", or
 * the user has subscribed, `push.permission !== "default" || push.subscribed`
 * keeps it from showing again (re-asking after an explicit OS-level denial
 * would just be a dead end).
 *
 * BUG FIX (2026-07-06): "every open" didn't actually mean every open once the
 * PWA was installed — closing and reopening an installed PWA (tapping the
 * home-screen icon) does NOT necessarily unmount/remount this component the
 * way a browser tab reload does. iOS/Android often just resume the existing
 * page from the background, so the original mount-only useEffect below never
 * re-ran and the dialog silently stopped reappearing after the first install.
 * Fix: also listen for the document becoming visible again (the reliable
 * cross-platform signal for "the app was foregrounded"), and re-run the same
 * eligibility check + show timer then, not just once at mount.
 */
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { hasCityBeenAsked, CITY_RESOLVED_EVENT } from "@/hooks/useCityPreference";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function NotificationNudge() {
  const push = usePushNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!push.supported) return;
    if (push.permission !== "default" || push.subscribed) return;

    // Small delay so this doesn't fight with the initial page load / audio
    // autoplay prompts — feels like a nudge, not a wall. If the one-time
    // CityNudge dialog hasn't been answered yet this session, wait for it to
    // resolve first so the two first-open dialogs don't stack (2026-07-06).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearPending = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const scheduleShow = () => {
      clearPending();
      timer = setTimeout(() => setOpen(true), 1500);
    };
    const tryShow = () => {
      if (hasCityBeenAsked()) {
        scheduleShow();
      } else {
        window.addEventListener(CITY_RESOLVED_EVENT, scheduleShow, { once: true });
      }
    };

    tryShow(); // first mount / fresh page load

    // Re-check every time the app comes back to the foreground — covers
    // installed-PWA close/reopen, which usually doesn't remount the app.
    const onVisibility = () => {
      if (document.visibilityState === "visible") tryShow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);

    return () => {
      clearPending();
      window.removeEventListener(CITY_RESOLVED_EVENT, scheduleShow);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
    };
  }, [push.supported, push.permission, push.subscribed]);

  function dismiss() {
    setOpen(false);
  }

  // BUG FIX (2026-07-06): this used to call setOpen(false) BEFORE awaiting
  // subscribe() — closing the dialog immediately regardless of whether the
  // subscription actually succeeded. A granted OS permission prompt is only
  // step one; the subsequent service-worker/VAPID/server-save steps can still
  // fail (silently, since the dialog was already gone and push.error had
  // nowhere to render). Now it stays open through the attempt and only
  // closes on success, showing push.error inline otherwise.
  async function enable() {
    const ok = await push.subscribe();
    if (ok) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Bell className="size-6 text-primary" />
          </div>
          <DialogTitle className="mt-3 text-center font-serif text-xl">
            Never miss your briefing
          </DialogTitle>
          <DialogDescription className="text-center">
            Get a nudge the moment your morning and evening briefings are ready — no need to keep checking back.
          </DialogDescription>
        </DialogHeader>
        {push.error && (
          <p className="text-center text-xs text-destructive/80">{push.error}</p>
        )}
        <DialogFooter className="mt-2 sm:flex-col sm:space-x-0 sm:gap-2">
          <button
            onClick={enable}
            disabled={push.loading}
            className="w-full rounded-2xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {push.loading ? "Working…" : "Turn on notifications"}
          </button>
          <button
            onClick={dismiss}
            className="w-full rounded-2xl px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.02]"
          >
            Not now
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
