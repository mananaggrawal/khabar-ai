/**
 * User-facing briefing server fn — read-only.
 * Generation is done once/day via the admin route; this just serves the result.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getLatestBriefing, generateMissingSections, type DailyBriefing } from "./generator";

export type { DailyBriefing as Briefing, BriefingTopic, BriefingSection } from "./generator";

export const fetchBriefing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<DailyBriefing | null> => {
    return getLatestBriefing();
  });

export const listBriefings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<Array<{ date: string; sections: number; totalTopics: number; generatedAt?: string }>> => {
    const { loadBriefingFromStorage } = await import("@/lib/supabase-storage");
    const results = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      try {
        const b = await loadBriefingFromStorage(date) as any;
        if (b?.sections) {
          results.push({
            date,
            sections: b.sections.length,
            totalTopics: b.sections.reduce((n: number, s: any) => n + (s.topics?.length ?? 0), 0),
            generatedAt: b.generatedAt,
          });
        }
      } catch {}
    }
    return results;
  });

export const patchMissingSections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ added: string[] }> => {
    const { added } = await generateMissingSections((msg) => console.log(msg));
    return { added };
  });
