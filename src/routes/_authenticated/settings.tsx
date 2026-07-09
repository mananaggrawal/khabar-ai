import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { MessageCircle, Bell, BellOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { BottomNav } from "@/components/BottomNav";
import { InstallNudge } from "@/components/InstallNudge";
import { usePlayer } from "@/context/player";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { LANGUAGES, useLanguagePreference, readAvailableLanguages } from "@/hooks/useLanguagePreference";

// WhatsApp number for feedback (country code, digits only, no +).
const FEEDBACK_WHATSAPP = "917447434554";

const AVAILABLE_LANGS_KEY = "khabar-available-languages";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings · Khabar AI" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();
  const { mono } = usePlayer();
  const hasMiniPlayer = mono.state === "playing" || mono.state === "paused";
  const { language: selectedLang, selectLanguage } = useLanguagePreference();
  const [availableLangs, setAvailableLangs]   = useState<string[]>(readAvailableLanguages);
  const push = usePushNotifications();

  // Re-read available languages on mount
  useEffect(() => {
    setAvailableLangs(readAvailableLanguages());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AVAILABLE_LANGS_KEY) {
        try { setAvailableLangs(JSON.parse(e.newValue ?? "[]")); } catch {}
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  async function signOut() {
    // Stop playback first (2026-07-08 fix) — PlayerProvider lives above the
    // routes so audio survives normal tab navigation, but that meant signing
    // out while something was playing left the mini-player floating on top
    // of the signed-out /auth screen, fully interactive, with no session
    // behind it at all.
    mono.stop();
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col"
      style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${hasMiniPlayer ? 132 : 60}px)` }}
    >
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-5 pb-2 bg-background/95 backdrop-blur-sm"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <span className="text-xs text-muted-foreground">
          Today's news, <em className="font-semibold italic">spoken.</em>
        </span>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl space-y-10 px-6 py-4 overflow-y-auto">

        {/* Language */}
        <section>
          <h2 className="font-serif text-lg">Language</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The language your briefing is read in.
          </p>
          <div className="mt-4 space-y-2">
            {LANGUAGES.map((lang) => {
              const available = availableLangs.includes(lang.code);
              const active = available && selectedLang === lang.code;
              return (
                <button
                  key={lang.code}
                  disabled={!available}
                  onClick={() => available && selectLanguage(lang.code)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : available
                      ? "border-border text-foreground/70 hover:border-border/80 hover:bg-black/[0.02]"
                      : "border-border/40 text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <span className="flex-1 text-sm font-medium">{lang.label}</span>
                  <span className="text-xs text-muted-foreground/60">{lang.nativeName}</span>
                  {active ? (
                    <span className="flex size-5 items-center justify-center rounded-full border border-primary bg-primary">
                      <svg viewBox="0 0 20 20" fill="white" className="size-full p-0.5">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </span>
                  ) : !available ? (
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">Not generated</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        {/* Install app — renders nothing once the PWA is installed */}
        <InstallNudge variant="row" />

        {/* Notifications */}
        <section>
          <h2 className="font-serif text-lg">Notifications</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Get a nudge when your morning and evening briefing are ready.
          </p>
          <div className="mt-4">
            {!push.supported ? (
              <div className="rounded-2xl border border-border/40 px-4 py-3 text-sm text-muted-foreground">
                Notifications aren't supported in this browser.
              </div>
            ) : (
              <button
                onClick={() => (push.subscribed ? push.unsubscribe() : push.subscribe())}
                disabled={push.loading}
                className={cn(
                  "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-60",
                  push.subscribed
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border text-foreground/70 hover:border-border/80 hover:bg-black/[0.02]",
                )}
              >
                {push.subscribed ? <Bell className="size-4 text-primary" /> : <BellOff className="size-4 text-muted-foreground" />}
                <span className="flex-1 text-sm font-medium">
                  {push.loading ? "Working…" : push.subscribed ? "Notifications on" : "Turn on notifications"}
                </span>
                {push.subscribed && (
                  <span className="text-[10px] uppercase tracking-widest text-primary/70">Tap to turn off</span>
                )}
              </button>
            )}
            {push.error && (
              <p className="mt-2 text-xs text-destructive/80">{push.error}</p>
            )}
          </div>
        </section>

        {/* Feedback */}
        <section>
          <h2 className="font-serif text-lg">Feedback</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us what you love or what's missing — it goes straight to the team.
          </p>
          <a
            href={`https://wa.me/${FEEDBACK_WHATSAPP}?text=${encodeURIComponent("Hi! I'm using Khabar AI and wanted to share some feedback: ")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-black/[0.02] transition-colors"
          >
            <MessageCircle className="size-4 text-primary" />
            Send feedback on WhatsApp
          </a>
        </section>

        {/* Account */}
        <section>
          <h2 className="font-serif text-lg">Account</h2>
          <button
            onClick={signOut}
            className="mt-4 flex items-center rounded-2xl border border-destructive/30 px-5 py-2.5 text-sm font-medium text-destructive/80 hover:bg-destructive/5 transition-colors"
          >
            Sign out
          </button>
        </section>

      </main>

      <BottomNav />
    </div>
  );
}
