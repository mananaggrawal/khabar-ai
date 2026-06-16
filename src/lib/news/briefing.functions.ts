import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchRss, type RssItem } from "./rss";
import { RSS_SOURCES, ALL_CATEGORIES, type Category } from "./sources";
import { dedupeByTitle } from "./cluster";

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
  totalTopics?: number;
  coverageWindowStart?: string;
};

const CategorySchema = z.enum(ALL_CATEGORIES);

const CHUNK_SIZE = 120;
const MAX_CHUNKS = 8; // hard ceiling — never feed > 8*120 = 960 items into LLM

export const fetchBriefing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      categories: z.array(CategorySchema).optional(),
      force: z.boolean().optional(),
      timezone: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<Briefing> => {
    const { supabase, userId } = context;

    // Determine user's timezone (client-passed wins, else stored preference, else UTC)
    const tz = data.timezone || (await loadTimezone(supabase, userId));
    const midnight = startOfLocalDayUTC(tz);

    // Reuse today's briefing unless forced (keyed on calendar day in user's TZ)
    if (!data.force) {
      const { data: recent } = await supabase
        .from("briefings")
        .select("id, generated_at, topics, sources, total_topics, coverage_window_start")
        .eq("user_id", userId)
        .gte("generated_at", midnight.toISOString())
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) {
        return {
          id: recent.id,
          generatedAt: recent.generated_at,
          topics: recent.topics as BriefingTopic[],
          totalSources: Array.isArray(recent.sources) ? recent.sources.length : 0,
          totalTopics: recent.total_topics ?? undefined,
          coverageWindowStart: recent.coverage_window_start ?? undefined,
        };
      }
    }

    const cats: Category[] =
      data.categories && data.categories.length > 0
        ? data.categories
        : await loadPreferredCategories(supabase, userId);

    const wantedSources = RSS_SOURCES.filter(
      (s) => s.category === "top" || cats.includes(s.category as Category),
    );

    const fetched = (
      await Promise.all(
        wantedSources.map((s) => fetchRss(s.url, s.name, s.id)),
      )
    ).flat();

    // Filter by local-midnight cutoff (keep items with unparseable dates)
    const cutoff = midnight.getTime();
    const recentItems = fetched.filter((it) => {
      if (!it.pubDate) return true;
      const t = Date.parse(it.pubDate);
      return Number.isNaN(t) ? true : t >= cutoff;
    });

    // Strong dedupe (Jaccard on title shingles)
    const deduped = dedupeByTitle(recentItems, 0.55);

    // Sort: prefer items with a known pubDate, newest first
    deduped.sort((a, b) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return (tb || 0) - (ta || 0);
    });

    const capped = deduped.slice(0, CHUNK_SIZE * MAX_CHUNKS);
    const chunks = chunk(capped, CHUNK_SIZE);

    const topics = await summarizeAll(chunks);

    const sourceList = capped.map((t) => ({
      title: t.title,
      url: t.link,
      source: t.source,
    }));

    const { data: inserted, error } = await supabase
      .from("briefings")
      .insert({
        user_id: userId,
        topics: topics as any,
        sources: sourceList as any,
        total_topics: topics.length,
        total_clusters_raw: capped.length,
        coverage_window_start: midnight.toISOString(),
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
      totalTopics: topics.length,
      coverageWindowStart: midnight.toISOString(),
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

async function loadTimezone(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("preferences")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.timezone as string | undefined) || "UTC";
}

/** Returns the UTC Date that corresponds to 00:00 of the current day in `tz`. */
function startOfLocalDayUTC(tz: string): Date {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const y = get("year"), m = get("month"), d = get("day");
    const h = get("hour"), mi = get("minute"), s = get("second");
    // offset (ms) of tz relative to UTC right now
    const asUTC = Date.UTC(y, m - 1, d, h, mi, s);
    const offset = asUTC - now.getTime();
    // local midnight in UTC = UTC(y,m,d,0,0,0) - offset
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset);
  } catch {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, 0));
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ───────────────────────── LLM pipeline ─────────────────────────

type RawCluster = {
  headline: string;
  memberIndices: number[]; // 1-based indices into the chunk's headline list
};

async function summarizeAll(chunks: RssItem[][]): Promise<BriefingTopic[]> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || chunks.length === 0 || chunks.every((c) => c.length === 0)) {
    return fallbackTopics(chunks.flat());
  }

  // PASS A — cluster each chunk in parallel
  const clustersPerChunk = await Promise.all(
    chunks.map((c) => clusterChunk(c, apiKey)),
  );

  // Resolve cluster member items by chunk-relative indices
  type ResolvedCluster = { headline: string; items: RssItem[] };
  const resolved: ResolvedCluster[] = [];
  clustersPerChunk.forEach((clusters, ci) => {
    const chunkItems = chunks[ci];
    for (const cl of clusters) {
      const items = cl.memberIndices
        .map((i) => chunkItems[i - 1])
        .filter((x): x is RssItem => !!x);
      if (items.length > 0) resolved.push({ headline: cl.headline, items });
    }
  });

  if (resolved.length === 0) return fallbackTopics(chunks.flat());

  // PASS B — merge cross-chunk duplicates + write topics
  return await mergeAndWrite(resolved, apiKey);
}

async function clusterChunk(items: RssItem[], apiKey: string): Promise<RawCluster[]> {
  if (items.length === 0) return [];
  const list = items
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.description ? ` — ${it.description.slice(0, 140)}` : ""}`)
    .join("\n");

  const system = `You group raw news headlines into distinct story clusters. Output STRICT JSON only.`;
  const user = `Headlines:\n${list}\n\nReturn { "clusters": [ { "headline": "short canonical headline", "memberIndices": [1,4,12] } ] }
