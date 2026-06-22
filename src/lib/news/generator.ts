/**
 * Khabar AI Briefing Generator — v3
 *
 * Pipeline:
 *  1. Fetch all Google News topic feeds in parallel (no caps — take everything)
 *  2. Parse + deduplicate stories (URL-hash + title-prefix)
 *  3. Per-section club + script (1 Gemini call/section): groups related stories,
 *     synthesises them into one richer story, writes EN+HI scripts (60-80 words)
 *  4. Time guard — if estimated listen time > 15 min, trim from tail of
 *     non-priority sections (Headlines / Business / World are never trimmed)
 *  5. Per-story TTS: one googleTTS call per story per language
 *     → abort works between every story, timestamps are exact (audioStartSec = 0)
 *  6. Save flat DailyBriefing { stories[] } to Supabase Storage
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRss, type RssItem } from "./rss";
import { FEEDS, FEED_MAP, DEFAULT_CITY, type SectionId } from "./sources";
import { elevenLabsTTS, isQuotaExhausted } from "@/lib/tts/elevenlabs";
import { googleTTS, isDailyQuotaExhausted } from "@/lib/tts/google";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";
import { isAbortRequested } from "@/lib/abort";

export type TtsProvider = "google" | "elevenlabs";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StorySource = {
  title: string;
  source: string; // publication name
  link: string;
};

export type Story = {
  id: string;
  title: string;
  source: string;
  link: string;
  publishedAt: string;
  section: SectionId;
  imageUrl?: string;
  description?: string;   // RSS snippet — used by Gemini to write richer scripts
  sources?: StorySource[]; // all raw articles that were merged into this story
  scriptEn: string;
  scriptHi: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
  audioStartSec?: number; // always 0 — kept for compatibility with player
};

export type DailyBriefing = {
  date: string;
  generatedAt: string;
  stories: Story[];
};

export type Logger = (msg: string) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_WPM   = 150;  // average reading/speech rate
const TARGET_MINS  = 30;   // soft cap — secondary sections trimmed only if well over this

// Max clubbed groups (stories) per section.
// At ~70 words/story, 150 WPM: primary (4×5) + secondary (6×3) ≈ 38 stories ≈ 17.7 min.
const MAX_GROUPS_PRIMARY   = 6;  // headlines, india, world, business — never dropped
const MAX_GROUPS_SECONDARY = 4;  // all other sections — trimmed only if well over budget

// If a section has more raw stories than this, split into chunks before clubbing.
const CLUB_CHUNK_SIZE = 25;

// Primary sections: all stories kept, never trimmed by time guard
const PRIORITY_SECTIONS: SectionId[] = ["headlines", "india", "world", "business"];

// ─── Story ID ─────────────────────────────────────────────────────────────────

function storyId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────

const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

function getKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

function parseGeminiJson(raw: string): any {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const strip = (s: string) => s.replace(/,(\s*[}\]])/g, "$1");
  const attempts = [
    () => JSON.parse(strip(text)),
    () => {
      const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      if (!m) throw new Error("no JSON");
      return JSON.parse(strip(m[1]));
    },
  ];
  for (const fn of attempts) {
    try { return fn(); } catch {}
  }
  throw new Error(`Failed to parse Gemini JSON: ${text.slice(0, 200)}`);
}

async function geminiJson(prompt: string): Promise<any> {
  const res = await fetch(GEMINI_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  return parseGeminiJson(text);
}

// ─── Step 1: Fetch all feeds ──────────────────────────────────────────────────

async function fetchAllFeeds(city: string): Promise<Map<SectionId, RssItem[]>> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const url = feed.buildUrl({ city });
      const items = await fetchRss(url, feed.label, feed.id);
      return { id: feed.id, items };
    }),
  );

  const map = new Map<SectionId, RssItem[]>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.items.length > 0) {
      map.set(r.value.id, r.value.items);
    }
  }
  return map;
}

// ─── Step 2: Deduplicate into flat Story list ─────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function buildStories(feedMap: Map<SectionId, RssItem[]>): Story[] {
  const seenIds    = new Set<string>();
  const seenTitles = new Set<string>();
  const stories: Story[] = [];

  const order: SectionId[] = [
    "india", "world", "business", "technology", "entertainment",
    "sports", "science", "health", "local", "headlines",
  ];

  for (const sectionId of order) {
    const items = feedMap.get(sectionId) ?? [];
    for (const item of items) {
      const id       = storyId(item.link);
      const titleKey = normalize(item.title).slice(0, 60);
      if (seenIds.has(id) || seenTitles.has(titleKey)) continue;
      seenIds.add(id);
      seenTitles.add(titleKey);
      stories.push({
        id,
        title:       item.title,
        source:      item.source,
        link:        item.link,
        publishedAt: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
        section:     sectionId,
        imageUrl:    item.imageUrl,
        description: item.description,
        scriptEn: "",
        scriptHi: "",
      });
    }
  }

  return stories;
}

// ─── Step 2b: OG images ───────────────────────────────────────────────────────

function extractOgImage(html: string): string | undefined {
  const head = html.slice(0, 20_000);
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m?.[1] && m[1].startsWith("http")) return m[1];
  }
  return undefined;
}

async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept":     "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 20_000) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => { const a = new Uint8Array(acc.length + c.length); a.set(acc); a.set(c, acc.length); return a; }, new Uint8Array(0))
    );
    return extractOgImage(html);
  } catch {
    return undefined;
  }
}

async function fetchAllOgImages(stories: Story[], logger: Logger): Promise<Story[]> {
  logger(`Fetching OG images for ${stories.length} stories (10 concurrent)…`);
  const updated     = stories.map((s) => ({ ...s }));
  const CONCURRENCY = 10;

  for (let i = 0; i < stories.length; i += CONCURRENCY) {
    const slice = stories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      slice.map(async (story, j) => {
        if (updated[i + j].imageUrl) return;
        const img = await fetchOgImage(story.link);
        if (img) updated[i + j] = { ...updated[i + j], imageUrl: img };
      }),
    );
  }

  const withImages = updated.filter((s) => s.imageUrl).length;
  logger(`OG images: ${withImages}/${stories.length} fetched`);
  return updated;
}

// ─── Step 3: Club + script per section ───────────────────────────────────────
//
// One Gemini call per section. Gemini groups related stories by topic,
// writes one synthesised EN+HI script per group (60-80 words).
// Every raw story must appear in exactly one group — no information dropped.

interface ClubbedGroup {
  title:         string;
  scriptEn:      string;
  scriptHi:      string;
  sourceIndices: number[];
}

/** Club + script a single batch of stories (≤ CLUB_CHUNK_SIZE). */
async function clubAndScriptBatch(
  sectionStories: Story[],
  sectionId: SectionId,
  maxGroups: number,
): Promise<Story[]> {
  if (sectionStories.length === 0) return [];

  const label = FEED_MAP.get(sectionId)?.label ?? sectionId;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const prompt = `You are Khabar AI — Indian news editor. Today's date is ${today}.

Below are ${sectionStories.length} stories from the "${label}" section.

YOUR JOB:
1. Group stories that cover the same event, person, or topic. Different sources covering the same development → one group.
2. Stories with no close match → their own group (size 1).
3. Write one script per group that synthesises ALL its sources. No source's key information may be omitted.
4. IMPORTANT: Produce at most ${maxGroups} groups total. If there are more distinct topics than ${maxGroups}, prioritise the most significant/impactful stories and fold minor duplicates into the nearest related group.

SCRIPT RULES:
- 60-80 words, 3-4 sentences
- Warm Indian English — conversational, not a broadcaster. Sound like a smart friend explaining something interesting, not reading a headline
- Use the description/context provided — go beyond the headline. Include the why, the who, the implication
- Start directly with the substance. Never start with "In a...", "According to...", or a rephrased headline
- Name specific people, companies, numbers, places — no vague pronouns or generalities
- Add ONE line of context or implication: why does this matter? what happens next?
- Never guess or hedge on the year — these are today's stories (${today})
- scriptHi: same content in Hindi, keep English names/brands/numbers as-is, natural spoken Hindi not translated English

CRITICAL: Every story (0 to ${sectionStories.length - 1}) must appear in exactly one group's sourceIndices.

Return JSON array only, no markdown:
[{"title":"...","scriptEn":"...","scriptHi":"...","sourceIndices":[0,1,3]}]

Stories:
${sectionStories.map((s, i) => {
    const desc = s.description?.replace(/\s+/g, " ").trim().slice(0, 300);
    return `${i}. [${s.source}] ${s.title}${desc ? `\n   → ${desc}` : ""}`;
  }).join("\n")}`;

  try {
    const result: ClubbedGroup[] = await geminiJson(prompt);
    if (!Array.isArray(result) || result.length === 0) throw new Error("empty result");

    // Track which source indices are covered
    const covered = new Set<number>();
    for (const g of result) (g.sourceIndices ?? []).forEach(i => covered.add(i));

    // Build output stories
    const output: Story[] = [];

    for (const group of result) {
      const indices = (group.sourceIndices ?? []).filter(
        i => i >= 0 && i < sectionStories.length,
      );
      if (indices.length === 0) continue;

      // Use story with an image as primary, otherwise first
      const primaryIdx = indices.find(i => sectionStories[i]?.imageUrl) ?? indices[0];
      const primary    = sectionStories[primaryIdx];

      // Collect all merged source articles
      const sources: StorySource[] = indices.map(i => ({
        title:  sectionStories[i].title,
        source: sectionStories[i].source,
        link:   sectionStories[i].link,
      }));

      output.push({
        ...primary,
        id:       primary.id,
        title:    group.title   || primary.title,
        sources,
        scriptEn: group.scriptEn || `${primary.title}. Details are emerging.`,
        scriptHi: group.scriptHi || `${primary.title}। विवरण आ रहे हैं।`,
        audioUrlEn:   undefined,
        audioUrlHi:   undefined,
        audioStartSec: 0,
      });
    }

    // Any uncovered stories → simple fallback script
    for (let i = 0; i < sectionStories.length; i++) {
      if (covered.has(i)) continue;
      const s = sectionStories[i];
      console.warn(`[generator] section ${sectionId} index ${i} not covered by clubbing — adding standalone`);
      output.push({
        ...s,
        sources: [{ title: s.title, source: s.source, link: s.link }],
        scriptEn: `${s.title}. More details are emerging on this story.`,
        scriptHi: `${s.title}। इस खबर के बारे में अधिक जानकारी आ रही है।`,
        audioStartSec: 0,
      });
    }

    return output;
  } catch (err: any) {
    console.warn(`[generator] club ${sectionId} batch failed (${err.message}) — scripting individually`);
    return sectionStories.map(s => ({
      ...s,
      sources: [{ title: s.title, source: s.source, link: s.link }],
      scriptEn: `${s.title}. More details are emerging.`,
      scriptHi: `${s.title}। अधिक जानकारी आ रही है।`,
      audioStartSec: 0,
    }));
  }
}

