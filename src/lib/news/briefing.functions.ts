import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchRss } from "./rss";
import { RSS_SOURCES, ALL_CATEGORIES, type Category } from "./sources";

export type BriefingTopic = {
  id: string;
  headline: string;
  hook: string;
  explanation: string;
  whyItMatters: string;
  sources: { name: string; url: string }[];
  followUps: string[];
};

export type Briefing = {
  id: string;
  generatedAt: string;
  topics: BriefingTopic[];
  totalSources: number;
};

const CategorySchema = z.enum(ALL_CATEGORIES);

export const fetchBriefing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      categories: z.array(CategorySchema).optional(),
      force: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<Briefing> => {
    const { supabase, userId } = context;

    // Reuse a briefing generated in the last 90 minutes unless forced.
    if (!data.force) {
      const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("briefings")
        .select("id, generated_at, topics, sources")
        .eq("user_id", userId)
        .gte("generated_at", since)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) {
        return {
          id: recent.id,
          generatedAt: recent.generated_at,
          topics: recent.topics as BriefingTopic[],
          totalSources: Array.isArray(recent.sources) ? recent.sources.length : 0,
        };
      }
    }

    const cats: Category[] =
      data.categories && data.categories.length > 0
        ? data.categories
        : (await loadPreferredCategories(supabase, userId));

    const wantedSources = RSS_SOURCES.filter(
      (s) => s.category === "top" || cats.includes(s.category as Category),
    );

    const all = (
      await Promise.all(
        wantedSources.map((s) => fetchRss(s.url, s.name, s.id)),
      )
    ).flat();

    // Filter to last 18 hours when pubDate is parseable
    const cutoff = Date.now() - 18 * 60 * 60 * 1000;
    const recentItems = all.filter((it) => {
      if (!it.pubDate) return true;
      const t = Date.parse(it.pubDate);
      return Number.isNaN(t) ? true : t >= cutoff;
    });

    // Dedupe by lowercased title
    const seen = new Set<string>();
    const deduped = recentItems.filter((it) => {
      const k = it.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Cap headlines fed to the model
    const top = deduped.slice(0, 60);

    const topics = await summarizeWithLLM(top);

    const sourceList = top.map((t) => ({
      title: t.title,
      url: t.link,
      source: t.source,
    }));

    const { data: inserted, error } = await supabase
      .from("briefings")
      .insert({
        user_id: userId,
        topics: topics as unknown as object,
        sources: sourceList as unknown as object,
      })
      .select("id, generated_at")
      .single();

    if (error || !inserted) {
      throw new Error(error?.message || "Failed to persist briefing");
    }

    return {
      id: inserted.id,
      generatedAt: inserted.generated_at,
      topics,
      totalSources: sourceList.length,
    };
  });

async function loadPreferredCategories(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<Category[]> {
  const { data } = await supabase
    .from("preferences")
    .select("categories")
    .eq("user_id", userId)
    .maybeSingle();
  const cats = (data?.categories as string[] | undefined) ?? [];
  const valid = cats.filter((c): c is Category =>
    (ALL_CATEGORIES as readonly string[]).includes(c),
  );
  return valid.length ? valid : ["world", "tech", "markets", "science"];
}

async function summarizeWithLLM(items: { title: string; link: string; source: string; description?: string }[]): Promise<BriefingTopic[]> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || items.length === 0) {
    return fallbackTopics(items);
  }

  const headlineList = items
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.description ? ` — ${it.description.slice(0, 160)}` : ""}`)
    .join("\n");

  const system = `You are NewsPilot, an intellectual-but-amusing news anchor.
You cluster the day's raw headlines into 5–7 distinct global topics and explain each in plain English.
Be witty without being flippant. Cite sources by name. Never invent facts beyond the headlines.
Output STRICT JSON only — no markdown, no commentary.`;

  const userMsg = `Today's headlines (numbered):

${headlineList}

Return JSON: { "topics": [ { "id": "kebab-slug", "headline": "string", "hook": "one-line teaser", "explanation": "60-90 words plain English", "whyItMatters": "one sentence", "sources": [{"name":"...","url":"..."}], "followUps": ["short question", "short question"] } ] }

Use the EXACT urls from the numbered list above for sources. Pick the 2-3 best sources per topic. 5 to 7 topics total.`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("LLM briefing failed", res.status, await res.text());
      return fallbackTopics(items);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.topics) && parsed.topics.length > 0) {
      return parsed.topics.map((t: any, i: number): BriefingTopic => ({
        id: t.id ?? `topic-${i}`,
        headline: String(t.headline ?? "Untitled"),
        hook: String(t.hook ?? ""),
        explanation: String(t.explanation ?? ""),
        whyItMatters: String(t.whyItMatters ?? ""),
        sources: Array.isArray(t.sources) ? t.sources.slice(0, 4).map((s: any) => ({
          name: String(s.name ?? ""), url: String(s.url ?? ""),
        })) : [],
        followUps: Array.isArray(t.followUps) ? t.followUps.slice(0, 4).map(String) : [],
      }));
    }
    return fallbackTopics(items);
  } catch (e) {
    console.error("LLM call error", e);
    return fallbackTopics(items);
  }
}

function fallbackTopics(items: { title: string; link: string; source: string }[]): BriefingTopic[] {
  return items.slice(0, 6).map((it, i) => ({
    id: `topic-${i}`,
    headline: it.title,
    hook: "",
    explanation: "Live AI summary unavailable — showing the raw headline. Tap to read the source.",
    whyItMatters: "",
    sources: [{ name: it.source, url: it.link }],
    followUps: [],
  }));
}
