/**
 * Daily briefing generator — single-pull + categorise pipeline.
 *
 *  1. Fetch TOP_FEEDS (India + multi-region global) in parallel
 *  2. Gemini categorises ALL headlines (no count cap — filter noise/clickbait only)
 *  3. Each section: Gemini search research → per-story scripts (60-80 words each)
 *  4. Translate all scripts to Hindi (one Gemini call per section)
 *  5. Google TTS (Gemini Flash) per story × 2 languages (EN + HI) in parallel batches
 *  6. Persist to Supabase / .local-data/briefings.json
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
  monologueScript?: string;  // English spoken script (per story)
  audioUrlEn?: string;       // English TTS audio URL
  audioUrlHi?: string;       // Hindi TTS audio URL
};

export type BriefingSection = {
  category: SectionCategory;
  label: string;
  emoji: string;
  group: "india" | "global";
  topics: BriefingTopic[];
  /** @deprecated — audio is now per-topic. Kept for backwards compat. */
  monologueScript: string;
  /** @deprecated — audio is now per-topic. Kept for backwards compat. */
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
  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const stripTrailing = (s: string) => s.replace(/,(\s*[}\]])/g, "$1");
  const fixQuotes = (s: string) =>
    s.replace(/(['"])?([a-zA-Z_$][a-zA-Z0-9_$]*)(['"])?\s*:/g, '"$2":')
     .replace(/:\s*'([^'\\]*(\\.[^'\\]*)*)'/g, ': "$1"');

  const attempts = [
    () => JSON.parse(stripTrailing(text)),
    () => JSON.parse(stripTrailing(fixQuotes(text))),
    () => {
      const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!match) throw new Error("no JSON structure found");
      return JSON.parse(stripTrailing(match[1]));
    },
    () => {
      const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!match) throw new Error("no JSON structure found");
      return JSON.parse(stripTrailing(fixQuotes(match[1])));
    },
  ];

  for (const attempt of attempts) {
    try { return attempt(); } catch { /* try next */ }
  }
  throw new Error(`Failed to parse Gemini JSON: ${text.slice(0, 200)}`);
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
    return { sourceUrl: best.item.link, sourceName: best.item.source };
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
    india:  dedupeByTitle(india).slice(0, 80),
    global: dedupeByTitle(global).slice(0, 100),
  };
}

// ─── Step 2: Categorise (no story count cap — filter noise only) ─────────────

type CategoryPicks = Map<SectionCategory, RssItem[]>;

