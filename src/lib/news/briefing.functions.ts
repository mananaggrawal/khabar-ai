import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchRss, type RssItem } from "./rss";
import { RSS_SOURCES, ALL_CATEGORIES, type Category, type CountryCode } from "./sources";
import { dedupeByTitle } from "./cluster";

export type BriefingTier = "home" | "world" | "quick_hit";

export type BriefingTopic = {
  id: string;
  headline: string;
  hook: string;
  explanation: string;
  whyItMatters: string;
  sources: { name: string; url: string }[];
  followUps: string[];
  tier: BriefingTier;
};

export type Briefing = {
  id: string;
  generatedAt: string;
  topics: BriefingTopic[];
  totalSources: number;
  totalTopics?: number;
  coverageWindowStart?: string;
  homeCountry?: CountryCode;
};

const CategorySchema = z.enum(ALL_CATEGORIES);

const CHUNK_SIZE = 120;
const MAX_CHUNKS_PER_POOL = 4;

// Per-tier caps that target a ~15 min spoken briefing (~150 wpm).
const TIER_CAPS = { home: 8, world: 6, quick_hit: 6 } as const;

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

    const prefs = await loadPrefs(supabase, userId);
    const tz = data.timezone || prefs.timezone;
    const homeCountry = prefs.homeCountry;
    const midnight = startOfLocalDayUTC(tz);

    // Reuse today's briefing unless forced
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
        const topics = (recent.topics as BriefingTopic[]).map((t) => ({
          ...t,
          tier: (t.tier as BriefingTier) ?? "world",
        }));
        return {
          id: recent.id,
          generatedAt: recent.generated_at,
          topics,
          totalSources: Array.isArray(recent.sources) ? recent.sources.length : 0,
          totalTopics: recent.total_topics ?? undefined,
          coverageWindowStart: recent.coverage_window_start ?? undefined,
          homeCountry,
        };
      }
    }

    const cats: Category[] =
      data.categories && data.categories.length > 0 ? data.categories : prefs.categories;

    // Partition sources by pool: home = sources matching user's country.
    // World = global + all other countries.
    const wantedSources = RSS_SOURCES.filter((s) => {
      // Always include global; otherwise match country.
      if (s.country === "global") return true;
      if (s.country === homeCountry) return true;
      // For the world pool, include all category-matching foreign sources.
      return cats.includes(s.category as Category) || s.category === "top";
    });

    const fetched = (
      await Promise.all(wantedSources.map((s) => fetchRss(s.url, s.name, s.id).then((items) => items.map((it) => ({ ...it, _country: s.country })))))
    ).flat();

    // Filter by local-midnight cutoff
    const cutoff = midnight.getTime();
    const recentItems = fetched.filter((it) => {
      if (!it.pubDate) return true;
      const t = Date.parse(it.pubDate);
      return Number.isNaN(t) ? true : t >= cutoff;
    });

    // Dedupe each pool independently so India/world stories don't merge.
    const homePool = homeCountry === "global"
      ? []
      : dedupeByTitle(recentItems.filter((it) => it._country === homeCountry), 0.55);
    const worldPool = dedupeByTitle(
      recentItems.filter((it) => it._country !== homeCountry || homeCountry === "global"),
      0.55,
    );

    const sortByDate = (a: RssItem, b: RssItem) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return (tb || 0) - (ta || 0);
    };
    homePool.sort(sortByDate);
    worldPool.sort(sortByDate);

    const homeCapped = homePool.slice(0, CHUNK_SIZE * MAX_CHUNKS_PER_POOL);
    const worldCapped = worldPool.slice(0, CHUNK_SIZE * MAX_CHUNKS_PER_POOL);

    const tiered = await summarizeTiered(
      chunk(homeCapped, CHUNK_SIZE),
      chunk(worldCapped, CHUNK_SIZE),
      homeCountry,
    );

    // Flatten for legacy `topics` column / consumers.
    const topics: BriefingTopic[] = [...tiered.home, ...tiered.world, ...tiered.quickHits];

    const allSourceItems = [...homeCapped, ...worldCapped];
    const sourceList = allSourceItems.map((t) => ({
      title: t.title,
      url: t.link,
      source: t.source,
    }));

    const { data: inserted, error } = await supabase
      .from("briefings")
      .insert({
        user_id: userId,
        topics: topics as any,
        topics_tiered: tiered as any,
        sources: sourceList as any,
        total_topics: topics.length,
        total_clusters_raw: allSourceItems.length,
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
      homeCountry,
    };
  });