/**
 * Club + script a full section, chunking into batches of CLUB_CHUNK_SIZE
 * if the section is large. Each chunk gets a proportional MAX_GROUPS cap.
 */
async function clubAndScriptSection(
  sectionStories: Story[],
  sectionId: SectionId,
  maxGroups: number,
): Promise<Story[]> {
  if (sectionStories.length === 0) return [];

  if (sectionStories.length <= CLUB_CHUNK_SIZE) {
    return clubAndScriptBatch(sectionStories, sectionId, maxGroups);
  }

  // Large section: split into chunks, distribute groups budget proportionally
  const chunks: Story[][] = [];
  for (let i = 0; i < sectionStories.length; i += CLUB_CHUNK_SIZE) {
    chunks.push(sectionStories.slice(i, i + CLUB_CHUNK_SIZE));
  }
  const groupsPerChunk = Math.max(2, Math.ceil(maxGroups / chunks.length));

  console.log(
    `[generator] ${sectionId}: ${sectionStories.length} stories → ${chunks.length} chunks × ~${groupsPerChunk} groups each`,
  );

  const chunkResults = await Promise.all(
    chunks.map(chunk => clubAndScriptBatch(chunk, sectionId, groupsPerChunk)),
  );

  return chunkResults.flat();
}

async function clubAndScriptAllSections(
  stories: Story[],
  logger: Logger,
  onSectionDone?: (clubbed: Story[]) => Promise<void>,
): Promise<Story[]> {
  // Group by section
  const bySection = new Map<SectionId, Story[]>();
  for (const story of stories) {
    const arr = bySection.get(story.section) ?? [];
    arr.push(story);
    bySection.set(story.section, arr);
  }

  // Priority sections first, then the rest
  const sectionOrder: SectionId[] = [
    ...PRIORITY_SECTIONS.filter(id => bySection.has(id)),
    ...[...bySection.keys()].filter(id => !PRIORITY_SECTIONS.includes(id)),
  ];

  logger(`Club + script: ${stories.length} raw stories across ${bySection.size} sections…`);

  const allClubbedStories: Story[] = [];

  for (const sectionId of sectionOrder) {
    if (isAbortRequested()) { logger("⛔ Aborted"); break; }

    const sectionStories = bySection.get(sectionId) ?? [];
    const emoji          = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    const isPriority     = PRIORITY_SECTIONS.includes(sectionId);
    const maxGroups      = isPriority ? MAX_GROUPS_PRIMARY : MAX_GROUPS_SECONDARY;
    logger(`  ${emoji} ${sectionId}: ${sectionStories.length} raw → max ${maxGroups} stories (${isPriority ? "primary" : "secondary"})…`);

    try {
      const clubbed = await clubAndScriptSection(sectionStories, sectionId, maxGroups);
      allClubbedStories.push(...clubbed);
      logger(`    → ${clubbed.length} stories after clubbing`);
    } catch (err: any) {
      logger(`    ✗ ${sectionId}: ${err.message?.slice(0, 100)}`);
    }

    if (onSectionDone) await onSectionDone([...allClubbedStories]);
  }

  return allClubbedStories;
}

