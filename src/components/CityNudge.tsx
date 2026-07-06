/**
 * One-time dialog asking a logged-in user for their city, so the "local"
 * section can eventually reflect where they actually are (2026-07-06).
 * Mumbai is always selectable; the rest unlock the moment the admin has
 * actually generated that city (usePlayer().generatedCities) — not only once
 * its static `available` flag in @/lib/news/sources is flipped in a deploy.
 * Skippable; the user can pick or change their city anytime from Settings.
 *
 * This intentionally fires before NotificationNudge (see CITY_RESOLVED_EVENT)
 * so the two first-open dialogs don't stack on top of each other.
 */
import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { CITIES, type CityId } from "@/lib/news/sources";
import { useCityPreference, useShouldPromptCity } from "@/hooks/useCityPreference";
import { usePlayer } from "@/context/player";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function CityNudge() {
  const { selectCity } = useCityPreference();
  const { shouldPrompt, dismiss } = useShouldPromptCity();
  const { generatedCities } = usePlayer();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!shouldPrompt) return;
    // Slightly ahead of NotificationNudge's 1.5s so this one shows first.
    const t = setTimeout(() => setOpen(true), 1000);
    return () => clearTimeout(t);
  }, [shouldPrompt]);

  function choose(id: CityId) {
    selectCity(id);
    setOpen(false);
  }

  function skip() {
    dismiss();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) skip(); }}>
      <DialogContent className="max-w-sm rounded-3xl">
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
                onClick={() => available && choose(c.id)}
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
            onClick={skip}
            className="w-full rounded-2xl px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.02]"
          >
            Skip for now
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