async function loadPrefs(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<{ categories: Category[]; timezone: string; homeCountry: CountryCode }> {
  const { data } = await supabase
    .from("preferences")
    .select("categories, timezone, home_country")
    .eq("user_id", userId)
    .maybeSingle();
  const rawCats = (data?.categories as string[] | undefined) ?? [];
  const valid = rawCats.filter((c): c is Category =>
    (ALL_CATEGORIES as readonly string[]).includes(c),
  );
  const cats: Category[] = valid.length ? valid : ["world", "tech", "markets", "science"];
  const tz = (data?.timezone as string | undefined) || "UTC";
  const home = ((data?.home_country as string | undefined) as CountryCode | undefined) || "in";
  return { categories: cats, timezone: tz, homeCountry: home };
}

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
    const asUTC = Date.UTC(y, m - 1, d, h, mi, s);
    const offset = asUTC - now.getTime();
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

// ───────────────────── LLM pipeline ─────────────────────

type RawCluster = { headline: string; memberIndices: number[] };
type ResolvedCluster = { headline: string; items: RssItem[] };

type TieredResult = {
  home: BriefingTopic[];
  world: BriefingTopic[];
  quickHits: BriefingTopic[];
};

async function summarizeTiered(
  homeChunks: RssItem[][],
  worldChunks: RssItem[][],
  homeCountry: CountryCode,
): Promise<TieredResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    return {
      home: [],
      world: fallbackTopics(worldChunks.flat(), "world"),
      quickHits: [],
    };
  }

  const [homeClusters, worldClusters] = await Promise.all([
    resolveClusters(homeChunks, apiKey),
    resolveClusters(worldChunks, apiKey),
  ]);

  return await writeTiered(homeClusters, worldClusters, homeCountry, apiKey);
}

