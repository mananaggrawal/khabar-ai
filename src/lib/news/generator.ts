/**
 * Khabar AI Briefing Generator — v2
 *
 * Pipeline:
 *  1. Fetch 10 Google News topic feeds in parallel
 *  2. Parse + deduplicate stories (URL-hash + title-prefix)
 *  3. Batch-generate spoken scripts via Gemini Flash (20 stories / call, EN+HI together)
 *  4. Batch TTS: merge BATCH_SIZE stories per call, split at silence boundaries
 *  5. Save flat DailyBriefing { stories[] } to Supabase Storage
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRss, type RssItem } from "./rss";
import { FEEDS, FEED_MAP, DEFAULT_CITY, type SectionId } from "./sources";
import { googleTTSBatch, TTS_BATCH_SIZE } from "@/lib/tts/google";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Story = {
  id: string;          // 16-char hex hash of link URL
  title: string;       // original RSS headline
  source: string;      // publisher name (extracted by RSS parser)
  link: string;        // article URL (Google News redirect)
  publishedAt: string; // ISO date string
  section: SectionId;
  imageUrl?: string;
  scriptEn: string;
  scriptHi: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
};

export type DailyBriefing = {
  date: string;
  generatedAt: string;
  stories: Story[];
};

export type Logger = (msg: string) => void;

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

// ─── Step 1: Fetch all feeds ───────────────────────────────────────────────────

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
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const stories: Story[] = [];

  // Process topic-specific feeds first; headlines last (avoids duplicate assignment)
  const order: SectionId[] = [
    "india", "world", "business", "technology", "entertainment",
    "sports", "science", "health", "local", "headlines",
  ];

  for (const sectionId of order) {
    const items = feedMap.get(sectionId) ?? [];
    for (const item of items) {
      const id = storyId(item.link);
      const titleKey = normalize(item.title).slice(0, 60);
      if (seenIds.has(id) || seenTitles.has(titleKey)) continue;
      seenIds.add(id);
      seenTitles.add(titleKey);
      stories.push({
        id,
        title: item.title,
        source: item.source,
        link: item.link,
        publishedAt: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
        section: sectionId,
        imageUrl: item.imageUrl,
        scriptEn: "",
        scriptHi: "",
      });
    }
  }

  return stories;
}

// ─── Step 2b: Fetch OG images from publisher pages ───────────────────────────

/** Extract og:image or twitter:image from raw HTML head. */
function extractOgImage(html: string): string | undefined {
  // Only scan the first 20KB — OG tags live in <head>
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    // Read in chunks until we have 20KB or stream ends
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
  const updated = stories.map((s) => ({ ...s }));
  const CONCURRENCY = 10;

  for (let i = 0; i < stories.length; i += CONCURRENCY) {
    const slice = stories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      slice.map(async (story, j) => {
        if (updated[i + j].imageUrl) return; // already have one from RSS
        const img = await fetchOgImage(story.link);
        if (img) updated[i + j] = { ...updated[i + j], imageUrl: img };
      }),
    );
  }

  const withImages = updated.filter((s) => s.imageUrl).length;
  logger(`OG images: ${withImages}/${stories.length} fetched`);
  return updated;
}

// ─── Step 3: Batch generate spoken scripts ────────────────────────────────────

const SCRIPT_BATCH_SIZE = 20;

async function generateScriptBatch(
  batch: { title: string; source: string; section: SectionId }[],
): Promise<{ en: string; hi: string }[]> {
  const lines = batch
    .map((s, i) => `${i + 1}. [${s.source} · ${s.section}] ${s.title}`)
    .join("\n");

  const prompt = `You are Khabar AI — a warm, conversational Indian news voice.

Write a short spoken script for each headline. Each script must be exactly 2 sentences (65–80 words total):
• Sentence 1: What happened — name the specific people, companies, countries involved. No vague pronouns.
• Sentence 2: Why it matters, what's next, or the key consequence.

Style: conversational, warm, direct. Jump straight into the news — no greeting, no "In other news", no sign-off.
For India stories: write from an Indian perspective.
For global stories: always name the specific country or institution, never say "the government" without specifying which.
Hindi: keep proper nouns (names, places, companies) in English. Match the warm conversational tone.

Return a JSON array with exactly ${batch.length} objects in the same order as the input:
[{"en": "English script here.", "hi": "Hindi script yahan."}, ...]

Headlines:
${lines}`;

  try {
    const result = await geminiJson(prompt);
    if (!Array.isArray(result)) throw new Error("not an array");
    return batch.map((s, i) => ({
      en: String(result[i]?.en ?? `${s.title}.`),
      hi: String(result[i]?.hi ?? `${s.title}।`),
    }));
  } catch (err: any) {
    console.warn(`[generator] script batch failed: ${err.message}`);
    return batch.map((s) => ({
      en: `${s.title}. Details are still emerging.`,
      hi: `${s.title}। अधिक जानकारी जल्द आएगी।`,
    }));
  }
}