// ─── Step 4: Time guard ───────────────────────────────────────────────────────
//
// Estimates listen time from word count. If over TARGET_MINS, trims stories
// from the tail of non-priority sections (lowest priority first).

// Secondary sections only — priority sections (headlines, india, world, business) never trimmed
const TRIM_ORDER: SectionId[] = [
  "local", "health", "science", "entertainment", "sports", "technology",
];

function estimateMins(stories: Story[]): number {
  const words = stories.reduce((n, s) => n + s.scriptEn.split(/\s+/).length, 0);
  return words / TARGET_WPM;
}

function applyTimeGuard(stories: Story[], logger: Logger): Story[] {
  const est = estimateMins(stories);
  logger(`Estimated listen time: ${est.toFixed(1)} min (${stories.length} stories)`);

  if (est <= TARGET_MINS) return stories;

  let trimmed = [...stories];

  outer: for (const sectionId of TRIM_ORDER) {
    // Remove stories from this section one at a time (from the back) until under budget
    while (estimateMins(trimmed) > TARGET_MINS) {
      const indices = trimmed
        .map((s, i) => (s.section === sectionId ? i : -1))
        .filter(i => i >= 0);
      if (indices.length === 0) continue outer;
      const last = indices[indices.length - 1];
      trimmed.splice(last, 1);
      logger(`  trimmed 1 story from ${sectionId}`);
    }
    if (estimateMins(trimmed) <= TARGET_MINS) break;
  }

  logger(`After time guard: ${trimmed.length} stories, ~${estimateMins(trimmed).toFixed(1)} min`);
  return trimmed;
}

