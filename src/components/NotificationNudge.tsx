/**
 * NotificationNudge — persistent, low-key inline banner asking a logged-in
 * user to turn on "your briefing is ready" push notifications.
 *
 * REWRITE (2026-07-06): this used to be a Dialog popup that appeared over the
 * whole app on a timer, re-triggered on every visibility change, and had to
 * be sequenced behind the one-time CityNudge dialog so the two didn't stack —
 * that sequencing is exactly what broke it for existing users. Per direct
 * user feedback ("keep a small section, like how the iOS install
 * instructions come, instead of the random popup"), replaced with the same
 * pattern InstallNudge already uses for the install ask: a quiet inline card,
 * not a modal. `supported` / `permission` / `subscribed` are all real,
 * checkable browser state, so this renders nothing the instant any of them
 * make the ask moot — no "seen" flag, no event sequencing, no dismiss-forever
 * bookkeeping needed. Per-mount dismiss (component state only) hides it for
 * this visit; it reappears next time the app is opened, same as InstallNudge's
 * banner variant.
 *
 * iOS can't receive push at all from a browser tab — only once installed —
 * so this stays hidden on iOS until isStandalone() is true, instead of
 * showing an ask that's guaranteed to fail.
 *
 * The whole card is the tap target (2026-07-06, per feedback) — not a
 * separate "Turn on" button inside it — same as InstallNudge's Android row,
 * which is itself a single <button>. The dismiss X sits outside that button
 * as a sibling so it isn't nested inside it (invalid HTML / broken semantics)
 * and stopPropagation isn't needed for its own click to work correctly.
 */
import { useState } from "react";
import { Bell, X } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { isIOS, isStandalone } from "@/lib/platform";

export function NotificationNudge() {
  const push = usePushNotifications();
  const [dismissed, setDismissed] = useState(false);

  if (!push.supported) return null;
  if (push.permission !== "default" || push.subscribed) return null;
  if (isIOS() && !isStandalone()) return null;
  if (dismissed) return null;

  return (
    <div className="mx-4 mt-3 mb-3 flex items-start gap-2 rounded-2xl border border-primary/20 bg-primary/[0.04] pr-2">
      <button
        onClick={() => void push.subscribe()}
        disabled={push.loading}
        className="flex flex-1 min-w-0 items-start gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-primary/[0.06] disabled:opacity-60"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Bell className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {push.loading ? "Turning on…" : "Never miss your briefing"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {push.loading
              ? "Just a moment…"
              : "Tap to get a nudge the moment it's ready — no need to keep checking back."}
          </p>
          {push.error && (
            <p className="mt-1 text-xs text-destructive/80">{push.error}</p>
          )}
        </div>
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="mt-3 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