async function geminiCategorise(
  india: RssItem[],
  global: RssItem[],
  dateLabel: string,
): Promise<CategoryPicks> {
  const GLOBAL_OFFSET = india.length;

  const indiaLines  = india.map((it, i) => `${i + 1}. ${it.title}`).join("\n");
  const globalLines = global.map((it, i) => `${GLOBAL_OFFSET + i + 1}. ${it.title}`).join("\n");

  const sectionDefs = SECTIONS.map(
    (s) => `  "${s.category}" — ${s.label} [${s.group}]: ${s.description}`,
  ).join("\n");

  const prompt = `Today is ${dateLabel}. You are a senior news editor categorising headlines.

SECTIONS:
${sectionDefs}

RULES:
- India sections (india-*): ONLY assign stories whose primary subject is India, Indian people, or events inside India.
- Global sections (global-*): ONLY assign non-India international stories.
- Each story goes in AT MOST ONE section — the best fit.
- Include ALL newsworthy stories. Filter out ONLY: (a) obvious duplicates of the same event, (b) clickbait/gossip with no news value, (c) celebrity rumours, (d) promotional content.
- Leave a section empty ([]) if no stories fit it well.

INDIA HEADLINES (indices 1–${india.length}):
${indiaLines}

GLOBAL HEADLINES (indices ${GLOBAL_OFFSET + 1}–${GLOBAL_OFFSET + global.length}):
${globalLines}

Return JSON with one key per section, value = array of 1-based indices:
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
    const items: RssItem[] = ((indices as number[]) ?? [])
      .map((n) => all[n - 1])
      .filter(Boolean);
    if (items.length > 0) picks.set(cat as SectionCategory, items);
  }

  return picks;
}

// ─── Step 3: Research + per-story scripts ────────────────────────────────────

const SECTION_CHUNK_SIZE = 12; // max stories per Gemini call to avoid JSON truncation

async function processSection(
  cfg: SectionConfig,
  selected: RssItem[],
  dateLabel: string,
): Promise<Omit<BriefingSection, "audioUrl" | "monologueScript">> {
  // Chunk large sections to prevent Gemini JSON truncation
  let topics: BriefingTopic[];
  if (selected.length > SECTION_CHUNK_SIZE) {
    const chunks: RssItem[][] = [];
    for (let i = 0; i < selected.length; i += SECTION_CHUNK_SIZE) {
      chunks.push(selected.slice(i, i + SECTION_CHUNK_SIZE));
    }
    console.log(`[generator] ${cfg.label}: ${selected.length} stories → ${chunks.length} chunks of ≤${SECTION_CHUNK_SIZE}`);
    const chunkResults = await Promise.all(
      chunks.map((chunk) => processSectionChunk(cfg, chunk, dateLabel)),
    );
    topics = chunkResults.flat();
  } else {
    topics = await processSectionChunk(cfg, selected, dateLabel);
  }
  return {
    category: cfg.category,
    label: cfg.label,
    emoji: cfg.emoji,
    group: cfg.group,
    topics,
  };
}

async function processSectionChunk(
  cfg: SectionConfig,
  selected: RssItem[],
  dateLabel: string,
): Promise<BriefingTopic[]> {
  const isIndia = cfg.group === "india";

  const entityRule = isIndia
    ? "Cover these stories from an Indian perspective."
    : `CRITICAL: Every sentence must name the specific country, institution, company, or person involved.
NEVER say "the central bank", "the government", "the markets", or "the company" without naming WHICH one.`;

  const wordTarget = Math.max(200, selected.length * 80);

  // Research via Gemini search grounding
  const prose = await geminiSearch(
    `You are a thorough news researcher and skilled broadcast journalist.
Use Google Search to find full details about each story.
Write in spoken broadcast English — no bullet points, no markdown, no headers. Pure flowing prose.`,
    `Research ONLY the following ${cfg.label} news stories using Google Search, then write a spoken segment covering exactly these stories and no others.
CRITICAL: Do NOT introduce, mention, or weave in any additional stories, events, companies, or people not in the list below.
${entityRule}
Target: ~${wordTarget} words total. Cover each story with appropriate depth.
Preserve the original headline wording.

Stories to cover (ALL of these, ONLY these):
${selected.map((it, i) => `${i + 1}. ${it.title}`).join("\n")}`,
  );

  // Assemble per-story topics + individual scripts
  const assembled = await geminiJson(
    `You are Khabar AI — a sharp, warm news voice. Output strict JSON only.`,
    `Today is ${dateLabel}. Section: "${cfg.label}".

Pre-researched content:
${prose}

Return JSON with one key:
"topics": array of objects, one per story covered (cover ALL stories from the research).
Each object:
{
  "id": "kebab-slug",
  "headline": "punchy headline ≤8 words — newspaper front-page style, no verbs like 'looking at' or 'in other news'",
  "hook": "teaser ≤18 words — MUST name the specific country/company/person",
  "explanation": "40-60 word summary — name every entity by full name, never use vague terms",
  "script": "spoken script for THIS story only — 60-80 words, conversational Khabar AI voice, jump straight into the story, no greeting or sign-off, no section title announcement${!isIndia ? ", always name the specific country/institution/entity" : ""}"
}

IMPORTANT: Keep headlines short, punchy, and noun-phrase style (e.g. "FTSE 100 Falls on Fed Surprise", not "Looking at the broader market, the FTSE 100...").
Cover ALL stories from the research, not just a subset.`,
  );

  const rawTopics: any[] = Array.isArray(assembled.topics) ? assembled.topics : [];
  return rawTopics.map((t: any, i: number) => ({
    id: String(t.id ?? `${cfg.category}-${i}`),
    headline: String(t.headline ?? ""),
    hook: String(t.hook ?? ""),
    explanation: String(t.explanation ?? ""),
    section: cfg.category,
    monologueScript: String(t.script ?? t.monologueScript ?? ""),
    ...findSource(
      { headline: String(t.headline ?? ""), hook: String(t.hook ?? ""), explanation: String(t.explanation ?? "") },
      selected,
    ),
  }));
}

// ─── Step 4: Translate scripts to Hindi ──────────────────────────────────────

async function translateSectionScripts(
  topics: BriefingTopic[],
): Promise<Map<string, string>> {
  const withScripts = topics.filter((t) => t.monologueScript);
  if (withScripts.length === 0) return new Map();

  const inputJson = Object.fromEntries(
    withScripts.map((t) => [t.id, t.monologueScript!]),
  );

  try {
    const result = await geminiJson(
      "You are a professional Hindi translator. Output strict JSON only.",
      `Translate each of these English news scripts to natural, conversational Hindi.

RULES:
- Keep proper nouns (person names, place names, company names, organization names) in English as-is
- Numbers and dates can stay in English
- The tone should be warm and conversational — like a friend sharing news, not a formal broadcaster
- Each translation should be roughly the same length as the original

Return JSON with the same keys as input, values replaced with Hindi translations:
${JSON.stringify(inputJson, null, 2)}`,
    );

    return new Map(
      Object.entries(result).map(([id, text]) => [id, String(text)]),
    );
  } catch (err: any) {
    console.warn(`[generator] Hindi translation failed: ${err.message}`);
    return new Map();
  }
}

// ─── Step 5: TTS with parallelisation ────────────────────────────────────────

async function batchRun<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 5,
  delayMs = 800,
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults.map((r) => (r.status === "fulfilled" ? r.value : null)));
    if (i + concurrency < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
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
    monologueScript: t.monologueScript ?? "",
    audioUrlEn: t.audioUrlEn,
    audioUrlHi: t.audioUrlHi,
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

  // Step 2: Categorise (no story count cap)
  log(`Categorising headlines into ${SECTIONS.length} sections…`);
  const picks = await geminiCategorise(india, global, dateLabel);
  for (const [cat, items] of picks) {
    log(`  ${cat}: ${items.length} ${items.length === 1 ? "story" : "stories"} selected`);
  }

  // Step 3: Research + per-story scripts (parallel per section)
  log(`Researching ${picks.size} sections in parallel…`);
  const sectionEntries = [...picks.entries()];
  const sectionResults = await Promise.all(
    sectionEntries.map(([cat, items]) => {
      const cfg = SECTION_MAP.get(cat)!;
      log(`  Research started: ${cfg.label} (${items.length} stories)`);
      return processSection(cfg, items, dateLabel)
        .then((result) => {
          log(`  Research done: ${cfg.label} — ${result.topics.length} topics`);
          return result;
        })
        .catch((err) => {
          log(`  Research failed: ${cat} — ${err.message}`);
          return null;
        });
    }),
  );

  // Cross-section dedup
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

  const totalTopics = dedupedResults.reduce((n, d) => n + (d?.topics.length ?? 0), 0);
  log(`Total stories after dedup: ${totalTopics}`);

  // Step 4: Translate all section scripts to Hindi (parallel per section)
  log(`Translating ${totalTopics} story scripts to Hindi…`);
  const hindiMaps = await Promise.all(
    dedupedResults.map((data) =>
      data ? translateSectionScripts(data.topics) : Promise.resolve(new Map<string, string>()),
    ),
  );

  // Step 5: TTS per story — collect all EN + HI jobs then run in batches
  type TtsJob = {
    text: string;
    filename: string;
    language: "en" | "hi";
    sectionIdx: number;
    topicIdx: number;
  };

  const jobs: TtsJob[] = [];
  dedupedResults.forEach((data, sectionIdx) => {
    if (!data) return;
    const hindiMap = hindiMaps[sectionIdx];
    data.topics.forEach((topic, topicIdx) => {
      if (topic.monologueScript) {
        const safeId = topic.id.slice(0, 50).replace(/[^a-z0-9-]/g, "-");
        const base = `briefing-${date}-${data.category}-${safeId}`;
        jobs.push({ text: topic.monologueScript, filename: `${base}-en`, language: "en", sectionIdx, topicIdx });
        const hiScript = hindiMap.get(topic.id);
        if (hiScript) {
          jobs.push({ text: hiScript, filename: `${base}-hi`, language: "hi", sectionIdx, topicIdx });
        }
      }
    });
  });

  log(`Running TTS for ${jobs.length} audio files (EN + HI)…`);

  // Store results keyed by "sectionIdx-topicIdx-language"
  const audioResults = new Map<string, string>();

  await batchRun(
    jobs,
    async (job) => {
      try {
        const url = await googleTTS(job.text, job.filename, job.language);
        audioResults.set(`${job.sectionIdx}-${job.topicIdx}-${job.language}`, url);
        log(`  TTS done: ${job.filename}`);
      } catch (err: any) {
        log(`  TTS failed: ${job.filename} — ${err.message}`);
      }
    },
    2,    // 2 concurrent TTS calls (free tier: 10 RPM)
    4000, // 4s between batches → ~15 req/min max
  );

  // Assemble final sections with audio URLs on topics
  const sections: BriefingSection[] = [];
  dedupedResults.forEach((data, sectionIdx) => {
    if (!data) return;
    const topicsWithAudio: BriefingTopic[] = data.topics.map((topic, topicIdx) => ({
      ...topic,
      audioUrlEn: audioResults.get(`${sectionIdx}-${topicIdx}-en`),
      audioUrlHi: audioResults.get(`${sectionIdx}-${topicIdx}-hi`),
    }));
    sections.push({
      ...data,
      topics: topicsWithAudio,
      monologueScript: "",  // deprecated — audio is per-topic now
      audioUrl: "",         // deprecated — audio is per-topic now
    });
  });

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