// ─── Step 5: TTS — one call per story per language (same structure for all providers) ──

async function generateAllTTS(
  stories: Story[],
  date: string,
  provider: TtsProvider,
  logger: Logger,
  onStoryDone?: (stories: Story[]) => Promise<void>,
): Promise<Story[]> {
  const updated = stories.map(s => ({ ...s }));
  const label   = provider === "google" ? "Google" : "ElevenLabs";

  logger(`TTS (${label}): ${stories.length} stories × 2 languages = ${stories.length * 2} calls…`);

  for (let i = 0; i < stories.length; i++) {
    if (isAbortRequested())    { logger("⛔ Aborted by stop request"); break; }
    if (isDailyQuotaExhausted()) { logger("⛔ Google TTS daily quota exhausted"); break; }
    if (isQuotaExhausted())    { logger("⛔ ElevenLabs quota exhausted — top up credits to continue."); break; }

    const story    = stories[i];
    const fileBase = `${date}-${story.id}`;
    let gotEn = false;
    let gotHi = false;

    const synthesize = async (script: string, filename: string): Promise<string> => {
      if (provider === "google") {
        const { url } = await googleTTS(script, filename);
        return url;
      }
      const { url } = await elevenLabsTTS(script, filename);
      return url;
    };

    // EN
    if (story.scriptEn) {
      try {
        updated[i].audioUrlEn    = await synthesize(story.scriptEn, `${fileBase}-en`);
        updated[i].audioStartSec = 0;
        gotEn = true;
      } catch (err: any) {
        logger(`  ✗ EN [${i + 1}/${stories.length}]: ${err.message?.slice(0, 80)}`);
      }
    }

    if (isAbortRequested())    { logger("⛔ Aborted by stop request"); break; }
    if (isDailyQuotaExhausted()) { logger("⛔ Google TTS daily quota exhausted"); break; }
    if (isQuotaExhausted())    { logger("⛔ ElevenLabs quota exhausted — top up credits to continue."); break; }

    // HI
    if (story.scriptHi) {
      try {
        updated[i].audioUrlHi = await synthesize(story.scriptHi, `${fileBase}-hi`);
        gotHi = true;
      } catch (err: any) {
        logger(`  ✗ HI [${i + 1}/${stories.length}]: ${err.message?.slice(0, 80)}`);
      }
    }

    if (gotEn || gotHi) {
      logger(`  ✓ [${i + 1}/${stories.length}] ${story.title.slice(0, 55)}`);
    } else {
      logger(`  ⚠ [${i + 1}/${stories.length}] no audio — ${story.title.slice(0, 45)}`);
    }
    if (onStoryDone) await onStoryDone([...updated]);
  }

  return updated;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

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

function mapOldCategory(cat: string): SectionId {
  const m: Record<string, SectionId> = {
    "india-national": "india",   "india-business": "business",
    "india-sports": "sports",    "india-tech": "technology",
    "india-entertainment": "entertainment", "india-health": "health",
    "global-world": "world",     "global-business": "business",
    "global-sports": "sports",   "global-tech": "technology",
    "global-entertainment": "entertainment", "global-health": "health",
  };
  return m[cat] ?? "headlines";
}

function normalizeBriefing(raw: any): DailyBriefing {
  if (Array.isArray(raw.stories)) return raw as DailyBriefing;

  const stories: Story[] = [];
  if (Array.isArray(raw.sections)) {
    for (const section of raw.sections) {
      for (const topic of (section.topics ?? [])) {
        stories.push({
          id:          topic.id ?? storyId(topic.sourceUrl ?? String(Math.random())),
          title:       topic.headline ?? topic.title ?? "",
          source:      topic.sourceName ?? "Unknown",
          link:        topic.sourceUrl ?? "",
          publishedAt: raw.generatedAt ?? new Date().toISOString(),
          section:     mapOldCategory(section.category),
          scriptEn:    topic.monologueScript ?? "",
          scriptHi:    "",
          audioUrlEn:  topic.audioUrlEn ?? (topic as any).audioUrl,
          audioUrlHi:  topic.audioUrlHi,
          audioStartSec: 0,
        });
      }
    }
  }

  return {
    date:        raw.date ?? (raw.generatedAt ?? "").slice(0, 10),
    generatedAt: raw.generatedAt ?? new Date().toISOString(),
    stories,
  };
}

export async function getLatestBriefing(): Promise<DailyBriefing | null> {
  if (!LOCAL_MODE) {
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const raw = await loadBriefingFromStorage(d.toISOString().slice(0, 10));
      if (raw) return normalizeBriefing(raw);
    }
    return null;
  }
  try {
    const all: any[] = JSON.parse(await readFile(join(DATA_DIR, "briefings.json"), "utf-8"));
    return all[0] ? normalizeBriefing(all[0]) : null;
  } catch { return null; }
}

