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
    const startTimer = () => { timer = setTimeout(() => setOpen(true), 1500); };

    if (hasCityBeenAsked()) {
      startTimer();
      return () => { if (timer) clearTimeout(timer); };
    }
    window.addEventListener(CITY_RESOLVED_EVENT, startTimer, { once: true });
    return () => {
      window.removeEventListener(CITY_RESOLVED_EVENT, startTimer);
      if (timer) clearTimeout(timer);
    };
  }, [push.supported, push.permission, push.subscribed]);

  function dismiss() {
    setOpen(false);
  }

  async function enable() {
    setOpen(false);
    await push.subscribe();
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
