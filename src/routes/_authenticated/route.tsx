import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

// CityNudge + the onboarding gate moved to __root.tsx (2026-07-08) — this
// layout only wraps _authenticated/* pages (Settings, History, Browse), NOT
// "/" (Home, routes/index.tsx), which is a sibling top-level route rather
// than a child of this one. Mounting them here left Home completely
// ungated. See __root.tsx's OnboardingGate for the full explanation.
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    if (LOCAL_MODE) return { user: { id: "local-user", email: "local@local" } };
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: () => <Outlet />,
});
