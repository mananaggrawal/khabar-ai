/**
 * useInstallPrompt — tracks whether the app is running as an installed PWA,
 * and (on Android/Chrome) captures the browser's native install prompt so it
 * can be re-triggered from our own UI instead of relying on the browser's own
 * install infobar.
 *
 * Platform notes:
 *  - Android/Chrome/Edge: the browser fires `beforeinstallprompt` once its own
 *    installability checks pass (valid manifest, HTTPS, a controlling service
 *    worker, some engagement signal). We capture and hold that event; calling
 *    `.prompt()` on it shows the native "Install app?" dialog. The event is
 *    single-use per the spec — once `.prompt()` is called, it's consumed, and
 *    a NEW `beforeinstallprompt` won't fire again until the next full page
 *    load. `canPromptInstall` naturally goes back to false after a call.
 *  - iOS Safari: `beforeinstallprompt` doesn't exist at all. There is no
 *    programmatic install here — `canPromptInstall` will always be false, and
 *    UI should fall back to manual "Share → Add to Home Screen" instructions
 *    (see isIOS below).
 *  - Already installed: `isStandalone` flips to true and stays true; nothing
 *    else in this hook matters once that's the case.
 */
import { useCallback, useEffect, useState } from "react";
import { isIOS, isMobileDevice, isStandalone } from "@/lib/platform";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function useInstallPrompt() {
  const [standalone, setStandalone] = useState(false);
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setStandalone(isStandalone());

    const onBeforeInstallPrompt = (e: Event) => {
      // Prevent the browser's own mini-infobar so we control when/how this is
      // surfaced (e.g. from the persistent banner, not immediately on load).
      e.preventDefault();
      setDeferredEvent(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setStandalone(true);
      setDeferredEvent(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | null> => {
    if (!deferredEvent) return null;
    await deferredEvent.prompt();
    const { outcome } = await deferredEvent.userChoice;
    setDeferredEvent(null); // one-time use — a fresh beforeinstallprompt is needed for next time
    return outcome;
  }, [deferredEvent]);

  return {
    isStandalone: standalone,
    isIOS: isIOS(),
    isMobile: isMobileDevice(),
    canPromptInstall: !!deferredEvent,
    promptInstall,
  };
}
