/**
 * User-facing briefing server fns — read-only.
 * Generation is done via admin routes; these just serve the result.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getLatestBriefing, type DailyBriefing } from "./generator";

export type { DailyBriefing, Story } from "./generator";

export const fetchBriefing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<DailyBriefing | null> => {
    return getLatestBriefing();
  });
