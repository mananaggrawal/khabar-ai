import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const saveMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      briefingId: z.string().uuid(),
      role: z.enum(["user", "agent", "system"]),
      content: z.string().min(1).max(8000),
    }),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("messages").insert({
      briefing_id: data.briefingId,
      user_id: context.userId,
      role: data.role,
      content: data.content,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listBriefings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // In LOCAL_MODE, read directly from the generator's local store
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const raw = await readFile(join(process.cwd(), ".local-data", "briefings.json"), "utf-8");
      const all = JSON.parse(raw) as Array<{
        id: string; generatedAt: string; date: string; topics: unknown[];
      }>;
      return all.map((b) => ({
        id: b.id,
        generated_at: b.generatedAt,
        topics: b.topics,
      }));
    } catch {
      return [];
    }
  });

const DEFAULT_PREFS = {
  categories: [
    "india-national", "india-business", "india-sports", "india-tech", "india-entertainment",
    "global-world", "global-business", "global-sports", "global-tech", "global-health",
  ] as string[],
  voice_id: "nPczCjzI2devNBz1zQrb",
  home_country: "in" as "in" | "us" | "uk" | "global",
};

export const getPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("preferences")
      .select("categories, voice_id, home_country")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return DEFAULT_PREFS;
    return {
      categories: (data.categories as string[]) ?? DEFAULT_PREFS.categories,
      voice_id: (data.voice_id as string) ?? DEFAULT_PREFS.voice_id,
      home_country: ((data as any).home_country as "in" | "us" | "uk" | "global") ?? DEFAULT_PREFS.home_country,
    };
  });

export const savePreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      categories: z.array(z.string()).min(1).max(20).optional(),
      voice_id: z.string().optional(),
      home_country: z.enum(["in", "us", "uk", "global"]).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    // Read existing to preserve unchanged fields
    const { data: existing } = await context.supabase
      .from("preferences")
      .select("categories, voice_id, home_country")
      .eq("user_id", context.userId)
      .maybeSingle();

    const payload = {
      user_id: context.userId,
      categories: data.categories ?? existing?.categories ?? DEFAULT_PREFS.categories,
      voice_id: data.voice_id ?? existing?.voice_id ?? DEFAULT_PREFS.voice_id,
      home_country: data.home_country ?? (existing as any)?.home_country ?? DEFAULT_PREFS.home_country,
      updated_at: new Date().toISOString(),
    };
    const { error } = await context.supabase.from("preferences").upsert(payload);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
