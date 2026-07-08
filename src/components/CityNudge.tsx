/**
 * One-time onboarding dialog for a logged-in user, asking for their city
 * (2026-07-06) and, right after, their preferred language (2026-07-08) — two
 * steps in the same dialog rather than two separate popups. Mumbai is always
 * selectable for city; the rest unlock the moment the admin has actually
 * generated that city (usePlayer().generatedCities) — not only once its
 * static `available` flag in @/lib/news/sources is flipped in a deploy.
 *
 * NEITHER step is skippable (2026-07-08, explicit request) — no "Skip for
 * now" buttons, no "X" close affordance, and Escape/outside-click are both
 * suppressed, so the only way through is picking an option on each step. The
 * user can still change either choice anytime from Settings afterward.
 *
 * This intentionally fires before NotificationNudge (see CITY_RESOLVED_EVENT)
 * so the two first-open prompts don't compete for attention.
 *
 * `shouldPrompt` is passed in rather than computed here (2026-07-08) — the
 * route shell (_authenticated/route.tsx) needs the same async
 * isFirstEverLogin() result to gate Home's rendering via useOnboardingGate,
 * so it owns the single useShouldPromptCity() call and hands the result down
 * to avoid running that check twice.
 */
import { useEffect, useState } from "react";
import { MapPin, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { CITIES, type CityId } from "@/lib/news/sources";
import { useCityPreference } from "@/hooks/useCityPreference";
import { LANGUAGES, useLanguagePreference, readAvailableLanguages, type LanguageCode } from "@/hooks/useLanguagePreference";
import { markOnboardingDone } from "@/hooks/useOnboardingGate";
import { usePlayer } from "@/context/player";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Step = "city" | "language";

export function CityNudge({ shouldPrompt }: { shouldPrompt: boolean }) {
  const { selectCity } = useCityPreference();
  const { selectLanguage } = useLanguagePreference();
  const { generatedCities } = usePlayer();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("city");
  const [availableLangs, setAvailableLangs] = useState<string[]>(readAvailableLanguages);

  useEffect(() => {
    if (!shouldPrompt) return;
    // Slightly ahead of NotificationNudge's 1.5s so this one shows first.
    const t = setTimeout(() => setOpen(true), 1000);
    return () => clearTimeout(t);
  }, [shouldPrompt]);

  // Refresh available languages right as the dialog opens — at 1s post-login
  // the day's briefing may not have finished loading yet, so this catches up
  // if PlayerProvider's computation lands a moment later.
  useEffect(() => {
    if (open) setAvailableLangs(readAvailableLanguages());
  }, [open]);

  function chooseCity(id: CityId) {
    selectCity(id); // also marks the city step resolved internally
    setStep("language");
  }

  function chooseLanguage(code: LanguageCode) {
    selectLanguage(code);
    markOnboardingDone(); // unblocks Home via useOnboardingGate
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={() => { /* mandatory — no-op, can't be closed except by choosing */ }}>
      <DialogContent
        className="max-w-sm rounded-3xl"
        hideCloseButton
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {step === "city" ? (
          <>
            <DialogHeader>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
                <MapPin className="size-6 text-primary" />
              </div>
              <DialogTitle className="mt-3 text-center font-serif text-xl">
                What's your city?
              </DialogTitle>
              <DialogDescription className="text-center">
                Get local news alongside your daily briefing.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-2 space-y-2">
              {CITIES.map((c) => {
                const available = c.available || generatedCities.has(c.id);
                return (
                  <button
                    key={c.id}
                    disabled={!available}
                    onClick={() => available && chooseCity(c.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm font-medium transition-colors",
                      available
                        ? "border-border text-foreground hover:border-border/80 hover:bg-black/[0.02]"
                        : "border-border/40 text-muted-foreground/40 cursor-not-allowed",
                    )}
                  >
                    <span>{c.label}</span>
                    {!available && (
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">Coming soon</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Languages className="size-6 text-primary" />
              </div>
              <DialogTitle className="mt-3 text-center font-serif text-xl">
                What language do you prefer?
              </DialogTitle>
              <DialogDescription className="text-center">
                Your daily briefing, read the way you like.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-2 space-y-2">
              {LANGUAGES.map((l) => {
                const available = availableLangs.includes(l.code);
                return (
                  <button
                    key={l.code}
                    disabled={!available}
                    onClick={() => available && chooseLanguage(l.code)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm font-medium transition-colors",
                      available
                        ? "border-border text-foreground hover:border-border/80 hover:bg-black/[0.02]"
                        : "border-border/40 text-muted-foreground/40 cursor-not-allowed",
                    )}
                  >
                    <span className="flex items-baseline gap-2">
                      <span>{l.label}</span>
                      <span className="text-xs text-muted-foreground/60">{l.nativeName}</span>
                    </span>
                    {!available && (
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">Not generated</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
