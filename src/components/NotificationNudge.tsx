/**
 * One-time nudge, shown the first time a logged-in user lands in the app on
 * a device where they haven't yet decided about notifications, asking them
 * to turn on "your briefing is ready" pushes. There's no server-side
 * "first login" flag in this app, so this uses a localStorage marker instead
 * — it fires once per browser/device (which in practice means once per
 * install), not literally on the very first login across all devices.
 */
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const SEEN_KEY = "khabar-notif-nudge-seen";

function hasSeenNudge(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}

function markNudgeSeen(): void {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
}

export function NotificationNudge() {
  const push = usePushNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (hasSeenNudge()) return;
    if (!push.supported) return;
    if (push.permission !== "default" || push.subscribed) return;
    // Small delay so this doesn't fight with the initial page load / audio
    // autoplay prompts — feels like a nudge, not a wall.
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, [push.supported, push.permission, push.subscribed]);

  function dismiss() {
    markNudgeSeen();
    setOpen(false);
  }

  async function enable() {
    markNudgeSeen();
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
