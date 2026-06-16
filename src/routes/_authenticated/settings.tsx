import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { getPreferences, savePreferences } from "@/lib/voice/messages.functions";
import { ALL_CATEGORIES, SUPPORTED_COUNTRIES, type CountryCode } from "@/lib/news/sources";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings · Khabar AI" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();
  const getFn = useServerFn(getPreferences);
  const saveFn = useServerFn(savePreferences);
  const q = useQuery({ queryKey: ["prefs"], queryFn: () => getFn({ data: undefined as never }) });
  const [selected, setSelected] = useState<string[]>([]);
  const [home, setHome] = useState<CountryCode>("in");

  useEffect(() => {
    if (q.data?.categories) setSelected(q.data.categories);
    if (q.data?.home_country) setHome(q.data.home_country);
  }, [q.data]);

  const m = useMutation({
    mutationFn: (payload: { categories: string[]; home_country: CountryCode }) =>
      saveFn({ data: payload }),
    onSuccess: () => toast.success("Preferences saved"),
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  function toggle(c: string) {
    setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-2xl items-center gap-3 px-6 pt-6">
        <Link to="/" className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-serif text-2xl tracking-tight">Settings</h1>
      </header>

      <main className="mx-auto max-w-2xl space-y-10 px-6 py-10">
        <section>
          <h2 className="font-serif text-lg">Home country</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The country Khabar AI leads with each morning. Everything else becomes “Around the world.”
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SUPPORTED_COUNTRIES.map((c) => {
              const on = home === c.code;
              return (
                <button
                  key={c.code}
                  onClick={() => setHome(c.code)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-2xl border px-3 py-3 text-sm transition-colors",
                    on
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground",
                  )}
                >
                  <span className="text-2xl leading-none">{c.flag}</span>
                  <span className="text-xs">{c.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="font-serif text-lg">Interests</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Categories Khabar AI blends into your global briefing.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {ALL_CATEGORIES.map((c) => {
              const on = selected.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => toggle(c)}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-sm capitalize transition-colors",
                    on
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground",
                  )}
                >
                  {c}
                </button>
              );
            })}
          </div>
          <Button
            className="mt-6 rounded-full"
            disabled={selected.length === 0 || m.isPending}
            onClick={() => m.mutate({ categories: selected, home_country: home })}
          >
            {m.isPending ? "Saving…" : "Save preferences"}
          </Button>
        </section>

        <section>
          <h2 className="font-serif text-lg">Account</h2>
          <Button onClick={signOut} variant="outline" className="mt-4 rounded-full">
            Sign out
          </Button>
        </section>
      </main>
    </div>
  );
}
