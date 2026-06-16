import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VoiceOrb } from "@/components/VoiceOrb";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · NewsPilot" },
      { name: "description", content: "Sign in to NewsPilot to start your daily voice briefing." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.navigate({ to: "/" });
    });
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "sign-up") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        toast.success("Account created. Check your email if confirmation is required.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      router.navigate({ to: "/" });
    } catch (err: any) {
      toast.error(err?.message ?? "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 20%, oklch(0.22 0.04 290 / 0.7), transparent 60%)",
        }}
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-8 px-6">
        <VoiceOrb state="idle" size={140} />
        <div className="text-center">
          <h1 className="font-serif text-4xl tracking-tight">
            News<span className="italic text-primary">Pilot</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "sign-in" ? "Welcome back." : "Create your account."}
          </p>
        </div>

        <form onSubmit={submit} className="w-full space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="h-11 bg-white/5"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              className="h-11 bg-white/5"
            />
          </div>
          <Button type="submit" disabled={busy} className="h-11 w-full rounded-full text-base">
            {busy ? "…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
