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
 * and stopPropagation isn't needed for its own click to work correctly. A
 * visible "Turn on" pill (a <span>, not a nested <button>) sits inside it so
 * the card visibly reads as an actionable control, not just informational text.
 *
 * BUG FIX (2026-07-06): this used to hide itself whenever
 * `push.permission !== "default"` — which also matches "granted". If the OS
 * permission was granted in an earlier session but the actual push
 * subscription was never saved (or later got deleted server-side), the
 * browser still reports "granted" forever; the card then had no way to ever
 * show again, silently killing the only CTA to retry. Now it only hides for
 * an explicit "denied" (nothing we can do there) or once actually subscribed
 * — "granted but not subscribed" still shows the card, and clicking it calls
 * subscribe() again, which skips the OS prompt (already granted) and just
 * redoes the service-worker/save steps that didn't finish before.
 */
import { useState } from "react";
import { Bell, X } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { isIOS, isStandalone } from "@/lib/platform";

export function NotificationNudge() {
  const push = usePushNotifications();
  const [dismissed, setDismissed] = useState(false);

  if (!push.supported) return null;
  if (push.subscribed) return null;
  if (push.permission === "denied") return null;
  if (isIOS() && !isStandalone()) return null;
  if (dismissed) return null;

  return (
    <div className="mx-4 mt-3 mb-3 flex items-start gap-2 rounded-2xl border border-primary/20 bg-primary/[0.04] pr-2">
      <button
        onClick={() => void push.subscribe()}
        disabled={push.loading}
        className="flex-1 min-w-0 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-primary/[0.06] disabled:opacity-60"
      >
        {/* icon + text row */}
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Bell className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Never miss your briefing</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Get a nudge the moment it's ready — no need to keep checking back.
            </p>
            {push.error && (
              <p className="mt-1 text-xs text-destructive/80">{push.error}</p>
            )}
            {/* "Turn on" pill (2026-07-10 fix): moved below the text instead of
                sharing the row with it. Sitting beside the subtitle left the
                subtitle competing with the icon AND the pill for width,
                squeezing it into 3 wrapped lines on narrower Android screens
                (confirmed via screenshot). Same convention InstallNudge's
                banner already uses for its "Install" button — CTA sits under
                the copy, in the same column, not to the side of it. */}
            <span className="mt-2 inline-block rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              {push.loading ? "Working…" : "Turn on"}
            </span>
          </div>
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