export const getTodayBriefing = getLatestBriefing;

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateDailyBriefing(
  logger: Logger = () => {},
  city = DEFAULT_CITY,
  ttsProvider: TtsProvider = "google",
): Promise<DailyBriefing> {
  const date = new Date().toISOString().slice(0, 10);
  const log  = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing for ${date} (city: ${city})`);

  // Step 1: Fetch all feeds
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap  = await fetchAllFeeds(city);
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds`);

  // Step 2: Dedup
  const rawStories = buildStories(feedMap);
  log(`After dedup: ${rawStories.length} unique stories`);
  for (const feed of FEEDS) {
    const n = rawStories.filter(s => s.section === feed.id).length;
    if (n > 0) log(`  ${feed.emoji} ${feed.label}: ${n}`);
  }

  // Steps 2b + 3 in parallel: OG images and club+script are independent
  log(`Fetching OG images and clubbing+scripting in parallel…`);
  const [withImages, clubbed] = await Promise.all([
    fetchAllOgImages(rawStories, log),
    clubAndScriptAllSections(rawStories, log, async (partial) => {
      await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: partial });
      log(`  💾 saved ${partial.length} clubbed stories so far`);
    }),
  ]);

  // Merge images into clubbed stories by matching id
  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  const merged = clubbed.map(s => ({
    ...s,
    imageUrl: s.imageUrl ?? imageById.get(s.id),
  }));

  // Step 4: Time guard
  const guarded = applyTimeGuard(merged, log);

  // Save after scripting (before TTS so scripts survive TTS quota failures)
  await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: guarded });
  log(`Scripts done — ${guarded.length} stories, saving before TTS…`);

  // Step 5: TTS — per-story, same structure for all providers
  log(`TTS provider: ${ttsProvider} (${guarded.length} stories × 2 langs = ${guarded.length * 2} calls)`);
  const withAudio = await generateAllTTS(guarded, date, ttsProvider, log, async (partialStories) => {
    await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: partialStories });
  });

  const briefing: DailyBriefing = {
    date,
    generatedAt: new Date().toISOString(),
    stories: withAudio,
  };

  await saveBriefing(briefing);
  log(`Done — ${briefing.stories.length} stories`);
  return briefing;
}