Rules:
- Every headline must belong to exactly one cluster (no orphans, no duplicates).
- Cluster aggressively: headlines about the same underlying event/story go together even if wording differs.
- Use as many clusters as needed — do not artificially limit. Typical chunk yields 30-80 clusters.
- "headline" is a clean, neutral one-liner.`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("[briefing] clusterChunk failed", res.status, await res.text());
      // Fallback: one cluster per item
      return items.map((it, i) => ({ headline: it.title, memberIndices: [i + 1] }));
    }
    const json = await res.json();
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
    if (Array.isArray(parsed.clusters)) {
      return parsed.clusters
        .map((c: any) => ({
          headline: String(c.headline ?? "Untitled"),
          memberIndices: Array.isArray(c.memberIndices)
            ? c.memberIndices.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 1)
            : [],
        }))
        .filter((c: RawCluster) => c.memberIndices.length > 0);
    }
    return items.map((it, i) => ({ headline: it.title, memberIndices: [i + 1] }));
  } catch (e) {
    console.error("[briefing] clusterChunk error", e);
    return items.map((it, i) => ({ headline: it.title, memberIndices: [i + 1] }));
  }
}

async function mergeAndWrite(
  clusters: { headline: string; items: RssItem[] }[],
  apiKey: string,
): Promise<BriefingTopic[]> {
  // Order clusters by source-diversity * size * recency for sane ordering
  const scored = clusters
    .map((c) => {
      const uniqueSources = new Set(c.items.map((i) => i.source)).size;
      const newest = Math.max(0, ...c.items.map((i) => i.pubDate ? Date.parse(i.pubDate) || 0 : 0));
      return { c, score: uniqueSources * 2 + c.items.length + (newest ? 1 : 0), newest };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);

  const list = scored
    .map((c, i) => `${i + 1}. ${c.headline} [${c.items.length} item(s) · sources: ${unique(c.items.map((it) => it.source)).slice(0, 6).join(", ")}]`)
    .join("\n");

  const system = `You are NewsPilot — an intellectual-but-amusing news anchor. You take a deduped list of story clusters from today and write a structured briefing covering EVERY distinct story. Output STRICT JSON only — no markdown, no commentary.`;

  const user = `Today's story clusters (one per line, numbered):

${list}

TASK:
1. Merge any clusters that are clearly the same underlying story (cross-chunk duplicates). Use the "merge" array of source cluster numbers when you do.
2. Write a BriefingTopic for EVERY distinct merged story. Do NOT cap the count — if there are 60 distinct stories, return 60 topics.
3. Order topics: most globally significant / widely-covered first.

For each topic write: id (kebab-slug), headline (clean one-liner), hook (one-line teaser), explanation (40-70 words plain English, what happened), whyItMatters (one sentence), followUps (2 short questions a curious reader might ask). DO NOT include sources — we'll attach them programmatically.

Return: { "topics": [ { "id": "...", "headline": "...", "hook": "...", "explanation": "...", "whyItMatters": "...", "followUps": ["...","..."], "merge": [1, 7] } ] }

"merge" lists the 1-based cluster numbers (from above) that this topic represents. Every cluster number must appear in exactly one topic's merge array.`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("[briefing] mergeAndWrite failed", res.status, await res.text());
      return clustersToFallbackTopics(scored);
    }
    const json = await res.json();
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
    if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
      return clustersToFallbackTopics(scored);
    }

    return parsed.topics.map((t: any, i: number): BriefingTopic => {
      const mergeIdx: number[] = Array.isArray(t.merge)
        ? t.merge.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= scored.length)
        : [];
      const items = mergeIdx.flatMap((n) => scored[n - 1].items);
      const sources = uniqueBy(items.map((it) => ({ name: it.source, url: it.link })), (s) => s.url);
      return {
        id: String(t.id ?? `topic-${i}`),
        headline: String(t.headline ?? "Untitled"),
        hook: String(t.hook ?? ""),
        explanation: String(t.explanation ?? ""),
        whyItMatters: String(t.whyItMatters ?? ""),
        sources,
        followUps: Array.isArray(t.followUps) ? t.followUps.slice(0, 4).map(String) : [],
      };
    });
  } catch (e) {
    console.error("[briefing] mergeAndWrite error", e);
    return clustersToFallbackTopics(scored);
  }
}

function unique<T>(a: T[]): T[] { return Array.from(new Set(a)); }
function uniqueBy<T>(a: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of a) {
    const k = key(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

function clustersToFallbackTopics(clusters: { headline: string; items: RssItem[] }[]): BriefingTopic[] {
  return clusters.map((c, i) => ({
    id: `topic-${i}`,
    headline: c.headline,
    hook: "",
    explanation: "Live AI summary unavailable — showing raw cluster. Tap a source to read the original.",
    whyItMatters: "",
    sources: uniqueBy(c.items.map((it) => ({ name: it.source, url: it.link })), (s) => s.url),
    followUps: [],
  }));
}

function fallbackTopics(items: RssItem[]): BriefingTopic[] {
  return items.slice(0, 50).map((it, i) => ({
    id: `topic-${i}`,
    headline: it.title,
    hook: "",
    explanation: "Live AI summary unavailable — showing the raw headline. Tap to read the source.",
    whyItMatters: "",
    sources: [{ name: it.source, url: it.link }],
    followUps: [],
  }));
}
