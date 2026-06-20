import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { CITY_KEY, DEFAULT_CITY, MAJOR_CITIES } from "@/lib/news/sources";
import { BottomNav } from "@/components/BottomNav";

const LANGUAGE_KEY = "khabar-language";

function readLanguage(): "en" | "hi" {
  try { return (localStorage.getItem(LANGUAGE_KEY) as "en" | "hi") || "en"; } catch { return "en"; }
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
  const [selectedLang, setSelectedLang] = useState<string>(readLanguage);
  const [selectedCity, setSelectedCity] = useState<string>(readCity);

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
        className="flex items-center justify-between px-5 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
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
              { code: "en", label: "English",        available: true  },
              { code: "hi", label: "हिंदी (Hindi)",  available: true  },
              { code: "ta", label: "Tamil",           available: false },
              { code: "mr", label: "Marathi",         available: false },
            ].map((lang) => {
              const active = lang.available && selectedLang === lang.code;
              return (
                <button
                  key={lang.code}
                  disabled={!lang.available}
                  onClick={() => lang.available && selectLanguage(lang.code)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : lang.available
                      ? "border-border text-foreground/70 hover:border-border/80 hover:bg-black/[0.02]"
                      : "border-border/40 text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <span className="flex-1 text-sm font-medium">{lang.label}</span>
                  {active ? (
                    <span className="flex size-5 items-center justify-center rounded-full border border-primary bg-primary">
                      <svg viewBox="0 0 20 20" fill="white" className="size-full p-0.5">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </span>
                  ) : !lang.available ? (
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">Soon</span>
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
                  {active && <span className="text-primary">✓</span>}
                  {city}
                </button>
              );
            })}
          </div>
        </section>

        {/* Account */}
        <section>
          <h2 className="font-serif text-lg">Account</h2>
          <Button onClick={signOut} variant="outline" className="mt-4 rounded-full">
            Sign out
          </Button>
        </section>


      </main>

      <BottomNav />
    </div>
  );
}
