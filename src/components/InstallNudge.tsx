/**
 * InstallNudge — persistent, low-key reminder to install the PWA, shown
 * wherever it's mounted for as long as the app is NOT installed (2026-07-06).
 * Deliberately NOT a one-time onboarding dialog: "installed" is a real,
 * checkable state (useInstallPrompt/isStandalone), so this just renders
 * nothing the moment that's true — no "seen" flag or dismiss-forever bookkeeping
 * needed for that part.
 *
 * Two spots use this: a "banner" variant inline near the top of Home (highest
 * traffic, visible during normal use) and a "row" variant in Settings styled
 * like the other settings sections (permanent discoverability, no nagging).
 * Mobile-only by design (this is a personal, phone-first listening app) —
 * desktop Chrome/Edge also fire beforeinstallprompt, so isMobile gates that out.
 *
 * Platform split:
 *  - Android, prompt available: real "Install app" button via the captured
 *    beforeinstallprompt event (only available once it's fired this page
 *    load — see useInstallPrompt's canPromptInstall).
 *  - Android, prompt NOT (yet) available (2026-07-10): generic "open your
 *    browser's menu → Add to Home screen / Install app" instructions instead
 *    of rendering nothing. beforeinstallprompt only fires once Chrome's own
 *    engagement heuristics are met (never on a brand-new visit), and doesn't
 *    fire at all in non-Chromium Android browsers (Firefox, Samsung Internet,
 *    in-app webviews) — so "wait for the button" left those users with no
 *    nudge at all. Deliberately generic copy (not per-browser tailored) since
 *    menu wording/location varies too much across Android browsers to be
 *    worth the detection complexity. If canPromptInstall later flips true
 *    mid-session, this upgrades itself to the real button automatically.
 *  - iOS Safari: no programmatic install exists at all, so this shows manual
 *    Share → Add to Home Screen instructions instead of a button.
 */
import { useState } from "react";
import { Download, MoreVertical, Share, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

interface InstallNudgeProps {
  variant?: "banner" | "row";
}

export function InstallNudge({ variant = "banner" }: InstallNudgeProps) {
  const { isStandalone, isIOS, isMobile, canPromptInstall, promptInstall } = useInstallPrompt();
  // Per-mount dismiss only (component state, not localStorage) — hides the
  // banner for this visit without permanently suppressing it. It reappears
  // next time the app is opened as long as it's still not installed. The Home
  // banner is dismissible this way; the Settings row always shows (matches
  // the other permanent settings sections, and nobody stumbles onto Settings
  // by accident the way they see the Home banner every open).
  const [dismissed, setDismissed] = useState(false);

  if (isStandalone || !isMobile) return null;
  if (variant === "banner" && dismissed) return null;

  const androidBody = (
    <>
      <p className="text-sm font-medium text-foreground">Install Khabar AI</p>
      <p className="text-xs text-muted-foreground mt-0.5">
        Add it to your home screen for faster access and background playback.
      </p>
    </>
  );
  // Fallback for Android when beforeinstallprompt hasn't fired this load (or
  // never will, e.g. non-Chromium browsers) — generic menu instructions
  // instead of the real button, same spirit as the iOS Share-sheet steps.
  const androidFallbackBody = (
    <>
      <p className="text-sm font-medium text-foreground">Install Khabar AI</p>
      <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1.5 flex-wrap">
        Tap <MoreVertical className="size-3.5 inline shrink-0 mx-0.5" /> menu, then "Add to Home screen" or "Install app".
      </p>
    </>
  );
  const iosBody = (
    <>
      <p className="text-sm font-medium text-foreground">Install Khabar AI</p>
      <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1.5 flex-wrap">
        Tap <Share className="size-3.5 inline shrink-0 mx-0.5" /> Share, then "Add to Home Screen".
      </p>
    </>
  );

  if (variant === "row") {
    return (
      <section>
        <h2 className="font-serif text-lg">Install app</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isIOS
            ? "Notifications are only available once Khabar AI is added to your home screen."
            : "Install Khabar AI for faster access and background playback."}
        </p>
        <div className="mt-4">
          {isIOS ? (
            // Plain numbered steps, not a bordered/button-shaped box — there's
            // nothing to tap here (iOS has no programmatic install), so it
            // shouldn't visually read as an interactive control (2026-07-06).
            <ol className="space-y-2.5">
              <li className="flex items-center gap-2.5 text-sm text-foreground/70">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">1</span>
                <span className="inline-flex items-center gap-1 flex-wrap">
                  Tap <Share className="size-3.5 inline shrink-0 mx-0.5 text-muted-foreground" /> Share in Safari
                </span>
              </li>
              <li className="flex items-center gap-2.5 text-sm text-foreground/70">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">2</span>
                <span>Choose "Add to Home Screen"</span>
              </li>
            </ol>
          ) : canPromptInstall ? (
            <button
              onClick={() => void promptInstall()}
              className="flex w-full items-center gap-3 rounded-2xl border border-border px-4 py-3 text-left text-foreground/70 hover:border-border/80 hover:bg-black/[0.02] transition-colors"
            >
              <Download className="size-4 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">Install app</span>
            </button>
          ) : (
            // Android fallback (2026-07-10) — beforeinstallprompt hasn't
            // fired (or never will, e.g. non-Chromium browsers), so there's
            // no button to offer. Same plain-steps, non-interactive treatment
            // as the iOS block above rather than an empty section.
            <ol className="space-y-2.5">
              <li className="flex items-center gap-2.5 text-sm text-foreground/70">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">1</span>
                <span className="inline-flex items-center gap-1 flex-wrap">
                  Tap <MoreVertical className="size-3.5 inline shrink-0 mx-0.5 text-muted-foreground" /> menu in your browser
                </span>
              </li>
              <li className="flex items-center gap-2.5 text-sm text-foreground/70">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">2</span>
                <span>Choose "Add to Home screen" or "Install app"</span>
              </li>
            </ol>
          )}
        </div>
      </section>
    );
  }

  return (
    <div className="mx-4 mt-3 mb-3 flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
        {isIOS ? <Share className="size-4 text-primary" /> : canPromptInstall ? <Download className="size-4 text-primary" /> : <MoreVertical className="size-4 text-primary" />}
      </div>
      <div className="min-w-0 flex-1">
        {isIOS ? iosBody : canPromptInstall ? androidBody : androidFallbackBody}
        {!isIOS && canPromptInstall && (
          <button
            onClick={() => void promptInstall()}
            className="mt-2 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Install
          </button>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
