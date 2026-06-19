/**
 * Daily briefing generator — single-pull + categorise pipeline.
 *
 *  1. Fetch TOP_FEEDS (India + multi-region global) in parallel
 *  2. Gemini categorises all headlines into sections in one call
 *  3. Each section's selected stories → Gemini search research → spoken script
 *  4. Google TTS (Gemini 3.1 Flash) synthesises audio per section
 *  5. Persist to .local-data/briefings.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRss, type RssItem } from "./rss";
import { TOP_FEEDS, SECTIONS, SECTION_MAP, type SectionCategory, type SectionConfig } from "./sources";
import { googleTTS } from "@/lib/tts/google";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BriefingTopic = {
  id: string;
  headline: string;
  hook: string;
  explanation: string;
  section: SectionCategory;
  sourceUrl?: string;
  sourceName?: string;
};

export type BriefingSection = {
  category: SectionCategory;
  label: string;
  emoji: string;
  group: "india" | "global";
  topics: BriefingTopic[];
  monologueScript: string;
  audioUrl: string;
};

export type DailyBriefing = {
  id: string;
  date: string;
  generatedAt: string;
  sections: BriefingSection[];
};

// ─── Gemini helpers ──────────────────────────────────────────────────────────

const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

function getKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

function parseGeminiJson(raw: string): any {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  text = text.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) return JSON.parse(match[1].replace(/,(\s*[}\]])/g, "$1"));
    throw new Error(`Failed to parse Gemini JSON: ${text.slice(0, 200)}`);
  }
}

async function geminiJson(system: string, user: string): Promise<any> {
  const res = await fetch(GEMINI_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini JSON ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return parseGeminiJson(text);
}

async function geminiSearch(system: string, user: string): Promise<string> {
  const res = await fetch(GEMINI_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Source matching ─────────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(normalize(a).split(/\s+/).filter((w) => w.length > 2));
  const wb = new Set(normalize(b).split(/\s+/).filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

function findSource(
  topic: { headline: string; hook: string; explanation: string },
  pool: RssItem[],
): { sourceUrl?: string; sourceName?: string } {
  const candidates = [topic.headline, topic.hook, topic.explanation];
  let best: { score: number; item: RssItem } | null = null;
  for (const item of pool) {
    const score = Math.max(...candidates.map((c) => wordOverlap(c, item.title)));
    if (!best || score > best.score) best = { score, item };
  }
  if (best && best.score >= 0.35) {
    const sourceTitle = best.item.description
      ? best.item.description.match(/[-–]\s*([^-–\n]{3,60})\s*$/)?.[1]?.trim()
      : undefined;
    return { sourceUrl: best.item.link, sourceName: sourceTitle ?? best.item.source };
  }
  return {};
}

// ─── Step 1: Fetch all feeds ─────────────────────────────────────────────────

function dedupeByTitle(items: RssItem[]): RssItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = it.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchAllFeeds(): Promise<{ india: RssItem[]; global: RssItem[] }> {
  const results = await Promise.allSettled(
    TOP_FEEDS.map((f) => fetchRss(f.url, f.name, f.id).then((items) => ({ items, group: f.group }))),
  );

  const india: RssItem[] = [];
  const global: RssItem[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.group === "india") india.push(...r.value.items);
      else global.push(...r.value.items);
    }
  }

  return {
    india:  dedupeByTitle(india).slice(0, 60),
    global: dedupeByTitle(global).slice(0, 80),
  };
}

// ─── Step 2: Categorise ──────────────────────────────────────────────────────

type CategoryPicks = Map<SectionCategory, RssItem[]>;

async function geminiCategorise(
  india: RssItem[],
  global: RssItem[],
  dateLabel: string,
): Promise<CategoryPicks> {
  const indiaSections  = SECTIONS.filter((s) => s.group === "india");
  const globalSections = SECTIONS.filter((s) => s.group === "global");

  // Offset global indices so they don't clash with india indices
  const GLOBAL_OFFSET = india.length;

  const indiaLines  = india.map((it, i) => `${i + 1}. ${it.title}`).join("\n");
  const globalLines = global.map((it, i) => `${GLOBAL_OFFSET + i + 1}. ${it.title}`).join("\n");

  const sectionDefs = SECTIONS.map(
    (s) => `  "${s.category}" — ${s.label} [${s.group}]: ${s.description} (pick up to ${s.storyCount})`,
  ).join("\n");

  const prompt = `Today is ${dateLabel}. You are a senior news editor categorising headlines.

SECTIONS:
${sectionDefs}

RULES:
- India sections (india-*): ONLY assign stories whose primary subject is India, Indian people, or events inside India.
- Global sections (global-*): ONLY assign non-India international stories.
- Each story goes in AT MOST ONE section — the best fit.
- Within each section pick the most newsworthy, varied stories up to the limit shown.
- Leave a section empty ([]) if no stories fit it well.

INDIA HEADLINES (indices 1–${india.length}):
${indiaLines}

GLOBAL HEADLINES (indices ${GLOBAL_OFFSET + 1}–${GLOBAL_OFFSET + global.length}):
${globalLines}

Return JSON with one key per section, value = array of 1-based indices from the lists above:
{
  "india-national": [1, 5, 12],
  "india-business": [3, 8],
  ...
}`;

  const result = await geminiJson(
    "You are a news editor. Output strict JSON only — no commentary.",
    prompt,
  );

  const all = [...india, ...global];
  const picks: CategoryPicks = new Map();

  for (const [cat, indices] of Object.entries(result)) {
    if (!SECTION_MAP.has(cat as SectionCategory)) continue;
    const cfg = SECTION_MAP.get(cat as SectionCategory)!;
    const items: RssItem[] = ((indices as number[]) ?? [])
      .slice(0, cfg.storyCount)
      .map((n) => all[n - 1])
      .filter(Boolean);
    if (items.length > 0) picks.set(cat as SectionCategory, items);
  }

  return picks;
}

// ─── Step 3: Research + assemble per section ─────────────────────────────────

async function processSection(
  cfg: SectionConfig,
  selected: RssItem[],
  dateLabel: string,
): Promise<Omit<BriefingSection, "audioUrl">> {
  const isIndia = cfg.group === "india";

  const entityRule = isIndia
    ? "Cover these stories from an Indian perspective."
    : `CRITICAL: Every sentence must name the specific country, institution, company, or person involved.
NEVER say "the central bank", "the government", "the markets", or "the company" without naming WHICH one.
Example: WRONG → "The central bank held rates." RIGHT → "The US Federal Reserve held rates."`;

  // Research via Gemini search grounding
  const prose = await geminiSearch(
    `You are a thorough news researcher and skilled broadcast journalist.
Use Google Search to find full details about each story.
Write in spoken broadcast English — no bullet points, no markdown, no headers. Pure flowing prose.`,
    `Research each of these ${cfg.label} news stories using Google Search, then write a spoken segment.
${entityRule}
Target: ~${cfg.wordTarget} words total. Cover each story with appropriate depth.
Preserve the original headline wording. Use smooth, conversational transitions between stories.

Stories to cover:
${selected.map((it, i) => `${i + 1}. ${it.title}`).join("\n")}`,
  );

  // Assemble topics + script
  const assembled = await geminiJson(
    `You are Khabar AI — a sharp, warm news voice. Output strict JSON only.`,
    `Today is ${dateLabel}. Section: "${cfg.label}".

Pre-researched content:
${prose}

Return JSON with exactly two keys:
1. "topics": array of objects, one per story covered.
   Each: { "id": "kebab-slug", "headline": "VERBATIM headline from the stories list — do NOT rephrase", "hook": "teaser ≤18 words — MUST name the specific country/institution/company", "explanation": "40-60 word summary — MUST name every country, institution, and entity by full name. Never use vague terms like 'the central bank' or 'the government' without specifying which one." }
   IMPORTANT: headline must be copied word-for-word from the original stories list.

2. "script": single STRING — the spoken script for this section.
   ~${cfg.wordTarget} words. Pure flowing prose. Jump straight into the first story — no greeting, no "good morning/evening", no "welcome to Khabar AI", no section title announcement.
   Transition between stories naturally mid-flow, the way a friend would — not with "moving on" or "next up" markers.
   Do NOT end with a closing line or sign-off. Just finish the last story and stop — the next section will continue seamlessly.
   NO markdown, NO headers, NO bullet points.
   ${!isIndia ? "ALWAYS name the specific country, institution, or entity in every sentence — never leave the listener guessing which bank, government, or market you mean." : ""}`,
  );

  const rawTopics: any[] = Array.isArray(assembled.topics) ? assembled.topics : [];
  const topics: BriefingTopic[] = rawTopics.map((t: any, i: number) => ({
    id: String(t.id ?? `${cfg.category}-${i}`),
    headline: String(t.headline ?? ""),
    hook: String(t.hook ?? ""),
    explanation: String(t.explanation ?? ""),
    section: cfg.category,
    ...findSource(
      { headline: String(t.headline ?? ""), hook: String(t.hook ?? ""), explanation: String(t.explanation ?? "") },
      selected,
    ),
  }));

  const monologueScript =
    typeof assembled.script === "string" && assembled.script.length > 50
      ? assembled.script
      : prose;

  return {
    category: cfg.category,
    label: cfg.label,
    emoji: cfg.emoji,
    group: cfg.group,
    topics,
    monologueScript,
  };
}

// ─── Local DB ────────────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), ".local-data");

export async function saveBriefing(briefing: DailyBriefing): Promise<void> {
  if (!LOCAL_MODE) {
    await saveBriefingToStorage(briefing.date, briefing);
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, "briefings.json");
  let all: DailyBriefing[] = [];
  try { all = JSON.parse(await readFile(path, "utf-8")); } catch {}
  all = [briefing, ...all.filter((b) => b.date !== briefing.date)];
  await writeFile(path, JSON.stringify(all, null, 2));
}

function normalizeBriefing(raw: any): DailyBriefing {
  if (Array.isArray(raw.sections) && raw.sections.length > 0) {
    return {
      ...raw,
      sections: (raw.sections as any[]).map((s) => ({
        ...s,
        label: SECTION_MAP.get(s.category)?.label ?? s.label,
        emoji: SECTION_MAP.get(s.category)?.emoji ?? s.emoji,
      })),
    } as DailyBriefing;
  }
  // Legacy format: wrap into two sections
  const topics: any[] = raw.topics ?? [];
  const mapTopic = (t: any, cat: SectionCategory): BriefingTopic => ({
    id: t.id ?? "",
    headline: t.headline ?? "",
    hook: t.hook ?? "",
    explanation: t.explanation ?? "",
    section: cat,
    sourceUrl: t.sourceUrl ?? t.source_url,
    sourceName: t.sourceName ?? t.source_name,
  });
  const sections: BriefingSection[] = [
    {
      category: "india-national" as SectionCategory,
      label: "Politics & Policy", emoji: "🏛️", group: "india" as const,
      topics: topics.filter((t) => t.section === "india" || t.tier === "home").map((t) => mapTopic(t, "india-national")),
      monologueScript: raw.monologueScript ?? "", audioUrl: raw.audioUrl ?? "",
    },
    {
      category: "global-world" as SectionCategory,
      label: "World Affairs", emoji: "🌍", group: "global" as const,
      topics: topics.filter((t) => t.section === "global" || t.tier !== "home").map((t) => mapTopic(t, "global-world")),
      monologueScript: "", audioUrl: "",
    },
  ].filter((s) => s.topics.length > 0 || s.audioUrl);

  return {
    id: raw.id ?? "",
    date: raw.date ?? (raw.generatedAt ?? "").slice(0, 10),
    generatedAt: raw.generatedAt ?? new Date().toISOString(),
    sections,
  };
}

export async function getTodayBriefing(): Promise<DailyBriefing | null> {
  const today = new Date().toISOString().slice(0, 10);
  if (!LOCAL_MODE) {
    const raw = await loadBriefingFromStorage(today);
    if (!raw) return null;
    return normalizeBriefing(raw);
  }
  try {
    const all: any[] = JSON.parse(await readFile(join(DATA_DIR, "briefings.json"), "utf-8"));
    if (all.length === 0) return null;
    const raw = all.find((b) => (b.date ?? (b.generatedAt ?? "").slice(0, 10)) === today) ?? all[0];
    return normalizeBriefing(raw);
  } catch { return null; }
}

export async function getLatestBriefing(): Promise<DailyBriefing | null> {
  if (!LOCAL_MODE) {
    // Try today first, then yesterday (up to 3 days back)
    for (let i = 0; i < 3; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const raw = await loadBriefingFromStorage(date);
      if (raw) return normalizeBriefing(raw);
    }
    return null;
  }
  try {
    const all: any[] = JSON.parse(await readFile(join(DATA_DIR, "briefings.json"), "utf-8"));
    return all[0] ? normalizeBriefing(all[0]) : null;
  } catch { return null; }
}

// ─── Logger type ─────────────────────────────────────────────────────────────

export type Logger = (msg: string) => void;

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateDailyBriefing(logger: Logger = () => {}): Promise<DailyBriefing> {
  const date = new Date().toISOString().slice(0, 10);
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing for ${date}`);

  // Step 1: Fetch all feeds
  log(`Fetching ${TOP_FEEDS.length} RSS feeds…`);
  const { india, global } = await fetchAllFeeds();
  log(`Fetched ${india.length} India + ${global.length} global headlines`);

  // Step 2: Categorise in one Gemini call
  log(`Categorising headlines into ${SECTIONS.length} sections…`);
  const picks = await geminiCategorise(india, global, dateLabel);
  for (const [cat, items] of picks) {
    log(`  ${cat}: ${items.length} ${items.length === 1 ? "story" : "stories"} selected`);
  }

  // Step 3: Research + assemble (parallel Gemini calls per section)
  log(`Researching ${picks.size} sections in parallel (Gemini + web search)…`);
  const sectionEntries = [...picks.entries()];
  const sectionResults = await Promise.all(
    sectionEntries.map(([cat, items]) => {
      const cfg = SECTION_MAP.get(cat)!;
      log(`  Research started: ${cfg.label}`);
      return processSection(cfg, items, dateLabel)
        .then((result) => {
          log(`  Research done: ${cfg.label} — ${result.topics.length} topics`);
          return result;
        })
        .catch((err) => {
          log(`  Research failed: ${cat} — ${err.message}`);
          console.error(`[generator] section ${cat} failed:`, err.message);
          return null;
        });
    }),
  );

  // Cross-section dedup — remove repeated headlines across sections
  const seenHeadlines = new Set<string>();
  const dedupedResults = sectionResults.map((data) => {
    if (!data) return null;
    const unique = data.topics.filter((t) => {
      const key = normalize(t.headline).slice(0, 60);
      if (seenHeadlines.has(key)) return false;
      seenHeadlines.add(key);
      return true;
    });
    return unique.length > 0 ? { ...data, topics: unique } : null;
  });

  // Step 4: TTS — sequential to stay within rate limits
  const sections: BriefingSection[] = [];
  let ttsIndex = 0;
  for (const data of dedupedResults) {
    if (!data) continue;
    ttsIndex++;
    log(`TTS ${ttsIndex}/${dedupedResults.filter(Boolean).length}: ${data.label}…`);
    try {
      const audioUrl = await googleTTS(data.monologueScript, `briefing-${date}-${data.category}`);
      sections.push({ ...data, audioUrl });
      log(`  TTS done: ${data.label}`);
    } catch (err: any) {
      log(`  TTS failed: ${data.label} — ${err.message}`);
      console.error(`[generator] TTS failed for ${data.category}:`, err.message);
      sections.push({ ...data, audioUrl: "" });
    }
  }

  const briefing: DailyBriefing = {
    id: `briefing-${date}`,
    date,
    generatedAt: new Date().toISOString(),
    sections,
  };

  log(`Saving briefing to storage…`);
  await saveBriefing(briefing);
  log(`Done — ${sections.length} sections, ${sections.reduce((n, s) => n + s.topics.length, 0)} topics`);
  return briefing;
}