async function resolveClusters(chunks: RssItem[][], apiKey: string): Promise<ResolvedCluster[]> {
  if (chunks.length === 0) return [];
  const per = await Promise.all(chunks.map((c) => clusterChunk(c, apiKey)));
  const resolved: ResolvedCluster[] = [];
  per.forEach((clusters, ci) => {
    const items = chunks[ci];
    for (const cl of clusters) {
      const members = cl.memberIndices.map((i) => items[i - 1]).filter((x): x is RssItem => !!x);
      if (members.length) resolved.push({ headline: cl.headline, items: members });
    }
  });
  // Sort by source diversity + size for the writer pass
  return resolved
    .map((c) => ({
      c,
      score: new Set(c.items.map((i) => i.source)).size * 2 + c.items.length,
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
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
- Use as many clusters as needed — typical chunk yields 30-80 clusters.
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
    if (!res.ok) return items.map((it, i) => ({ headline: it.title, memberIndices: [i + 1] }));
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

const COUNTRY_LABELS: Record<CountryCode, string> = {
  in: "India",
  us: "United States",
  uk: "United Kingdom",
  global: "Global",
};

async function writeTiered(
  homeClusters: ResolvedCluster[],
  worldClusters: ResolvedCluster[],
  homeCountry: CountryCode,
  apiKey: string,
): Promise<TieredResult> {
  // If we have nothing, return empty.
  if (homeClusters.length === 0 && worldClusters.length === 0) {
    return { home: [], world: [], quickHits: [] };
  }

  // If home pool is missing (e.g. user picked "global" or India RSS down),
  // redistribute home cap into world.
  const homeCap = homeClusters.length > 0 ? TIER_CAPS.home : 0;
  const worldCap = TIER_CAPS.world + (homeClusters.length === 0 ? TIER_CAPS.home : 0);
  const quickCap = TIER_CAPS.quick_hit;

  const homeList = homeClusters
    .slice(0, 40)
    .map((c, i) => `H${i + 1}. ${c.headline} [${c.items.length} item(s) · ${unique(c.items.map((it) => it.source)).slice(0, 4).join(", ")}]`)
    .join("\n");
  const worldList = worldClusters
    .slice(0, 60)
    .map((c, i) => `W${i + 1}. ${c.headline} [${c.items.length} item(s) · ${unique(c.items.map((it) => it.source)).slice(0, 4).join(", ")}]`)
    .join("\n");

  const homeLabel = COUNTRY_LABELS[homeCountry];

  const system = `You are NewsPilot — an intellectual-but-amusing news anchor. You build a structured, time-boxed daily briefing. Output STRICT JSON only — no markdown, no commentary.`;

  const user = `Today's story clusters.

== FROM ${homeLabel.toUpperCase()} (home) ==
${homeList || "(none)"}

== AROUND THE WORLD ==
${worldList || "(none)"}

TASK: Build a tiered briefing the user can hear in ~15 minutes.

Return STRICT JSON:
{
  "home": [ /* up to ${homeCap} topics from H-clusters; the most significant ${homeLabel} stories */ ],
  "world": [ /* up to ${worldCap} topics from W-clusters; the most globally important non-${homeLabel} stories */ ],
  "quickHits": [ /* up to ${quickCap} short bullets from EITHER pool — fun/curious/honorable mentions worth a single sentence */ ]
}

Each topic shape:
{ "id": "kebab-slug",
  "headline": "clean one-liner",
  "hook": "one-line teaser (≤18 words)",
  "explanation": "...",
  "whyItMatters": "one sentence",
  "followUps": ["q1","q2"],
  "merge": ["H1","H4"]  /* source cluster IDs from above; use H# for home, W# for world */ }

LENGTH RULES (strict — this is a 15-minute spoken brief):
- home[i].explanation: 40–60 words. Why it matters: 1 sentence.
- world[i].explanation: 25–35 words. Why it matters: 1 short sentence.
- quickHits[i].explanation: empty string "". Why it matters: empty string "". The "hook" carries the whole thing.

CONTENT RULES:
- Prioritise ${homeLabel} stories first; avoid duplication between home and world (if a ${homeLabel} story has global angle, put it in home).
- Order each tier by significance / breadth of coverage.
- Use clean, conversational English. No filler.
- Every cluster used must appear in exactly one topic's "merge" array. Unused clusters are fine — we are deliberately capping.`;

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
      console.error("[briefing] writeTiered failed", res.status, await res.text());
      return fallbackTiered(homeClusters, worldClusters);
    }
    const json = await res.json();
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");

    const resolveMerge = (mergeIds: any): RssItem[] => {
      if (!Array.isArray(mergeIds)) return [];
      const items: RssItem[] = [];
      for (const raw of mergeIds) {
        const id = String(raw).trim();
        const m = /^([HW])(\d+)$/.exec(id);
        if (!m) continue;
        const pool = m[1] === "H" ? homeClusters : worldClusters;
        const idx = Number(m[2]) - 1;
        if (pool[idx]) items.push(...pool[idx].items);
      }
      return items;
    };

    const buildTopic = (t: any, i: number, tier: BriefingTier): BriefingTopic => {
      const items = resolveMerge(t.merge);
      const sources = uniqueBy(items.map((it) => ({ name: it.source, url: it.link })), (s) => s.url);
      return {
        id: String(t.id ?? `${tier}-${i}`),
        headline: String(t.headline ?? "Untitled"),
        hook: String(t.hook ?? ""),
        explanation: String(t.explanation ?? ""),
        whyItMatters: String(t.whyItMatters ?? ""),
        sources,
        followUps: Array.isArray(t.followUps) ? t.followUps.slice(0, 4).map(String) : [],
        tier,
      };
    };

    const home = Array.isArray(parsed.home) ? parsed.home.slice(0, homeCap).map((t: any, i: number) => buildTopic(t, i, "home")) : [];
    const world = Array.isArray(parsed.world) ? parsed.world.slice(0, worldCap).map((t: any, i: number) => buildTopic(t, i, "world")) : [];
    const quickHits = Array.isArray(parsed.quickHits) ? parsed.quickHits.slice(0, quickCap).map((t: any, i: number) => buildTopic(t, i, "quick_hit")) : [];

    if (home.length === 0 && world.length === 0 && quickHits.length === 0) {
      return fallbackTiered(homeClusters, worldClusters);
    }
    return { home, world, quickHits };
  } catch (e) {
    console.error("[briefing] writeTiered error", e);
    return fallbackTiered(homeClusters, worldClusters);
  }
}

function fallbackTiered(home: ResolvedCluster[], world: ResolvedCluster[]): TieredResult {
  return {
    home: home.slice(0, TIER_CAPS.home).map((c, i) => clusterToTopic(c, `home-${i}`, "home")),
    world: world.slice(0, TIER_CAPS.world).map((c, i) => clusterToTopic(c, `world-${i}`, "world")),
    quickHits: world.slice(TIER_CAPS.world, TIER_CAPS.world + TIER_CAPS.quick_hit).map((c, i) => clusterToTopic(c, `qh-${i}`, "quick_hit")),
  };
}

function clusterToTopic(c: ResolvedCluster, id: string, tier: BriefingTier): BriefingTopic {
  return {
    id,
    headline: c.headline,
    hook: "",
    explanation: tier === "quick_hit" ? "" : "Live AI summary unavailable — tap a source for details.",
    whyItMatters: "",
    sources: uniqueBy(c.items.map((it) => ({ name: it.source, url: it.link })), (s) => s.url),
    followUps: [],
    tier,
  };
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

function fallbackTopics(items: RssItem[], tier: BriefingTier): BriefingTopic[] {
  return items.slice(0, 20).map((it, i) => ({
    id: `topic-${i}`,
    headline: it.title,
    hook: "",
    explanation: tier === "quick_hit" ? "" : "Live AI summary unavailable — showing the raw headline.",
    whyItMatters: "",
    sources: [{ name: it.source, url: it.link }],
    followUps: [],
    tier,
  }));
}
