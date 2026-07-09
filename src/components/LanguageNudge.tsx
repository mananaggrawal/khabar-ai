/**
 * One-time onboarding dialog for a logged-in user, asking for their
 * preferred language (2026-07-08). Used to be a two-step dialog that also
 * asked for a city (for the "local" news section) — the city step and the
 * "local" section itself were removed entirely per explicit request, so
 * this is back to a single step. Renamed from CityNudge accordingly.
 *
 * NOT skippable (explicit request) — no "Skip for now" button, no "X" close
 * affordance, and Escape/outside-click are both suppressed, so the only way
 * through is picking a language. The user can still change it anytime from
 * Settings afterward.
 *
 * This intentionally fires before NotificationNudge so the two first-open
 * prompts don't compete for attention.
 *
 * `shouldPrompt` and `userId` are passed in rather than computed here — the
 * root shell (__root.tsx) needs the same async first-login check to gate the
 * whole app's rendering via useOnboarding(), so it owns the single call and
 * hands the result down to avoid running that check twice.
 */
import { useEffect, useState } from "react";
import { Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGES, useLanguagePreference, readAvailableLanguages, type LanguageCode } from "@/hooks/useLanguagePreference";
import { markOnboardingDone } from "@/hooks/useOnboardingGate";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function LanguageNudge({ shouldPrompt, userId }: { shouldPrompt: boolean; userId: string | null }) {
  const { selectLanguage } = useLanguagePreference();
  const [open, setOpen] = useState(false);
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

  function chooseLanguage(code: LanguageCode) {
    selectLanguage(code);
    markOnboardingDone(userId); // unblocks the app via useOnboarding, scoped to this user
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
      </DialogContent>
    </Dialog>
  );
}
