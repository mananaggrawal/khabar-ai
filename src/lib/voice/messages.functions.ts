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
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("briefings")
      .select("id, generated_at, topics")
      .eq("user_id", context.userId)
      .order("generated_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("preferences")
      .select("categories, voice_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? { categories: ["world", "tech", "markets", "science"], voice_id: "nPczCjzI2devNBz1zQrb" };
  });

export const savePreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      categories: z.array(z.string()).min(1).max(8),
      voice_id: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("preferences")
      .upsert({
        user_id: context.userId,
        categories: data.categories,
        voice_id: data.voice_id ?? "nPczCjzI2devNBz1zQrb",
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
