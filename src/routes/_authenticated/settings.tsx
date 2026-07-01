import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Check, MessageCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { CITY_KEY, DEFAULT_CITY, MAJOR_CITIES } from "@/lib/news/sources";
import { BottomNav } from "@/components/BottomNav";

// WhatsApp number for feedback (country code, digits only, no +).
const FEEDBACK_WHATSAPP = "917447434554";

const LANGUAGE_KEY = "khabar-language";
const AVAILABLE_LANGS_KEY = "khabar-available-languages";

function readLanguage(): string {
  try { return localStorage.getItem(LANGUAGE_KEY) || "en"; } catch { return "en"; }
}

function readAvailableLanguages(): string[] {
  try {
    const stored = localStorage.getItem(AVAILABLE_LANGS_KEY);
    return stored ? JSON.parse(stored) : ["en", "hi"];
  } catch { return ["en", "hi"]; }
}

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings · Khabar AI" }] }),
  component: SettingsPage,
});

function readCity(): string {
  try { return localStorage.getItem(CITY_KEY) || DEFAULT_CITY; } catch { return DEFAULT_CITY; }
}

function SettingsPage() {
  const router = useRouter();
  const [selectedLang, setSelectedLang]       = useState<string>(readLanguage);
  const [availableLangs, setAvailableLangs]   = useState<string[]>(readAvailableLanguages);
  const [selectedCity, setSelectedCity]       = useState<string>(readCity);

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

  function selectLanguage(code: string) {
    setSelectedLang(code);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
      window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_KEY, newValue: code }));
    } catch {}
  }

  function selectCity(city: string) {
    setSelectedCity(city);
    try { localStorage.setItem(CITY_KEY, city); } catch {}
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 60px)" }}
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
            {[
              { code: "en", label: "English", nativeName: "English" },
              { code: "hi", label: "हिंदी",   nativeName: "Hindi"   },
              { code: "ta", label: "தமிழ்",   nativeName: "Tamil"   },
              { code: "mr", label: "मराठी",   nativeName: "Marathi" },
            ].map((lang) => {
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

        {/* Local news city */}
        <section>
          <h2 className="font-serif text-lg">Local News City</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Used for the Local section in your briefing.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {MAJOR_CITIES.map((city) => {
              const active = selectedCity === city;
              return (
                <button
                  key={city}
                  onClick={() => selectCity(city)}
                  className={cn(
                    "flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-left text-sm transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground font-medium"
                      : "border-border text-foreground/70 hover:border-border/80 hover:bg-black/[0.02]",
                  )}
                >
                  {active && <Check className="size-3.5 text-primary" />}
                  {city}
                </button>
              );
            })}
          </div>
        </section>

        {/* Feedback */}
        <section>
          <h2 className="font-serif text-lg">Feedback</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us what you love or what's missing — it goes straight to the team.
          </p>
          <a
            href={`https://wa.me/${FEEDBACK_WHATSAPP}?text=${encodeURIComponent("Khabar AI feedback: ")}`}
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
