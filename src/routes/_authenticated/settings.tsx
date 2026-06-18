import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings · Khabar AI" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-2xl items-center gap-3 px-6 pt-6">
        <Link
          to="/"
          className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-serif text-2xl tracking-tight">Settings</h1>
      </header>

      <main className="mx-auto max-w-2xl space-y-10 px-6 py-10">

        {/* Language */}
        <section>
          <h2 className="font-serif text-lg">Language</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The language your briefing is read in. More coming soon.
          </p>
          <div className="mt-4 space-y-2">
            {[
              { code: "en", label: "English", available: true  },
              { code: "hi", label: "Hindi",   available: false },
              { code: "ta", label: "Tamil",   available: false },
              { code: "mr", label: "Marathi", available: false },
            ].map((lang) => (
              <div
                key={lang.code}
                className={cn(
                  "flex items-center gap-3 rounded-2xl border px-4 py-3",
                  lang.available
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-white/10 text-muted-foreground/50 cursor-not-allowed",
                )}
              >
                <span className="flex-1 text-sm font-medium">{lang.label}</span>
                {lang.available ? (
                  <span className="flex size-5 items-center justify-center rounded-full border border-primary bg-primary">
                    <svg viewBox="0 0 20 20" fill="white" className="size-full p-0.5">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">Soon</span>
                )}
              </div>
            ))}
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
    </div>
  );
}