async function generateAllScripts(stories: Story[], logger: Logger): Promise<Story[]> {
  const updated = [...stories];
  const batches: number[][] = [];
  for (let i = 0; i < stories.length; i += SCRIPT_BATCH_SIZE) {
    batches.push(
      Array.from({ length: Math.min(SCRIPT_BATCH_SIZE, stories.length - i) }, (_, j) => i + j),
    );
  }

  logger(`Generating scripts: ${stories.length} stories in ${batches.length} batches…`);

  // Up to 3 batches in parallel
  const CONCURRENCY = 3;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (indices) => {
        const input = indices.map((idx) => ({
          title: stories[idx].title,
          source: stories[idx].source,
          section: stories[idx].section,
        }));
        const scripts = await generateScriptBatch(input);
        indices.forEach((idx, j) => {
          updated[idx] = { ...updated[idx], scriptEn: scripts[j].en, scriptHi: scripts[j].hi };
        });
      }),
    );
    logger(`  Scripts batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(batches.length / CONCURRENCY)} done`);
    if (i + CONCURRENCY < batches.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return updated;
}

// ─── Step 4: TTS (batch mode) ─────────────────────────────────────────────────
//
// Merges BATCH_SIZE stories into one TTS call, then splits at silence
// boundaries. Reduces API calls from (stories × 2) to ceil(stories/BATCH) × 2.
// Example: 400 stories → 54 calls instead of 800.

