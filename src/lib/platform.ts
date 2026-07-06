/**
 * Shared device/PWA-install-state detection. Previously isIOS()/isStandalone()
 * lived as private helpers inside usePushNotifications.ts — pulled out here
 * (2026-07-06) so useInstallPrompt.ts can reuse the exact same checks instead
 * of duplicating UA-sniffing logic that's easy to get subtly wrong twice.
 */

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
}

export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/.test(navigator.userAgent);
}

// Used to gate the install nudge to mobile only (2026-07-06 decision) — this
// is a personal, phone-first listening app, and desktop Chrome/Edge also fire
// beforeinstallprompt, which would otherwise make the nudge show there too.
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  if ((navigator as any).userAgentData?.mobile != null) return !!(navigator as any).userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent);
}

// True once the app is running as an installed PWA (home-screen icon / app
// window), not a regular browser tab — checked live, not cached, so it flips
// to true the moment the user installs without needing a reload-triggered
// re-check anywhere that reads it via a hook.
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true
  );
}
