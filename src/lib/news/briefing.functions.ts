/**
 * User-facing briefing server fn — read-only.
 * Generation is done once/day via the admin route; this just serves the result.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getLatestBriefing, type DailyBriefing } from "./generator";

export type { DailyBriefing as Briefing, BriefingTopic, BriefingSection } from "./generator";

export const fetchBriefing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<DailyBriefing | null> => {
    return getLatestBriefing();
  });
