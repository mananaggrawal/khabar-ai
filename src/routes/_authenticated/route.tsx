import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { CityNudge } from "@/components/CityNudge";

const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === "true";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    if (LOCAL_MODE) return { user: { id: "local-user", email: "local@local" } };
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: () => (
    <>
      <Outlet />
      <CityNudge />
      {/* NotificationNudge moved to Home (2026-07-06) — it's now an inline
          banner like InstallNudge, not a global popup, so it belongs next to
          that banner rather than mounted app-wide. */}
    </>
  ),
});