// ─── Patch: add newly published stories to existing briefing ──────────────────

export async function generateMissingSections(
  logger: Logger = () => {},
  city = DEFAULT_CITY,
): Promise<{ added: string[]; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) {
    log("No existing briefing — running full generation…");
    const full = await generateDailyBriefing(logger, city);
    return { added: ["(full generation)"], briefing: full };
  }

  log(`Refreshing stories for ${existing.date}…`);
  const existingIds = new Set(existing.stories.map(s => s.id));

  const feedMap    = await fetchAllFeeds(city);
  const allStories = buildStories(feedMap);
  const newStories = allStories.filter(s => !existingIds.has(s.id));

  if (newStories.length === 0) {
    log("No new stories found");
    return { added: [], briefing: existing };
  }

  log(`Found ${newStories.length} new stories — clubbing + scripting new sections…`);

  // Re-club each section that has new stories (merge new + existing for that section)
  const newSections = new Set(newStories.map(s => s.section));
  const [withImages, clubbedNew] = await Promise.all([
    fetchAllOgImages(newStories, log),
    clubAndScriptAllSections(newStories, log),
  ]);

  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  const mergedNew = clubbedNew.map(s => ({
    ...s,
    imageUrl: s.imageUrl ?? imageById.get(s.id),
  }));

  // TTS for new stories
  const withAudio = await generateAllTTS(mergedNew, existing.date, log, async (partial) => {
    await saveBriefing({
      ...existing,
      generatedAt: new Date().toISOString(),
      stories: [...existing.stories, ...partial],
    });
  });

  const merged: DailyBriefing = {
    ...existing,
    generatedAt: new Date().toISOString(),
    stories: [...existing.stories, ...withAudio],
  };

  await saveBriefing(merged);
  const addedLabels = [...newSections].map(s => FEED_MAP.get(s)?.label ?? s);
  log(`Added ${withAudio.length} stories across: ${addedLabels.join(", ")}`);
  return { added: addedLabels, briefing: merged };
}

