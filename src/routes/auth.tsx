import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

function useApplyTheme() {
  useEffect(() => {
    // Sign-in page is always light mode
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  }, []);
}
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { VoiceOrb } from "@/components/VoiceOrb";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · Khabar AI" },
      { name: "description", content: "Sign in to Khabar AI to start your daily voice briefing." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  useApplyTheme();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.navigate({ to: "/" });
    });
  }, [router]);

  async function signInWithGoogle() {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      // Supabase redirects the browser; no further action needed
    } catch (err: any) {
      toast.error(err?.message ?? "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "var(--bg-gradient)" }}
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-10 px-6">
        <VoiceOrb state="idle" size={160} />
        <div className="text-center">
          <h1 className="font-serif text-5xl tracking-tight">
            Khabar <span className="italic text-primary">AI</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Today's news, spoken. Sign in to start.
          </p>
        </div>

        <Button
          onClick={signInWithGoogle}
          disabled={busy}
          className="h-12 w-full rounded-full bg-white text-[15px] font-medium text-neutral-900 hover:bg-white/90"
        >
          <GoogleLogo />
          {busy ? "Connecting…" : "Continue with Google"}
        </Button>

      </div>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" fill="#34A853"/>
      <path d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84Z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" fill="#EA4335"/>
    </svg>
  );
}
