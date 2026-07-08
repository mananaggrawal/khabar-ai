import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { CityNudge } from "@/components/CityNudge";
import { useShouldPromptCity } from "@/hooks/useCityPreference";
import { useOnboardingGate } from "@/hooks/useOnboardingGate";
import { VoiceOrb } from "@/components/VoiceOrb";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

// Shown instead of the real app while the mandatory city/language onboarding
// (see CityNudge) is still unresolved for a brand-new signup — otherwise
// Home would flash its content for a moment underneath the dialog right
// after login (2026-07-08).
function OnboardingGateScreen() {
  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-background">
      <VoiceOrb state="idle" size={160} />
      <div className="flex flex-col items-center gap-1">
        <span className="font-serif text-2xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <p className="text-xs text-muted-foreground animate-pulse">Setting things up…</p>
      </div>
    </div>
  );
}

function AuthenticatedShell() {
  // Single source of truth for "does this login need the onboarding dialog"
  // — computed once here and handed down to CityNudge as a prop, rather than
  // each of this component and CityNudge running their own async
  // isFirstEverLogin() check independently.
  const { shouldPrompt, resolved } = useShouldPromptCity();
  const ready = useOnboardingGate(shouldPrompt, resolved);

  return (
    <>
      {ready ? <Outlet /> : <OnboardingGateScreen />}
      <CityNudge shouldPrompt={shouldPrompt} />
      {/* NotificationNudge moved to Home (2026-07-06) — it's now an inline
          banner like InstallNudge, not a global popup, so it belongs next to
          that banner rather than mounted app-wide. */}
    </>
  );
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    if (LOCAL_MODE) return { user: { id: "local-user", email: "local@local" } };
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedShell,
});
