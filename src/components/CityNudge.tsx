/**
 * One-time onboarding dialog for a logged-in user, asking for their city
 * (2026-07-06) and, right after, their preferred language (2026-07-08) — two
 * steps in the same dialog rather than two separate popups. Mumbai is always
 * selectable for city; the rest unlock the moment the admin has actually
 * generated that city (usePlayer().generatedCities) — not only once its
 * static `available` flag in @/lib/news/sources is flipped in a deploy.
 * Both steps are skippable; the user can change either choice anytime from
 * Settings.
 *
 * This intentionally fires before NotificationNudge (see CITY_RESOLVED_EVENT)
 * so the two first-open prompts don't compete for attention.
 */
import { useEffect, useState } from "react";
import { MapPin, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { CITIES, type CityId } from "@/lib/news/sources";
import { useCityPreference, useShouldPromptCity } from "@/hooks/useCityPreference";
import { LANGUAGES, useLanguagePreference, readAvailableLanguages, type LanguageCode } from "@/hooks/useLanguagePreference";
import { usePlayer } from "@/context/player";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type Step = "city" | "language";

export function CityNudge() {
  const { selectCity } = useCityPreference();
  const { selectLanguage } = useLanguagePreference();
  const { shouldPrompt, dismiss } = useShouldPromptCity();
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

  function skipCity() {
    dismiss(); // marks the city step resolved (asked-and-skipped)
    setStep("language");
  }

  function chooseLanguage(code: LanguageCode) {
    selectLanguage(code);
    setOpen(false);
  }

  function skipLanguage() {
    setOpen(false);
  }

  // Overlay click / Escape — close entirely rather than forcing the user
  // through whichever step they were on if they clearly just want out.
  function handleOpenChange(next: boolean) {
    if (next) return;
    if (step === "city") dismiss();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm rounded-3xl">
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

            <DialogFooter className="mt-2 sm:flex-col sm:space-x-0 sm:gap-2">
              <button
                onClick={skipCity}
                className="w-full rounded-2xl px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.02]"
              >
                Skip for now
              </button>
            </DialogFooter>
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

            <DialogFooter className="mt-2 sm:flex-col sm:space-x-0 sm:gap-2">
              <button
                onClick={skipLanguage}
                className="w-full rounded-2xl px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.02]"
              >
                Skip for now
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