async function generateAllTTS(
  stories: Story[],
  date: string,
  logger: Logger,
): Promise<Story[]> {
  const updated = stories.map((s) => ({ ...s }));

  type TtsItem = { text: string; filename: string; storyIdx: number };

  // Build per-language item lists
  const enItems: TtsItem[] = [];
  const hiItems: TtsItem[] = [];
  stories.forEach((story, idx) => {
    const safeId = story.id.slice(0, 16);
    if (story.scriptEn) enItems.push({ text: story.scriptEn, filename: `${date}-${safeId}-en`, storyIdx: idx });
    if (story.scriptHi) hiItems.push({ text: story.scriptHi, filename: `${date}-${safeId}-hi`, storyIdx: idx });
  });

  const totalFiles  = enItems.length + hiItems.length;
  const enBatches   = Math.ceil(enItems.length / TTS_BATCH_SIZE);
  const hiBatches   = Math.ceil(hiItems.length / TTS_BATCH_SIZE);
  logger(`TTS: ${totalFiles} files → ${enBatches + hiBatches} batch calls (${TTS_BATCH_SIZE} stories/batch)…`);

  /** Process one language stream sequentially, batch by batch. */
  async function processStream(items: TtsItem[], lang: "en" | "hi") {
    const total = Math.ceil(items.length / TTS_BATCH_SIZE);
    for (let b = 0; b < items.length; b += TTS_BATCH_SIZE) {
      const batch    = items.slice(b, b + TTS_BATCH_SIZE);
      const batchNum = Math.floor(b / TTS_BATCH_SIZE) + 1;
      logger(`  TTS ${lang.toUpperCase()} batch ${batchNum}/${total} (${batch.length} stories)…`);

      const urls = await googleTTSBatch(
        batch.map(item => ({ text: item.text, filename: item.filename })),
        lang,
      );

      urls.forEach((url, j) => {
        if (url) {
          if (lang === "en") updated[batch[j].storyIdx].audioUrlEn = url;
          else               updated[batch[j].storyIdx].audioUrlHi = url;
          logger(`    ✓ ${batch[j].filename}`);
        } else {
          logger(`    ✗ ${batch[j].filename}: no audio`);
        }
      });

      // Brief pause between batches to avoid per-minute rate limits
      if (b + TTS_BATCH_SIZE < items.length) {
        await new Promise(r => setTimeout(r, 1_500));
      }
    }
  }

  // Run EN and HI streams in parallel — independent, no shared state
  await Promise.all([
    processStream(enItems, "en"),
    processStream(hiItems, "hi"),
  ]);

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

/** Map old section category strings to new SectionId */
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
  // New format
  if (Array.isArray(raw.stories)) return raw as DailyBriefing;

  // Migrate old sections[].topics[] format
  const stories: Story[] = [];
  if (Array.isArray(raw.sections)) {
    for (const section of raw.sections) {
      for (const topic of (section.topics ?? [])) {
        stories.push({
          id: topic.id ?? storyId(topic.sourceUrl ?? String(Math.random())),
          title: topic.headline ?? topic.title ?? "",
          source: topic.sourceName ?? "Unknown",
          link: topic.sourceUrl ?? "",
          publishedAt: raw.generatedAt ?? new Date().toISOString(),
          section: mapOldCategory(section.category),
          scriptEn: topic.monologueScript ?? "",
          scriptHi: "",
          audioUrlEn: topic.audioUrlEn ?? (topic as any).audioUrl,
          audioUrlHi: topic.audioUrlHi,
        });
      }
    }
  }

  return {
    date: raw.date ?? (raw.generatedAt ?? "").slice(0, 10),
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

// Keep getTodayBriefing for backward compat (handleAsk uses it)
export const getTodayBriefing = getLatestBriefing;

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateDailyBriefing(
  logger: Logger = () => {},
  city = DEFAULT_CITY,
): Promise<DailyBriefing> {
  const date = new Date().toISOString().slice(0, 10);
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing for ${date} (city: ${city})`);

  // Step 1: Fetch all feeds in parallel
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap = await fetchAllFeeds(city);
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds`);

  // Step 2: Deduplicate
  const stories = buildStories(feedMap);
  log(`After dedup: ${stories.length} unique stories`);
  for (const feed of FEEDS) {
    const n = stories.filter((s) => s.section === feed.id).length;
    if (n > 0) log(`  ${feed.emoji} ${feed.label}: ${n}`);
  }

  // Steps 2b + 3 run in parallel — OG images and scripts are independent
  log(`Fetching OG images and scripts in parallel…`);
  const [withImages, withScripts] = await Promise.all([
    fetchAllOgImages(stories, log),
    generateAllScripts(stories, log),
  ]);

  // Merge: scripts take priority; images fill in imageUrl
  const merged = withScripts.map((s, i) => ({
    ...s,
    imageUrl: s.imageUrl ?? withImages[i]?.imageUrl,
  }));

  // Step 4: TTS
  const withAudio = await generateAllTTS(merged, date, log);

  const briefing: DailyBriefing = {
    date,
    generatedAt: new Date().toISOString(),
    stories: withAudio,
  };

  log(`Saving briefing…`);
  await saveBriefing(briefing);
  log(`Done — ${briefing.stories.length} stories`);
  return briefing;
}

// ─── Refresh: add newly published stories to existing briefing ────────────────

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
  const existingIds = new Set(existing.stories.map((s) => s.id));

  const feedMap = await fetchAllFeeds(city);
  const allStories = buildStories(feedMap);
  const newStories = allStories.filter((s) => !existingIds.has(s.id));

  if (newStories.length === 0) {
    log("No new stories found");
    return { added: [], briefing: existing };
  }

  log(`Found ${newStories.length} new stories — generating scripts + OG images + TTS…`);
  const [withImages, withScripts] = await Promise.all([
    fetchAllOgImages(newStories, log),
    generateAllScripts(newStories, log),
  ]);
  const mergedNew = withScripts.map((s, i) => ({
    ...s,
    imageUrl: s.imageUrl ?? withImages[i]?.imageUrl,
  }));
  const withAudio = await generateAllTTS(mergedNew, existing.date, log);

  const merged: DailyBriefing = {
    ...existing,
    generatedAt: new Date().toISOString(),
    stories: [...existing.stories, ...withAudio],
  };

  await saveBriefing(merged);
  const addedSections = [...new Set(withAudio.map((s) => FEED_MAP.get(s.section)?.label ?? s.section))];
  log(`Added ${withAudio.length} stories across: ${addedSections.join(", ")}`);
  return { added: addedSections, briefing: merged };
}