// ─── TTS-only patch ───────────────────────────────────────────────────────────

export async function generateMissingTTS(
  logger: Logger = () => {},
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) throw new Error("No existing briefing — run full generation first");

  const missing = existing.stories.filter(
    s => (s.scriptEn && !s.audioUrlEn) || (s.scriptHi && !s.audioUrlHi),
  );

  if (missing.length === 0) {
    log("All stories already have audio — nothing to do");
    return { patched: 0, briefing: existing };
  }

  log(`TTS patch: ${missing.length} stories missing audio…`);

  const updated = existing.stories.map(s => ({ ...s }));
  let patched   = 0;

  for (const story of missing) {
    if (isAbortRequested()) { log("⛔ Aborted by stop request"); break; }
    if (isQuotaExhausted()) { log("⛔ Daily TTS quota exhausted — stopping. Add credits or retry tomorrow."); break; }

    const idx      = updated.findIndex(s => s.id === story.id);
    if (idx < 0) continue;
    const fileBase = `${existing.date}-${story.id}`;
    let gotAny = false;

    if (story.scriptEn && !story.audioUrlEn) {
      try {
        const { url } = await elevenLabsTTS(story.scriptEn, `${fileBase}-en`);
        updated[idx].audioUrlEn    = url;
        updated[idx].audioStartSec = 0;
        patched++;
        gotAny = true;
      } catch (err: any) {
        log(`  ✗ EN ${story.id}: ${err.message?.slice(0, 80)}`);
      }
    }

    if (isAbortRequested()) { log("⛔ Aborted by stop request"); break; }
    if (isQuotaExhausted()) { log("⛔ Daily TTS quota exhausted — stopping. Add credits or retry tomorrow."); break; }

    if (story.scriptHi && !story.audioUrlHi) {
      try {
        const { url } = await elevenLabsTTS(story.scriptHi, `${fileBase}-hi`);
        updated[idx].audioUrlHi = url;
        patched++;
        gotAny = true;
      } catch (err: any) {
        log(`  ✗ HI ${story.id}: ${err.message?.slice(0, 80)}`);
      }
    }

    if (gotAny) {
      log(`  ✓ ${story.title.slice(0, 55)}`);
    } else {
      log(`  ⚠ no audio saved — ${story.title.slice(0, 45)}`);
    }
    await saveBriefing({ ...existing, generatedAt: new Date().toISOString(), stories: updated });
  }

  const briefing: DailyBriefing = {
    ...existing,
    generatedAt: new Date().toISOString(),
    stories: updated,
  };
  await saveBriefing(briefing);
  return { patched, briefing };
}
