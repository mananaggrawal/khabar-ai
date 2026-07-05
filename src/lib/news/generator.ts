/**
 * Khabar AI Briefing Generator — v5
 *
 * Pipeline:
 *  1. Fetch 5 Google News RSS feeds in parallel (headlines, india, world, business, local)
 *  2. URL/title dedup → flat raw stories; headlines feed marks inHeadlinesFeed signal
 *  3. OG image fetching [parallel with step 4]
 *  4. Single AI call: cluster same-event articles → all distinct events, ordered by importance
 *  5. Script generation: ~60 words each, headline+gist (GPT-4o), 10 concurrent
 *  6. TTS: Edge (English), 5 concurrent
 *  7. Save DailyBriefing to Supabase Storage
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRss, type RssItem } from "./rss";
import { FEEDS, FEED_MAP, SECTION_ORDER, matchPublisher, type SectionId } from "./sources";
import { edgeTTS } from "@/lib/tts/edge";
import { elevenLabsTTS, isQuotaExhausted } from "@/lib/tts/elevenlabs";
import { googleTTS, isDailyQuotaExhausted } from "@/lib/tts/google";
import { kokoroTTS } from "@/lib/tts/kokoro";
import { openaiTTS } from "@/lib/tts/openai";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";
import { isAbortRequested } from "@/lib/abort";

export type TtsProvider = "google" | "elevenlabs" | "edge" | "kokoro" | "openai";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// ─── Briefing duration config ─────────────────────────────────────────────────

const WORDS_PER_MINUTE  = 150;
// Very quick headline+gist scripts (~60 words) → maximize story coverage per minute.
const WORDS_PER_STORY   = 60;
// Override via TARGET_MINUTES env var (default: 40 min → ~100 stories — room for
// India ~25 + up to ~10 across the other sections, where supply exists)
const TARGET_MINUTES    = Number(process.env.TARGET_MINUTES ?? 40);
const MAX_STORIES       = Math.round(TARGET_MINUTES * WORDS_PER_MINUTE / WORDS_PER_STORY);

// ─── Public types ─────────────────────────────────────────────────────────────

export type StorySource = {
  title: string;
  source: string;
  link: string;
};

export type Story = {
  id: string;
  title: string;
  titleHi?: string;
  titleTa?: string;
  titleMr?: string;
  source: string;
  link: string;
  publishedAt: string;
  section: SectionId;
  imageUrl?: string;
  description?: string;
  sources?: StorySource[];
  scriptEn: string;
  scriptHi: string;       // reserved for future language support
  scriptTa?: string;
  scriptMr?: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
  audioUrlTa?: string;
  audioUrlMr?: string;
  audioStartSec?: number;
  importanceReason?: string;
  wordCount?: number;
  publisherCount?: number;
  publishers?: string[];
};

export type BriefingSegment = {
  id: string;
  type: "opening" | "transition" | "closing";
  section?: SectionId;
  scriptEn: string;
  scriptHi: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
};

export type BriefingMeta = {
  totalStories: number;
  totalArticles: number;
  estimatedDurationSec: number;
  sections: SectionId[];
};

export type DailyBriefing = {
  date: string;
  generatedAt: string;
  stories: Story[];
  segments?: BriefingSegment[];
  meta?: BriefingMeta;
  generatedLanguages?: string[];
  runSummary?: RunSummary;
};

export type Logger = (msg: string) => void;

export type RunSummary = {
  elapsedSec: number;
  fetchSec: number;
  clusterSec: number;
  scriptSec: number;
  ttsSec: number;
  rawStories: number;
  selectedStories: number;
  tts: TtsCostInfo;
};

export type TtsCostInfo = {
  provider: TtsProvider;
  totalChars: number;
  estimatedUsd: number;
  storiesAttempted: number;
  storiesWithAudio: number;
};

// ─── Internal type: event after clustering, before scripting ──────────────────

type SelectedEvent = {
  eventId: string;
  title: string;
  section: SectionId;
  sourceStories: Story[];
  publisherCount: number;
  publishers: string[];
  imageUrl?: string;
  firstPublishedAt: string;
  inHeadlinesFeed: boolean;
  whyImportant: string;
};

// ─── Concurrency limiter ──────────────────────────────────────────────────────

function makeConcurrencyLimiter(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return async function<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>(res => queue.push(res));
    running++;
    try { return await fn(); }
    finally { running--; queue.shift()?.(); }
  };
}

// FIFO serializer — chains async calls so they never overlap (e.g. read-modify-write saves)
function makeSerializer() {
  let tail: Promise<unknown> = Promise.resolve();
  return function<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// Script calls: 10 concurrent (GPT-4o handles this fine at tier 1+)
const scriptLimit = makeConcurrencyLimiter(10);

// ─── Gemini helpers (fallback when SCRIPT_PROVIDER != openai) ────────────────

const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

function getGeminiKey(): string {
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
  for (const fn of [
    () => JSON.parse(strip(text)),
    () => { const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/); if (!m) throw new Error("no JSON"); return JSON.parse(strip(m[1])); },
  ]) { try { return fn(); } catch {} }
  throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
}

const GEMINI_RETRYABLE = new Set([429, 500, 502, 503, 504]);
const GEMINI_MAX_RETRIES = 3;
const GEMINI_BASE_DELAY_MS = 15_000;
const GEMINI_TIMEOUT_MS = 90_000;
let _geminiDailyQuotaExhausted = false;
const geminiLimit = makeConcurrencyLimiter(1);

async function geminiJson(prompt: string, maxOutputTokens = 8192): Promise<any> {
  return geminiLimit(async () => {
    if (_geminiDailyQuotaExhausted) throw new Error("Gemini daily quota exhausted");
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = GEMINI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
      try {
        const res = await fetch(GEMINI_URL(getGeminiKey()), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              maxOutputTokens,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 500);
          lastError = new Error(`Gemini ${res.status}: ${body}`);
          if (res.status === 429 && (body.includes("per_day") || body.includes("DAILY"))) {
            _geminiDailyQuotaExhausted = true;
            throw lastError;
          }
          if (GEMINI_RETRYABLE.has(res.status)) continue;
          throw lastError;
        }
        const json = await res.json();
        const parts: any[] = json.candidates?.[0]?.content?.parts ?? [];
        const text = parts.find((p: any) => p.text && !p.thought)?.text
          ?? parts.find((p: any) => p.text)?.text ?? "[]";
        return parseGeminiJson(text);
      } catch (err: any) {
        if (err.name === "AbortError") { lastError = new Error("Gemini timed out"); continue; }
        throw err;
      } finally { clearTimeout(timer); }
    }
    throw lastError ?? new Error("Gemini failed after retries");
  });
}

// ─── OpenAI helpers ───────────────────────────────────────────────────────────

function getOpenAIKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY is not set");
  return k;
}

// gpt-4o-mini for scripting (2026-07-04) — was defaulting to full gpt-4o,
// which has much lower rate limits. With no cap on story count (can be 200+
// stories/day now), that caused a cascade of 429s during scripting, and the
// no-proper-script fallback (raw unedited RSS snippet text) kicked in for
// dozens of stories per run — that's what showed up as "gibberish" content.
// Override via OPENAI_SCRIPT_MODEL if ever needed.
function getScriptModel(): string {
  return process.env.OPENAI_SCRIPT_MODEL ?? "gpt-4o-mini";
}

// GPT-4o-mini for cluster/select — classification only, cost-effective.
const CLUSTER_MODEL = "gpt-4o-mini";

const OPENAI_RETRYABLE   = new Set([429, 500, 502, 503, 504]);
const OPENAI_MAX_RETRIES = 3;
const OPENAI_BASE_DELAY_MS = 2_000;
const OPENAI_TIMEOUT_MS  = 90_000;

async function openaiJson(prompt: string, model: string, maxTokens = 8192): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = OPENAI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getOpenAIKey()}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        lastError = new Error(`OpenAI ${res.status}: ${body}`);
        if (OPENAI_RETRYABLE.has(res.status)) continue;
        throw lastError;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "{}";
      try { return JSON.parse(text); } catch {
        throw new Error(`OpenAI JSON parse failed: ${text.slice(0, 200)}`);
      }
    } catch (err: any) {
      if (err.name === "AbortError") { lastError = new Error("OpenAI timed out"); continue; }
      throw err;
    } finally { clearTimeout(timer); }
  }
  throw lastError ?? new Error("OpenAI failed after retries");
}

/**
 * Route to OpenAI or Gemini based on SCRIPT_PROVIDER env var.
 * Used for both cluster/select and scripting.
 */
function aiJson(prompt: string, model: string, maxTokens = 8192): Promise<any> {
  const provider = process.env.SCRIPT_PROVIDER ?? "openai";
  if (provider === "openai") return openaiJson(prompt, model, maxTokens);
  return geminiJson(prompt, maxTokens);
}

// ─── Step 1: Fetch all feeds ──────────────────────────────────────────────────

async function fetchAllFeeds(): Promise<Map<SectionId, RssItem[]>> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const url = feed.buildUrl();
      let items = await fetchRss(url, feed.label, feed.feedId);
      if (items.length === 0 && feed.fallbackUrl) {
        console.warn(`[feeds] ${feed.label}: primary returned 0 — trying fallback`);
        items = await fetchRss(feed.fallbackUrl, feed.label, feed.feedId);
      }
      return { feedId: feed.feedId, items };
    }),
  );

  const map = new Map<SectionId, RssItem[]>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.items.length > 0) {
      map.set(r.value.feedId, r.value.items);
    }
  }
  return map;
}

// ─── Step 2: Build raw stories (dedup) ───────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function storyId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * Dedup articles across all 9 feeds.
 * Processing order: india/world/business/technology/sports/science/health/local → headlines.
 *
 * Headlines section definition (2026-07-02, Option B): a story is "Headlines"
 * only if it appears on BOTH Google's plain homepage feed AND one of the 8
 * topical feeds — i.e. it's promoted OUT of its original topical section into
 * Headlines. Previous definition ("unique to homepage feed, not in any topical
 * feed") inverted this: truly major stories usually DO get picked up by a
 * topical feed too, so they were being excluded from Headlines and left with
 * just a passive flag, while only leftover/marginal homepage-only items became
 * "Headlines" — which is exactly why headlines looked thin and inconsequential.
 * Stories that appear ONLY on the homepage feed (no topical-feed match) don't
 * get the "both" corroboration, so they're filed under "india" as a fallback,
 * same as any other unclassifiable item — still included, just not labelled Headlines.
 */
// Topic feeds Google actually offers (everything except the synthetic
// "headlines" bucket) — the valid classification targets below.
const CLASSIFIABLE_SECTIONS: Exclude<SectionId, "headlines">[] =
  ["india", "world", "business", "technology", "sports", "science", "health"];

// Classifies homepage-only trending items (no topical-feed match at all) into
// a real section by actual subject, via a cheap batched LLM call — replaces
// a prior hardcoded "always india" default that misfiled non-India trending
// stories (world/business/sports/etc.) under India with zero basis. Small
// input (typically well under 20 items/run — only the trending stories Google
// didn't also tag with one of the 7 topic feeds), so one cheap gpt-4o-mini
// call is enough. Falls back to "india" per-item only if the model call fails
// or returns something unparseable, so a transient API error can't break
// generation.
async function classifyOrphanSections(items: RssItem[]): Promise<SectionId[]> {
  if (items.length === 0) return [];
  const fallback = items.map(() => "india" as SectionId);
  try {
    const prompt = `Classify each of these ${items.length} trending news headlines into exactly one of these topics: ${CLASSIFIABLE_SECTIONS.join(", ")}.
- "india": Indian domestic politics, society, crime, local affairs, government.
- "world": international/foreign affairs, geopolitics, other countries' news.
- "business": markets, companies, economy, finance, trade.
- "technology": tech companies, gadgets, software, AI.
- "sports": any sport, athletes, matches, tournaments.
- "science": research, space, discoveries, health/medical science studies.
- "health": personal health, medicine, disease, wellness, fitness.
Pick the SINGLE best-fitting topic per headline based on its actual subject, not just where it might have been sourced from.

Return ONLY JSON: {"s": ["topic0", "topic1", ...]} — exactly ${items.length} strings, in the same order, each one of: ${CLASSIFIABLE_SECTIONS.join(", ")}.

${items.map((it, i) => `[${i}] ${it.title}`).join("\n")}`;
    const raw = await openaiJson(prompt, CLUSTER_MODEL, 2048);
    const arr: any[] = Array.isArray(raw?.s) ? raw.s : [];
    if (arr.length !== items.length) return fallback;
    return arr.map((x: any) =>
      CLASSIFIABLE_SECTIONS.includes(x) ? (x as SectionId) : "india",
    );
  } catch {
    return fallback;
  }
}

async function buildRawStories(feedMap: Map<SectionId, RssItem[]>): Promise<{ stories: Story[]; headlineIds: Set<string>; staleDropped: number; blockedDropped: number; notAllowedDropped: number }> {
  const seenIds    = new Set<string>();
  const seenTitles = new Set<string>();
  const idToIdx    = new Map<string, number>();
  const titleToIdx = new Map<string, number>();
  const stories: Story[] = [];
  const headlineIds = new Set<string>();
  let staleDropped = 0, blockedDropped = 0, notAllowedDropped = 0;

  // Publisher allowlist (2026-07-02, opened back up 2026-07-03): generation now
  // allows ALL publishers by default — the 7-masthead restriction (ToI, NDTV,
  // The Hindu, Hindustan Times, Indian Express, Economic Times, Mint) was
  // cutting ~67% of raw fetch volume and was the likely cause of "important
  // stories missing." The allowlist machinery (matchPublisher/ALLOWED_PUBLISHERS)
  // stays in place for the Settings "Sources" picker, which still lets a reader
  // narrow to just those 7 if they want — this only affects what generation
  // includes for everyone. Escape hatch: ALLOW_ALL_SOURCES=false to restrict again.
  const allowAll = process.env.ALLOW_ALL_SOURCES !== "false";
  function isAllowed(item: RssItem): boolean {
    return allowAll || matchPublisher(item.source) !== null;
  }

  // Title-based dedup (normalized first-60-chars match) — re-enabled 2026-07-03
  // after diagnosis showed the near-duplicate merge (a smarter, full-title-
  // overlap tool) is what actually needed to be off/on, not this. Exact-URL
  // dedup (seenIds) always stays on regardless of this flag either way.
  // Escape hatch: ENABLE_TITLE_DEDUP=false.
  const titleDedupEnabled = process.env.ENABLE_TITLE_DEDUP !== "false";

  // Only today's news: drop items older than STORY_MAX_AGE_HOURS (default 24h),
  // and anything dated in the future (clock-skew tolerance 2h).
  const maxAgeMs     = (Number(process.env.STORY_MAX_AGE_HOURS) || 24) * 3_600_000;
  const freshCutoff  = Date.now() - maxAgeMs;
  const futureCutoff = Date.now() + 2 * 3_600_000;
  function isFresh(item: RssItem): boolean {
    if (!item.pubDate) return false;          // no date → can't confirm it's today, skip
    const t = Date.parse(item.pubDate);
    return !isNaN(t) && t >= freshCutoff && t <= futureCutoff;
  }

  // Blocked sources: their feed dates are unreliable (e.g. News On Air stamps a
  // site-wide "last updated today" on every page), leaking months-old articles
  // past the freshness check. Drop them outright. Extend via BLOCKED_SOURCES.
  const BLOCKED = (process.env.BLOCKED_SOURCES ?? "news on air,newsonair,akashvani,all india radio,prasar bharati")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  function isBlocked(item: RssItem): boolean {
    const src  = (item.source || "").toLowerCase();
    const link = (item.link || "").toLowerCase();
    return BLOCKED.some(b => src.includes(b)) || link.includes("newsonair") || link.includes("akashvani");
  }

  function addStory(item: RssItem, section: SectionId): number {
    const id  = storyId(item.link);
    const key = normalize(item.title).slice(0, 60);
    const idx = stories.length;
    stories.push({
      id, title: item.title, source: item.source, link: item.link,
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      section, imageUrl: item.imageUrl, description: item.description,
      scriptEn: "", scriptHi: "",
    });
    seenIds.add(id);
    seenTitles.add(key);
    idToIdx.set(id, idx);
    titleToIdx.set(key, idx);
    return idx;
  }

  // Process topical feeds first
  for (const feedId of ["india", "world", "business", "technology", "sports", "science", "health"] as SectionId[]) {
    for (const item of feedMap.get(feedId) ?? []) {
      const id  = storyId(item.link);
      const key = normalize(item.title).slice(0, 60);
      if (seenIds.has(id) || (titleDedupEnabled && seenTitles.has(key))) continue;
      if (!isAllowed(item)) { notAllowedDropped++; continue; }
      if (isBlocked(item)) { blockedDropped++; continue; }
      if (!isFresh(item))  { staleDropped++;   continue; }
      addStory(item, feedId);
    }
  }

  // Headlines last — matches get promoted (their section becomes "headlines");
  // homepage-only items (no topical match at all) are classified by actual
  // subject via a small LLM call below, rather than defaulting to "india".
  const promoteIds = new Set<string>();
  const orphanItems: RssItem[] = [];
  for (const item of feedMap.get("headlines") ?? []) {
    const id  = storyId(item.link);
    const key = normalize(item.title).slice(0, 60);
    if (seenIds.has(id) || seenTitles.has(key)) {
      const idx = idToIdx.get(id) ?? titleToIdx.get(key);
      if (idx != null) { headlineIds.add(stories[idx].id); promoteIds.add(stories[idx].id); }
    } else {
      if (!isAllowed(item)) { notAllowedDropped++; continue; }
      if (isBlocked(item)) { blockedDropped++; continue; }
      if (!isFresh(item))  { staleDropped++;   continue; }
      orphanItems.push(item);
    }
  }

  const orphanSections = await classifyOrphanSections(orphanItems);
  orphanItems.forEach((item, i) => {
    const idx = addStory(item, orphanSections[i] ?? "india");
    headlineIds.add(stories[idx].id);
  });

  // Promote homepage+topical matches into Headlines.
  for (const id of promoteIds) {
    const idx = idToIdx.get(id);
    if (idx != null) stories[idx].section = "headlines";
  }

  return { stories, headlineIds, staleDropped, blockedDropped, notAllowedDropped };
}

// ─── Step 3: Fetch article body text ─────────────────────────────────────────

async function fetchArticleText(url: string): Promise<string> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KhabarAI/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(nav|header|footer|aside|form|figure)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 2200);
  } catch { return ""; }
}

// ─── Near-duplicate event merge (deterministic safety net) ───────────────────
// LLM clustering can miss same-event articles, and uncovered articles get
// appended as solo events — so the same story can slip through several times.
// This merges events whose titles overlap heavily (same story, different
// wording/publisher), keeping the earlier/more-important one and folding in the
// other's sources. Runs regardless of what the model returned.

const TITLE_STOPWORDS = new Set([
  "the","a","an","of","to","in","on","for","and","or","is","are","as","at","by","with",
  "from","after","over","amid","into","be","will","its","it","this","that","new","says",
  "said","say","not","no","up","out","off","than","then","but","has","have","had","was",
  "were","who","what","why","how","amp","get","gets","may","can",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w)),
  );
}

/** Strip stray source labels the model sometimes leaves in a title. */
function cleanTitle(title: string, publishers: string[] = []): string {
  let s = (title ?? "").trim();
  s = s.replace(/^\s*\[[^\]]*\]\s*/, "");          // leading "[Source]"
  // trailing " - Publisher" / " | Publisher" when it matches a known publisher
  for (const p of publishers) {
    if (!p) continue;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\s*[-|–—:]\\s*${esc}\\s*$`, "i"), "");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

function titlesSimilar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  if (inter < 4) return false; // need several shared content words (was 3, 2026-07-06 — raised alongside topic-grouping's confidence gate)
  const union       = a.size + b.size - inter;
  const jaccard     = inter / union;
  const containment = inter / Math.min(a.size, b.size);
  // Conservative: only merge near-IDENTICAL titles here (avoids merging unrelated
  // stories that merely share a few words). The LLM dedupe pass + shared-source
  // matching catch same-event stories that are worded differently.
  // Thresholds raised 0.65→0.72 / 0.85→0.9 (2026-07-06) after a report of two
  // non-relevant stories getting merged — tightening this deterministic merge
  // as a second safety margin alongside the new topic-grouping confidence gate.
  return jaccard >= 0.72 || containment >= 0.9;
}

/** Two events are the same if they share any underlying source article. */
function eventsShareSource(a: SelectedEvent, b: Set<string>): boolean {
  return a.sourceStories.some(s => b.has(s.id) || b.has(s.link));
}

function mergeDuplicateEvents(events: SelectedEvent[]): { merged: SelectedEvent[]; removed: number } {
  const kept: SelectedEvent[] = [];
  const keptTokens: Set<string>[] = [];
  const keptSourceKeys: Set<string>[] = [];
  let removed = 0;

  for (const ev of events) {
    const toks = titleTokens(ev.title);
    let target = -1;
    for (let i = 0; i < kept.length; i++) {
      // Same event if titles overlap a lot OR they share an actual source article
      if (titlesSimilar(toks, keptTokens[i]) || eventsShareSource(ev, keptSourceKeys[i])) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      foldEventInto(kept[target], ev);
      // Accumulate tokens + source keys so later variants still match the cluster
      for (const w of toks) keptTokens[target].add(w);
      for (const s of ev.sourceStories) { keptSourceKeys[target].add(s.id); keptSourceKeys[target].add(s.link); }
      removed++;
    } else {
      kept.push(ev);
      keptTokens.push(toks);
      keptSourceKeys.push(new Set(ev.sourceStories.flatMap(s => [s.id, s.link])));
    }
  }
  return { merged: kept, removed };
}

/** Fold dup's sources/metadata into keep (in place). */
function foldEventInto(keep: SelectedEvent, dup: SelectedEvent): void {
  const seen = new Set(keep.sourceStories.map(s => s.id));
  for (const s of dup.sourceStories) if (!seen.has(s.id)) { keep.sourceStories.push(s); seen.add(s.id); }
  keep.publishers      = [...new Set(keep.sourceStories.map(s => s.source))];
  keep.publisherCount  = keep.publishers.length;
  if (!keep.imageUrl) keep.imageUrl = dup.imageUrl;
  keep.inHeadlinesFeed = keep.inHeadlinesFeed || dup.inHeadlinesFeed;
  if (!keep.whyImportant && dup.whyImportant) keep.whyImportant = dup.whyImportant;
}

/**
 * Recompute each event's public id (Story.id, used for "listened" tracking)
 * from the exact composition of its source articles, not whichever single
 * article happened to be kept first during merge/topic-grouping. See call
 * site comment for why: without this, a merge group that changes composition
 * between regenerations silently keeps its old anchor's id, wrongly
 * inheriting "heard" status for what's actually different content.
 */
function finalizeEventIds(events: SelectedEvent[]): void {
  for (const ev of events) {
    const ids = ev.sourceStories.map(s => s.id).sort();
    ev.eventId = storyId(ids.join("|"));
  }
}

/**
 * Second-pass semantic dedupe: a focused LLM call over the selected titles.
 * Title-token overlap misses same-event stories worded very differently (e.g.
 * the same flooding reported five ways). This asks the model to group ONLY
 * true same-event duplicates — different cities/cases stay separate.
 */
async function llmDedupeEvents(events: SelectedEvent[], logger: Logger): Promise<SelectedEvent[]> {
  if (events.length < 3) return events;
  const list = events.map((e, i) => `${i}. [${e.section}] ${e.title}`).join("\n");
  const prompt = `Below are ${events.length} news headlines selected for one briefing. Some are the SAME news event reported by different outlets or worded differently — those are duplicates.

Group the indices that refer to the SAME single event (same incident, ruling, announcement, statement, match, or disaster).

STRICT: only group TRUE duplicates of one event. Do NOT group stories that merely share a topic but are different events — e.g. heavy rain in two DIFFERENT cities, two DIFFERENT court cases, separate accidents, or different companies' results are all DISTINCT and must stay separate.

Return JSON only: {"groups": [[2,7],[4,9,12]]} — include only groups of 2+ indices that are the same event. If there are no duplicates, return {"groups": []}.

Headlines:
${list}`;

  let raw: any;
  try {
    raw = await aiJson(prompt, CLUSTER_MODEL, 4096);
  } catch (err: any) {
    logger(`  dedupe pass skipped: ${err.message?.slice(0, 60)}`);
    return events;
  }
  const groups: any[] = Array.isArray(raw?.groups) ? raw.groups : [];
  if (groups.length === 0) return events;

  const removed = new Set<number>();
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const idxs = [...new Set(g.filter((i: any) => Number.isInteger(i) && i >= 0 && i < events.length && !removed.has(i)))]
      .sort((a: number, b: number) => a - b);
    if (idxs.length < 2) continue;
    const keep = events[idxs[0]];
    for (let j = 1; j < idxs.length; j++) {
      foldEventInto(keep, events[idxs[j]]);
      removed.add(idxs[j]);
    }
  }
  if (removed.size === 0) return events;
  logger(`LLM dedupe merged ${removed.size} duplicate event(s)`);
  return events.filter((_, i) => !removed.has(i));
}

// Minimum confidence (0-1) the model must self-report for a topic-grouping
// group to actually be applied. Added 2026-07-06 after a report of two
// unrelated stories getting clubbed into one bracket — the prompt already said
// "when in doubt, leave separate," but nothing enforced that beyond the
// model's own judgment call on a single pass. Requiring an explicit score and
// discarding anything below this bar gives a real, tunable gate instead of
// just stronger wording. Override via TOPIC_GROUP_MIN_CONFIDENCE.
const TOPIC_GROUP_MIN_CONFIDENCE = Number(process.env.TOPIC_GROUP_MIN_CONFIDENCE ?? 0.9);

/**
 * Topic grouping (2026-07-02): a narrowly-scoped LLM call, separate from the
 * old broad clustering call this replaces. Its ONLY job is to group stories
 * that are about the same SPECIFIC named subject (a person, an ongoing case,
 * a specific bilateral relationship) — not "same event" (that's
 * mergeDuplicateEvents/llmDedupeEvents) and not "same broad theme." It does
 * NOT reassign sections and does NOT rank/order — those stay exactly as
 * already determined. This is deliberately the smallest possible AI task:
 * just "do these already-distinct stories belong to the same running thread,"
 * to avoid the mis-grouping/mis-tagging failures of the old all-purpose call.
 */
async function topicGroupEvents(events: SelectedEvent[], logger: Logger): Promise<SelectedEvent[]> {
  if (events.length < 3) return events;
  const list = events.map((e, i) => `${i}. [${e.section}] ${e.title}`).join("\n");
  const prompt = `Below are ${events.length} DISTINCT news stories already selected for one briefing (these are NOT duplicates of each other — each is a different specific happening).

TASK: find stories that share the exact same SPECIFIC named subject — the same named person, the same ongoing case/investigation, or the same specific bilateral relationship/deal explicitly named in more than one headline — where combining them into one story covering multiple developments would genuinely help the listener follow one thread, instead of hearing that name/subject scattered across several separate stories.

STRICT RULES — do NOT group:
- Stories that merely mention the same country, city, or organisation in passing (e.g. two unrelated stories that both happen to mention India, or both happen to mention Mumbai) — that is a coincidence, not a shared subject.
- Stories that share a broad theme or category (e.g. "two different court cases," "two different accidents," "two different diplomatic visits") without naming the exact same person/case/relationship.
- Stories where you are not confident the specific named subject is identical, not just similar.

When in doubt, leave stories separate. Under-grouping is fine; over-grouping is not — a group that wrongly combines two different subjects will produce a garbled, confusing summary.

For every group, also give a "confidence" score from 0 to 1 for how certain you are the indices genuinely share the exact same specific named subject — 1.0 only if it's unmistakable (e.g. the identical person's name or case name appears in both headlines), lower if there's any ambiguity. Be honest and conservative with this score; it will be used to filter out shaky groups, so do not inflate it.

Return JSON only: {"groups": [{"indices": [2,7], "confidence": 0.95}, ...]} — only include groups of 2+ indices sharing the same specific named subject. If none qualify, return {"groups": []}.

Stories:
${list}`;

  let raw: any;
  try {
    raw = await aiJson(prompt, CLUSTER_MODEL, 4096);
  } catch (err: any) {
    logger(`  topic-grouping pass skipped: ${err.message?.slice(0, 60)}`);
    return events;
  }
  const rawGroups: any[] = Array.isArray(raw?.groups) ? raw.groups : [];
  if (rawGroups.length === 0) return events;

  // Accept both the new {indices, confidence} shape and a bare array of
  // indices (defensive — in case the model ever reverts to the old format
  // despite the schema; treat that as confidence 1 rather than dropping it,
  // since the model wasn't asked to hedge in that shape).
  const groups: Array<{ indices: number[]; confidence: number }> = rawGroups
    .map((g: any) => {
      if (Array.isArray(g)) return { indices: g, confidence: 1 };
      if (g && Array.isArray(g.indices)) return { indices: g.indices, confidence: Number(g.confidence) };
      return null;
    })
    .filter((g): g is { indices: number[]; confidence: number } => g !== null);

  let belowThreshold = 0;
  const removed = new Set<number>();
  for (const g of groups) {
    if (!Number.isFinite(g.confidence) || g.confidence < TOPIC_GROUP_MIN_CONFIDENCE) { belowThreshold++; continue; }
    const idxs = [...new Set(g.indices.filter((i: any) => Number.isInteger(i) && i >= 0 && i < events.length && !removed.has(i)))]
      .sort((a: number, b: number) => a - b);
    if (idxs.length < 2) continue;
    const keep = events[idxs[0]];
    for (let j = 1; j < idxs.length; j++) {
      foldEventInto(keep, events[idxs[j]]);
      removed.add(idxs[j]);
    }
  }
  if (belowThreshold > 0) logger(`Topic grouping discarded ${belowThreshold} low-confidence group(s) (< ${TOPIC_GROUP_MIN_CONFIDENCE})`);
  if (removed.size === 0) return events;
  logger(`Topic grouping combined ${removed.size} stories into shared-subject events`);
  return events.filter((_, i) => !removed.has(i));
}

/**
 * Editorial bias applied on top of raw fetch volume: >1 boosts a section's share,
 * <1 shrinks it. Keeps the split proportional to supply, but weights Top Stories /
 * India / Business / World up and Science / Local / Health down.
 */
const SECTION_BIAS: Record<string, number> = {
  headlines: 2.4, india: 1.3, world: 1.4, business: 1.4,
  technology: 1.0, sports: 1.0, science: 0.5, health: 0.6,
};

/**
 * Per-section target counts, proportional to each section's (bias-weighted) fetch
 * volume, summing to ~maxTotal. target_i = round(maxTotal * w_i / totalW), where
 * w_i = supply_i * bias_i. min 1 for any section that has news.
 */
function proportionalTargets(supply: Map<string, number>, maxTotal: number): Map<string, number> {
  const weighted = new Map<string, number>();
  for (const [sec, n] of supply) if (n > 0) weighted.set(sec, n * (SECTION_BIAS[sec] ?? 1));
  const totalW = [...weighted.values()].reduce((a, b) => a + b, 0) || 1;
  const targets = new Map<string, number>();
  for (const [sec, w] of weighted) targets.set(sec, Math.max(1, Math.round(maxTotal * w / totalW)));
  return targets;
}

/**
 * Take up to `target` events per section (importance order), then top up to
 * maxTotal from leftover events. Hits ~maxTotal while honouring the proportional
 * per-section split; a section short on distinct events yields its slack to others.
 */
function capProportional(
  events: SelectedEvent[],
  maxTotal: number,
  targets: Map<string, number>,
): SelectedEvent[] {
  const perSec = new Map<string, number>();
  const out: SelectedEvent[] = [];
  const used = new Set<number>();
  // Pass 1 — proportional quota per section
  for (let i = 0; i < events.length && out.length < maxTotal; i++) {
    const ev = events[i];
    const c = perSec.get(ev.section) ?? 0;
    if (c >= (targets.get(ev.section) ?? 0)) continue;
    out.push(ev); used.add(i); perSec.set(ev.section, c + 1);
  }
  // Pass 2 — fill remaining budget from leftovers, by importance
  for (let i = 0; i < events.length && out.length < maxTotal; i++) {
    if (!used.has(i)) out.push(events[i]);
  }
  return out;
}

// ─── Step 4: No clustering (2026-07-02) ──────────────────────────────────────
// Per editorial decision: clustering (the LLM grouping call) was producing
// mis-tagged/mis-grouped events, so it's disabled by default (re-enable via
// ENABLE_CLUSTERING=true). Each raw article becomes its own event, 1:1 —
// no AI grouping, no fuzzy/semantic dedup. The only dedup applied is the
// exact-title-match dedup already done upstream in buildRawStories.
function buildSoloEvents(stories: Story[], headlineIds: Set<string>): SelectedEvent[] {
  return stories.map(s => ({
    eventId:          s.id,
    // BUG FIX (2026-07-03): raw RSS titles often carry a trailing " - Publisher"
    // suffix (e.g. "... at MAHE - NDTV" vs "... at MAHE - The Times of India").
    // Since the merge step compares titles by token overlap, two DIFFERENT
    // publishers' suffixes counted as differing content words and silently
    // dragged genuinely-identical stories below the merge threshold — e.g. the
    // same appointment/deal/story reported by two outlets stayed as two
    // separate stories instead of merging. cleanTitle() strips that suffix.
    title:            cleanTitle(s.title, [s.source]),
    section:          s.section,
    sourceStories:    [s],
    publisherCount:   1,
    publishers:       [s.source],
    imageUrl:         s.imageUrl,
    firstPublishedAt: s.publishedAt,
    inHeadlinesFeed:  headlineIds.has(s.id),
    whyImportant:     "",
  }));
}

// ─── Step 4b: Cluster same-event articles (single AI call, opt-in) ───────────

async function clusterAndSelect(
  stories: Story[],
  headlineIds: Set<string>,
  maxStories: number,
  logger: Logger,
  targets: Map<string, number>,
): Promise<SelectedEvent[]> {
  const articleList = stories.map((s, i) =>
    `${i}. [${s.source}]${headlineIds.has(s.id) ? " ★" : ""} [${s.section}] ${s.title}`
  ).join("\n");

  // Per-section target counts (proportional to fetch volume) — what the final
  // briefing should contain from each section.
  const targetsLine = SECTION_ORDER.map(x => targets.get(x) ? `${x}: ${targets.get(x)}` : null)
    .filter(Boolean).join(", ");

  const prompt = `You are the news editor for Khabar AI — India's top audio news briefing.

Here are ${stories.length} articles from today's Google News feeds (India, World, Business, Technology, Sports, Science, Health, Local, Headlines).
★ = appeared on Google's homepage — stronger editorial signal.

TASK:
1. Group articles about the SAME SPECIFIC event into one cluster (the same incident, ruling, announcement, or statement), even if worded differently by different publishers. CRITICAL: do NOT merge stories that are merely on the same topic, in the same section, or involve the same person/country but are actually DIFFERENT events — keep those separate. Two SEPARATE incidents are DIFFERENT events even if the same KIND — e.g. a lightning strike that kills two and a highway crash that kills a family are two different stories and must NEVER share a cluster just because both involve deaths/accidents. When in doubt, keep them separate. A cluster's articles must all be about the one same event, or the summary will mix unrelated facts.
2. Cover as many genuinely DISTINCT events as possible — up to ${maxStories}. Include every unique story, but never list the same event twice.
3. Order from most to least important.
4. PER-SECTION TARGETS (proportional to each section's article volume): aim for about this many DISTINCT events per section — ${targetsLine}. Meet each target where genuinely distinct events exist; a thin section yields fewer (never pad, repeat, or split one event). It's fine to slightly exceed a target — extra good events help fill the briefing. Judge significance WITHIN each topic, not against politics.

IMPORTANCE GUIDE (for ORDERING and for filling remaining slots after the per-section guarantee):
- Major: Parliament/Cabinet decisions, elections, RBI/budget/market moves, India-Pakistan/China, Supreme Court, major disasters
- Medium: International events affecting India, corporate/economic policy, state-level governance
- Lower: Routine updates, niche stories, individual match results (unless major tournament)
- ★ stories get a +1 importance boost in ordering

Return a JSON object with a single key "events":
{"events": [
  {
    "title": "specific, factual event title — max 10 words",
    "section": "headlines|india|world|business|technology|sports|science|health|local",
    "sourceIndices": [0, 4, 12],
    "imageIndex": 0,
    "whyImportant": "one sentence — the key reason this matters"
  }
]}

RULES:
- Return exactly ${maxStories} events (or fewer if total distinct events is less)
- Every index used in sourceIndices must be in range 0–${stories.length - 1}
- section: assign based on content — "headlines" for major cross-cutting stories, else the best-fitting topic: india, world, business, technology, sports, science, or health
- imageIndex: which sourceIndex is most likely to have a good image (Reuters, AP, PTI, AFP > others)
- Keep clusters tight — only group articles covering the SAME specific event

Articles:
${articleList}`;

  logger(`Clustering ${stories.length} articles (1 AI call)…`);

  let raw: any;
  try {
    raw = await aiJson(prompt, CLUSTER_MODEL, 16384);
  } catch (err: any) {
    logger(`  ✗ Cluster failed: ${err.message?.slice(0, 80)} — using top ${maxStories} as solo events`);
    // Fallback: each story becomes its own event, capped at maxStories
    return stories.slice(0, maxStories).map(s => ({
      eventId:         s.id,
      title:           s.title,
      section:         s.section,
      sourceStories:   [s],
      publisherCount:  1,
      publishers:      [s.source],
      imageUrl:        s.imageUrl,
      firstPublishedAt: s.publishedAt,
      inHeadlinesFeed: headlineIds.has(s.id),
      whyImportant:    "",
    }));
  }

  const groups: Array<{
    title: string;
    section: string;
    sourceIndices: number[];
    imageIndex?: number;
    whyImportant: string;
  }> = Array.isArray(raw) ? raw : (raw?.events ?? []);

  if (!Array.isArray(groups) || groups.length === 0) {
    logger(`  ✗ Empty cluster response — using top ${maxStories} as solo events`);
    return stories.slice(0, maxStories).map(s => ({
      eventId: s.id, title: s.title, section: s.section,
      sourceStories: [s], publisherCount: 1, publishers: [s.source],
      imageUrl: s.imageUrl, firstPublishedAt: s.publishedAt,
      inHeadlinesFeed: headlineIds.has(s.id), whyImportant: "",
    }));
  }

  const covered = new Set<number>();
  const events: SelectedEvent[] = [];

  for (const g of groups) {
    const indices = (g.sourceIndices ?? []).filter((i: number) => i >= 0 && i < stories.length);
    if (indices.length === 0) continue;
    indices.forEach((i: number) => covered.add(i));

    const title    = (g.title ?? "").trim();
    if (!title) continue;

    const section  = (["headlines", "india", "world", "business", "technology", "sports", "science", "health"].includes(g.section)
      ? g.section : stories[indices[0]].section) as SectionId;

    const imageIdx      = (g.imageIndex != null && indices.includes(g.imageIndex)) ? g.imageIndex : indices[0];
    const publishers    = [...new Set(indices.map((i: number) => stories[i].source))] as string[];
    const dates         = indices.map((i: number) => stories[i].publishedAt).sort();
    const imageUrl      = stories[imageIdx]?.imageUrl ?? indices.map((i: number) => stories[i].imageUrl).find(Boolean);
    const sourceStories = indices.map((i: number) => stories[i]);
    const inHeadlines   = sourceStories.some(s => headlineIds.has(s.id));

    const cleanedTitle = cleanTitle(title, publishers);
    events.push({
      // ID is derived from BOTH the representative article's link AND the title
      // the clustering pass assigned it, not the link alone. Clustering is an LLM
      // call and isn't perfectly stable across regenerations: the same anchor
      // article can end up grouped into a materially different event/title on a
      // re-run. Hashing link-only would keep the OLD id (and wrongly inherit its
      // "already heard" mark) even though the story shown is now different;
      // folding the title in means a changed grouping gets a new id instead.
      eventId:         storyId(`${stories[imageIdx]?.link ?? stories[indices[0]].link}|${cleanedTitle}`),
      title:           cleanedTitle,
      section,
      sourceStories,
      publisherCount:  publishers.length,
      publishers,
      imageUrl,
      firstPublishedAt: dates[0] ?? new Date().toISOString(),
      inHeadlinesFeed: inHeadlines,
      whyImportant:    String(g.whyImportant ?? "").slice(0, 200),
    });
  }

  // Uncovered stories → append as solo events (dedupe pass below removes any
  // that are really the same story the model already clustered)
  for (let i = 0; i < stories.length; i++) {
    if (!covered.has(i)) {
      const s = stories[i];
      events.push({
        eventId: s.id, title: s.title, section: s.section,
        sourceStories: [s], publisherCount: 1, publishers: [s.source],
        imageUrl: s.imageUrl, firstPublishedAt: s.publishedAt,
        inHeadlinesFeed: headlineIds.has(s.id), whyImportant: "",
      });
    }
  }

  // Deterministic near-duplicate merge (cheap safety net for missed clustering)
  const { merged, removed } = mergeDuplicateEvents(events);
  if (removed > 0) logger(`Merged ${removed} near-duplicate event(s) by title overlap`);

  // Second pass: focused LLM dedupe catches same-event stories worded differently
  const deduped = await llmDedupeEvents(merged, logger);

  // Allocate proportionally to each section's target, topping up to maxStories.
  const capped = capProportional(deduped, maxStories, targets);
  logger(`Clustered into ${capped.length} events (target: ${maxStories}, ~${Math.round(capped.length * WORDS_PER_STORY / WORDS_PER_MINUTE)} min)`);
  return capped;
}

// ─── Step 5: Script generation ────────────────────────────────────────────────

function isValidScript(text: string | undefined): boolean {
  if (!text || text.trim().length < 10) return false;
  // Floor lowered 25 -> 15 (2026-07-04): this should only catch genuinely
  // broken output (empty, one-liner refusal, truncated JSON), not merely-
  // terse-but-fine scripts. The prompt's "45-65 words" is what pushes toward
  // the target length — rejecting a coherent 21-24 word script here just
  // forces a wasteful retry (another OpenAI call) for no real quality gain,
  // which piles on exactly when the API is already rate-limited.
  if (text.trim().split(/\s+/).length < 15) return false;
  if (/[ऀ-ॿ஀-௿]/.test(text)) return false; // no foreign script in English field
  return true;
}

async function scriptEvent(
  ev: SelectedEvent,
  logger: Logger,
): Promise<{ title: string; scriptEn: string }> {
  // Short-circuit if the run was aborted — avoids dozens of wasted fetches + API calls
  if (isAbortRequested()) {
    return { title: ev.title, scriptEn: "" };
  }

  // Fetch article bodies for top 3 sources in parallel
  const topStories   = ev.sourceStories.slice(0, 3);
  const articleTexts = await Promise.all(topStories.map(s => fetchArticleText(s.link)));

  const sectionLabel = ev.section === "headlines" ? "Headlines"
    : ev.section.charAt(0).toUpperCase() + ev.section.slice(1);

  const sourcesText = ev.sourceStories.slice(0, 5).map((s, i) => {
    const desc = s.description?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300) ?? "";
    const body = (articleTexts[i] ?? "").slice(0, 1500);
    return [
      `  [${s.source}] ${s.title}`,
      desc  ? `  Summary: ${desc}` : "",
      body.length > 100 ? `  Article: ${body}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const prompt = `You are the lead scriptwriter for Khabar AI — India's fast, factual audio news briefing.

Write a spoken script for this ${sectionLabel} story. Target: 45-65 words — very quick, headline + key facts only. This will be read aloud.

Think a wire-service brief read aloud: state only the facts the sources report — what happened, who, when, where, and the key numbers. Report; do not interpret. No analysis, no speculation, no opinion, no "why it matters," no significance or framing. Warm and clear, but fast and neutral.

If the sources below describe more than one distinct development about the same subject (not just the same fact worded differently), briefly cover the most important 2-3 in order, as one coherent update — do not just repeat one source's framing and ignore the others.

STORY: ${ev.title}
SECTION: ${sectionLabel}
SOURCES (${ev.publisherCount} publisher${ev.publisherCount !== 1 ? "s" : ""}${ev.inHeadlinesFeed ? ", ★ on Google homepage" : ""}):
${sourcesText}

STRUCTURE (very short):
- Sentence 1: the headline fact — what happened, with the concrete specifics (who / what / where)
- Sentence 2-3: the remaining key facts or numbers straight from the sources, then stop

VOICE & STYLE:
- Plain, factual, neutral — like a newsreader, not a columnist
- Active voice throughout
- Use the real numbers, names and places from the sources; nothing vague
- State facts directly; do not characterize them as good, bad, surprising, or important

HARD RULES:
- FORBIDDEN openers: "Today", "In a significant development", "According to", "A new", "The", "In what"
- FORBIDDEN endings: "Stay tuned", "Watch this space", "Keep an eye on", any tease or CTA
- FORBIDDEN: interpretation, analysis, predictions, or editorializing — facts only
- FORBIDDEN words: "reportedly", "sources say", "it is said", "stakeholders", "signals", "could mean", "experts say", "analysts"
- NO demographic mentions: "Indians", "citizens", "the public", "people"
- NO bullet points, no parentheses, no lists
- NEVER invent facts — only use what is in the sources
- COVER EVERY EVENT IN THE SOURCES: the sources are usually one event — summarise that. But if they actually describe MORE THAN ONE distinct event (e.g. two different accidents), you MUST cover ALL of them — never drop one. Give each its own short sentence (you may exceed the word target slightly), and the title must reflect all of them, not just the first.
- NO DATES OR YEARS: never state a year (e.g. "2023", "2026") or a specific calendar date in the script. This is today's news — refer to time only relatively and only when certain from the sources ("today", "this week"); otherwise omit the timeframe entirely. The only exception is a clearly upcoming scheduled event whose date is explicitly in the sources. Use figures (amounts, counts) only if they appear in the sources.

TITLE RULES — "title" must be a clean, factual headline for THIS exact story:
- max 9 words, plain text, accurate to the script and the sources
- NEVER include a publication or source name (no "TOI", "Reuters", "- NDTV", etc.)
- no brackets, no quotes, no trailing source attribution

Return ONLY valid JSON: {"title": "...", "scriptEn": "..."}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await aiJson(prompt, getScriptModel(), 4096);
      const title    = cleanTitle((raw.title || ev.title).trim(), ev.publishers);
      const scriptEn = (raw.scriptEn || "").trim();
      if (!isValidScript(scriptEn)) {
        throw new Error(`Script invalid: ${scriptEn.split(/\s+/).length} words`);
      }
      logger(`    ✓ ${scriptEn.split(/\s+/).length}w: ${title.slice(0, 55)}`);
      return { title, scriptEn };
    } catch (err: any) {
      logger(`    ✗ attempt ${attempt}/2: ${err.message?.slice(0, 80)}`);
    }
  }

  // Fallback — stitch source text together
  const fallback = [ev.title + ".", ev.sourceStories[0]?.description?.replace(/<[^>]+>/g, "").trim()].filter(Boolean).join(" ");
  logger(`    ! fallback: ${ev.title.slice(0, 55)}`);
  return { title: ev.title, scriptEn: fallback };
}

async function scriptAllEvents(
  events: SelectedEvent[],
  logger: Logger,
): Promise<Story[]> {
  logger(`Scripting ${events.length} events in parallel (up to 10 concurrent)…`);

  // Gate the WHOLE event (article-body fetches + AI call) behind scriptLimit so at
  // most 10 events run end-to-end at once — bounds outbound fetches to ~30, not ~100.
  const results = await Promise.all(
    events.map((ev) => scriptLimit(async () => {
      const { title, scriptEn } = await scriptEvent(ev, logger);
      const primary = ev.sourceStories[0];
      return {
        id:              ev.eventId,
        title,
        source:          ev.publishers[0] ?? primary.source,
        link:            primary.link,
        publishedAt:     ev.firstPublishedAt,
        section:         ev.section,
        imageUrl:        ev.imageUrl ?? primary.imageUrl,
        description:     primary.description,
        sources:         ev.sourceStories.map(s => ({ title: s.title, source: s.source, link: s.link })),
        scriptEn,
        scriptHi:        "",
        audioStartSec:   0,
        importanceReason: ev.whyImportant,
        wordCount:       scriptEn.trim().split(/\s+/).length,
        publisherCount:  ev.publisherCount,
        publishers:      ev.publishers,
      } satisfies Story;
    })),
  );

  logger(`Scripting done — ${results.length} stories`);
  return results;
}

// ─── Step 6: TTS (English only) ───────────────────────────────────────────────

async function synthesizeOne(text: string, filename: string, provider: TtsProvider, index?: number): Promise<string> {
  if (provider === "google")     { const { url } = await googleTTS(text, filename);        return url; }
  if (provider === "elevenlabs") { const { url } = await elevenLabsTTS(text, filename);     return url; }
  if (provider === "edge")       { const { url } = await edgeTTS(text, filename, index);    return url; }
  if (provider === "kokoro")     { const { url } = await kokoroTTS(text, filename);         return url; }
  if (provider === "openai")     { const { url } = await openaiTTS(text, filename);         return url; }
  throw new Error(`Unknown TTS provider: ${provider}`);
}

// ─── Step 5b: Translate English → other languages ────────────────────────────

const LANG_NAMES: Record<string, string> = { hi: "Hindi", ta: "Tamil", mr: "Marathi" };
// Validate the translation came back in the right script (Devanagari / Tamil)
const LANG_SCRIPT_RE: Record<string, RegExp> = { hi: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, ta: /[஀-௿]/ };

// gpt-4o-mini is cheap and good enough for short news translation. Override via TRANSLATE_MODEL.
function getTranslateModel(): string { return process.env.TRANSLATE_MODEL ?? "gpt-4o-mini"; }

function setScript(s: Story, lang: string, text: string): void {
  if (lang === "hi") s.scriptHi = text;
  else if (lang === "ta") s.scriptTa = text;
  else if (lang === "mr") s.scriptMr = text;
}
function setTitle(s: Story, lang: string, text: string): void {
  if (!text) return;
  if (lang === "hi") s.titleHi = text;
  else if (lang === "ta") s.titleTa = text;
  else if (lang === "mr") s.titleMr = text;
}
function scriptForLang(s: Story, lang: string): string | undefined {
  if (lang === "en") return s.scriptEn || undefined;
  if (lang === "hi") return s.scriptHi || undefined;
  if (lang === "ta") return s.scriptTa || undefined;
  if (lang === "mr") return s.scriptMr || undefined;
  return undefined;
}
function setAudioUrl(s: Story, lang: string, url: string): void {
  if (lang === "en") s.audioUrlEn = url;
  else if (lang === "hi") s.audioUrlHi = url;
  else if (lang === "ta") s.audioUrlTa = url;
  else if (lang === "mr") s.audioUrlMr = url;
}

type TransItem = { title: string; script: string };

// Translate one batch, matching results back to inputs by an explicit "i" index
// the model must echo — NOT by array position. Position-based matching (the old
// approach) silently corrupted data whenever the model dropped, merged, split, or
// reordered even one item in a batch: everything after that point would zip onto
// the WRONG story, so a story could end up with another story's Hindi title/script
// (this is what showed up as "Hindi/English text overlapping" — the wrong-story
// translation was genuinely being saved and spoken, not a display bug). Any item
// missing a valid, in-range, unique "i" is dropped rather than guessed at.
async function translateBatch(items: TransItem[], lang: string): Promise<Map<number, TransItem>> {
  const name = LANG_NAMES[lang] ?? lang;
  const prompt = `Translate each of these ${items.length} short English news items into ${name}. Each item has an INDEX (i), a TITLE (headline), and a SCRIPT (read ALOUD in an audio briefing). Translate BOTH the title and script. They must sound natural spoken: everyday conversational ${name} (not heavy or over-Sanskritised), keep every name, place and number accurate, and write in the ${name} script.

CRITICAL: echo back the exact same "i" index given for each item below, so translations can be matched to the correct original item. Do not renumber, skip, merge, or reorder items — one output object per input index.

Return ONLY JSON: {"t": [{"i": 0, "title": "…", "script": "…"}, …]} — exactly ${items.length} objects, one per input index below.

${items.map((it, i) => `[${i}] TITLE: ${it.title}\nSCRIPT: ${it.script}`).join("\n\n")}`;
  const raw = await openaiJson(prompt, getTranslateModel(), 8192);
  const arr: any[] = Array.isArray(raw?.t) ? raw.t : (Array.isArray(raw) ? raw : []);

  const out = new Map<number, TransItem>();
  for (const x of arr) {
    const i = Number(x?.i);
    if (!Number.isInteger(i) || i < 0 || i >= items.length || out.has(i)) continue;
    const script = String(x?.script ?? "").trim();
    if (!script) continue;
    out.set(i, { title: String(x?.title ?? "").trim(), script });
  }
  return out;
}

// Retry a batch translation like every other AI call in this file (scripts retry
// 2x, TTS retries 3x) — translateAll previously had NO retry, so a single
// transient OpenAI timeout/429 permanently dropped Hindi for up to BATCH stories
// in that run. That's the other direct cause of EN/HI script-count mismatches.
async function translateBatchWithRetry(
  items: TransItem[],
  lang: string,
  logger: Logger,
): Promise<Map<number, TransItem>> {
  let lastErr: any;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await translateBatch(items, lang);
    } catch (err: any) {
      lastErr = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  logger(`  ✗ translate ${lang} batch failed after retry: ${lastErr?.message?.slice(0, 60)}`);
  return new Map();
}

/** Translate every story's English title + script into each language (in place). Batched + cheap. */
async function translateAll(stories: Story[], langs: string[], logger: Logger): Promise<void> {
  const limit = makeConcurrencyLimiter(5);
  const BATCH = 10;
  for (const lang of langs) {
    if (isAbortRequested()) return;
    logger(`Translating ${stories.length} stories → ${LANG_NAMES[lang] ?? lang}…`);
    let ok = 0;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < stories.length; i += BATCH) {
      const slice = stories.slice(i, i + BATCH);
      // Only send stories that actually have an English script — previously the
      // whole slice (including any empty-scriptEn stories) was sent as-is, wasting
      // a slot in the batch on nothing for the model to translate.
      const withScript = slice
        .map((s, j) => ({ s, j }))
        .filter(({ s }) => !!s.scriptEn);
      tasks.push(limit(async () => {
        if (isAbortRequested() || withScript.length === 0) return;
        const out = await translateBatchWithRetry(
          withScript.map(({ s }) => ({ title: s.title, script: s.scriptEn })),
          lang, logger,
        );
        withScript.forEach(({ s }, localIdx) => {
          const tr = out.get(localIdx);
          if (tr && tr.script && LANG_SCRIPT_RE[lang]?.test(tr.script)) {
            setScript(s, lang, tr.script);
            if (tr.title && LANG_SCRIPT_RE[lang]?.test(tr.title)) setTitle(s, lang, tr.title);
            ok++;
          }
        });
      }));
    }
    await Promise.all(tasks);
    logger(`  ${LANG_NAMES[lang] ?? lang}: ${ok}/${stories.length} translated`);
  }
}

// ─── Step 6: TTS (per language) ───────────────────────────────────────────────

async function generateAllTTS(
  stories: Story[],
  date: string,
  provider: TtsProvider,
  languages: string[],
  logger: Logger,
  onProgress?: (stories: Story[]) => Promise<void>,
): Promise<{ stories: Story[]; costInfo: TtsCostInfo }> {
  logger(`TTS (${provider}): ${stories.length} stories × ${languages.length} lang(s) [${languages.join(",")}]`);
  const updated = stories.map(s => ({ ...s }));
  let totalChars = 0;
  let clips = 0;

  // 5 concurrent for TTS — Edge has no rate limit; others are conservative
  const ttsLimit = makeConcurrencyLimiter(5);

  // Serialize checkpoint saves so concurrent TTS tasks don't interleave the
  // read-modify-write in saveBriefing (lost updates / corrupt JSON in LOCAL_MODE).
  const saveQueue = makeSerializer();
  const safeProgress = onProgress
    ? (s: Story[]) => saveQueue(() => onProgress(s))
    : undefined;
  // Throttle checkpoint saves: the full briefing is re-uploaded each time, so
  // saving after every clip (75×4≈300) overloads Storage (Gateway Timeouts).
  // Checkpoint at most every 20s; the final save persists the complete state.
  let lastCheckpoint = Date.now();
  const CHECKPOINT_MS = 20_000;

  // Voice alternation index — NOT the raw array position. `updated` is
  // grouped by section, but items promoted into "headlines" keep their
  // original array slot while only their `.section` label changes (see
  // buildRawStories), so a section's actual on-device playback order is a
  // filtered, non-contiguous subsequence of this array. Alternating by raw
  // index broke that: e.g. section "india" at raw positions 0,1,2,3,4 (voices
  // A,B,A,B,A) with position 2 promoted out to "headlines" leaves india's
  // real playback order as 0,1,3,4 → A,B,B,A, two B's in a row. Computing the
  // index as "position within this story's own final section" instead keeps
  // strict alternation for what listeners actually hear back-to-back.
  const sectionCounters = new Map<string, number>();
  const voiceIndexByStory = updated.map((s) => {
    const n = sectionCounters.get(s.section) ?? 0;
    sectionCounters.set(s.section, n + 1);
    return n;
  });

  // One job per (story, language) clip
  const jobs: Array<{ i: number; lang: string }> = [];
  for (let i = 0; i < updated.length; i++) for (const lang of languages) jobs.push({ i, lang });

  await Promise.all(
    jobs.map(({ i, lang }) =>
      ttsLimit(async () => {
        if (isAbortRequested()) return;
        if (provider === "google"     && isDailyQuotaExhausted()) return;
        if (provider === "elevenlabs" && isQuotaExhausted())      return;

        const script = scriptForLang(updated[i], lang);
        if (!script) return;

        try {
          const url = await synthesizeOne(script, `${date}-${updated[i].id}-${lang}`, provider, voiceIndexByStory[i]);
          setAudioUrl(updated[i], lang, url);
          updated[i].audioStartSec = 0;
          totalChars += script.length;
          clips++;
        } catch (err: any) {
          logger(`  ✗ [${updated[i].id.slice(0, 6)}/${lang}]: ${err.message?.slice(0, 50)}`);
        }

        // Throttled, non-fatal checkpoint — never let a save failure abort TTS
        if (safeProgress && Date.now() - lastCheckpoint > CHECKPOINT_MS) {
          lastCheckpoint = Date.now();
          try { await safeProgress([...updated]); }
          catch (e: any) { logger(`  checkpoint save skipped: ${e?.message?.slice(0, 50)}`); }
        }
      }),
    ),
  );

  const storiesWithAudio = updated.filter(s => s.audioUrlEn).length;
  const estimatedUsd =
    provider === "elevenlabs" ? (totalChars / 1000) * 0.08 :
    provider === "google"     ? (totalChars / 1_000_000) * 0.50 : 0;

  logger(`TTS done: ${clips} clips, ${storiesWithAudio}/${stories.length} stories with EN audio, est. $${estimatedUsd.toFixed(3)}`);
  return {
    stories: updated,
    costInfo: { provider, totalChars, estimatedUsd, storiesAttempted: stories.length, storiesWithAudio },
  };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), ".local-data");

export async function saveBriefing(briefing: DailyBriefing): Promise<void> {
  if (!LOCAL_MODE) { await saveBriefingToStorage(briefing.date, briefing); return; }
  await mkdir(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, "briefings.json");
  let all: DailyBriefing[] = [];
  try { all = JSON.parse(await readFile(path, "utf-8")); } catch {}
  all = [briefing, ...all.filter(b => b.date !== briefing.date)];
  await writeFile(path, JSON.stringify(all, null, 2));
}

function mapOldSection(cat: string): SectionId {
  const m: Record<string, SectionId> = {
    headlines: "headlines", india: "india", world: "world", business: "business",
    technology: "technology", sports: "sports", science: "science", health: "health",
    // old taxonomy → nearest new section (local section removed 2026-07-02 — was
    // hardcoded to one default city with no real per-user wiring)
    politics: "india", techlife: "technology", entertainment: "india", local: "india",
    // legacy v2/v3
    "india-national": "india", "india-business": "business", "india-sports": "india",
    "india-tech": "india", "global-world": "world", "global-business": "business",
    economy: "business", "economy/finance": "business",
  };
  return m[cat] ?? "india";
}

function normalizeBriefing(raw: any): DailyBriefing {
  if (Array.isArray(raw.stories)) return raw as DailyBriefing;
  const stories: Story[] = [];
  if (Array.isArray(raw.sections)) {
    for (const section of raw.sections) {
      for (const topic of (section.topics ?? [])) {
        stories.push({
          id:            topic.id ?? storyId(topic.sourceUrl ?? String(Math.random())),
          title:         topic.headline ?? topic.title ?? "",
          source:        topic.sourceName ?? "Unknown",
          link:          topic.sourceUrl ?? "",
          publishedAt:   raw.generatedAt ?? new Date().toISOString(),
          section:       mapOldSection(section.category),
          scriptEn:      topic.monologueScript ?? "",
          scriptHi:      "",
          audioUrlEn:    topic.audioUrlEn ?? topic.audioUrl,
          audioStartSec: 0,
        });
      }
    }
  }
  return { date: raw.date ?? (raw.generatedAt ?? "").slice(0, 10), generatedAt: raw.generatedAt ?? new Date().toISOString(), stories };
}

export async function getLatestBriefing(): Promise<DailyBriefing | null> {
  if (!LOCAL_MODE) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
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
  ttsProvider: TtsProvider = "edge",
  languages: string[] = ["en"],
): Promise<DailyBriefing & { runSummary?: RunSummary }> {
  const runStart = Date.now();
  const date     = new Date().toISOString().slice(0, 10);
  const log      = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing v5 — ${date} | TTS: ${ttsProvider}`);

  // English is always scripted; every other supported language is TRANSLATED from it.
  const SUPPORTED_LANGS = ["en", "hi", "ta", "mr"];
  const targetLangs = ["en", ...SUPPORTED_LANGS.filter(l => l !== "en" && languages.includes(l))];
  const generatedLanguages = targetLangs;
  if (targetLangs.length > 1) log(`Languages: ${targetLangs.join(", ")} (English scripted, others translated)`);

  // Step 1: Fetch
  const t0 = Date.now();
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap  = await fetchAllFeeds();
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (isAbortRequested()) throw new Error("Aborted by user");

  // Step 2: Dedup
  const { stories: rawStories, headlineIds, staleDropped, blockedDropped, notAllowedDropped } = await buildRawStories(feedMap);
  log(`After dedup: ${rawStories.length} unique articles (${headlineIds.size} on Google homepage) — dropped ${staleDropped} stale, ${blockedDropped} blocked-source, ${notAllowedDropped} non-allowlisted publisher`);
  for (const [sectionId, config] of FEED_MAP) {
    const n = rawStories.filter(s => s.section === sectionId).length;
    if (n > 0) log(`  ${config.emoji} ${config.label}: ${n}`);
  }

  const fetchSec = (Date.now() - t0) / 1000;

  // True supply per section (all fresh articles) → proportional per-section targets
  // that sum to ~MAX_STORIES.
  const supplyBySection = new Map<string, number>();
  for (const s of rawStories) supplyBySection.set(s.section, (supplyBySection.get(s.section) ?? 0) + 1);
  const targets = proportionalTargets(supplyBySection, MAX_STORIES);
  log(`Per-section targets (proportional to fetch): ${SECTION_ORDER.map(x => targets.get(x) ? `${x} ${targets.get(x)}` : null).filter(Boolean).join(", ")}`);

  const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true"; // default OFF — see Step 4 comment

  const t1 = Date.now();
  let selectedEvents: SelectedEvent[];

  if (ENABLE_CLUSTERING) {
    // Feed the clustering call a bounded set: ~2× each section's target (headroom
    // for de-duping), min 6 so small sections still have candidates. Keeps the one
    // LLM call fast (≈200 titles, not 399) while supporting the targets.
    const rawSeen = new Map<SectionId, number>();
    const clusterInput = rawStories.filter(s => {
      const cap = Math.max(6, (targets.get(s.section) ?? 1) * 2);
      const c = rawSeen.get(s.section) ?? 0;
      if (c >= cap) return false;
      rawSeen.set(s.section, c + 1);
      return true;
    });
    log(`Clustering input: ${clusterInput.length} articles (from ${rawStories.length})`);

    selectedEvents = await clusterAndSelect(clusterInput, headlineIds, MAX_STORIES, log, targets);
  } else {
    // No clustering + no cap (2026-07-02): with generation restricted to the
    // 7-publisher allowlist, the point is to include EVERY article those papers
    // published (post exact-title-dedup, post freshness) — not trim down to
    // MAX_STORIES/TARGET_MINUTES. Briefing length is however much these 7
    // papers actually produced that day, not a fixed target. (Re-enable a cap
    // via CAP_SOLO_EVENTS=true if this ever needs bounding again.)
    const soloEvents = buildSoloEvents(rawStories, headlineIds);

    // Re-enabled (2026-07-03): only the BLUNT title-prefix dedup in
    // buildRawStories stays off for now (still the suspect for silently
    // dropping distinct articles that share a generic title prefix). This
    // merge is a different, smarter tool — full-title overlap / shared source
    // article, e.g. it correctly folds "Hyderabad Woman Dies By Suicide During
    // Video Call" and "...On Video Call" into ONE story with two sources,
    // rather than leaving both as separate duplicate stories (which is what
    // happened while this was off). Escape hatch: ENABLE_DUPLICATE_MERGE=false.
    const dupMergeEnabled = process.env.ENABLE_DUPLICATE_MERGE !== "false";
    let merged = soloEvents;
    if (dupMergeEnabled) {
      const r = mergeDuplicateEvents(soloEvents);
      merged = r.merged;
      if (r.removed > 0) log(`Merged ${r.removed} near-duplicate event(s) by title overlap`);
    }

    // Topic grouping re-enabled too — combines DISTINCT stories sharing the
    // same specific named subject (see topicGroupEvents() comment). Escape
    // hatch: ENABLE_TOPIC_GROUPING=false.
    const topicGroupingEnabled = process.env.ENABLE_TOPIC_GROUPING !== "false";
    const topicGrouped = topicGroupingEnabled ? await topicGroupEvents(merged, log) : merged;

    const capEnabled = process.env.CAP_SOLO_EVENTS === "true";
    selectedEvents = capEnabled ? capProportional(topicGrouped, MAX_STORIES, targets) : topicGrouped;
    log(`Clustering disabled (title-dedup ${process.env.ENABLE_TITLE_DEDUP !== "false" ? "on" : "off"}, merge ${dupMergeEnabled ? "on" : "off"}, topic-grouping ${topicGroupingEnabled ? "on" : "off"}) — ${selectedEvents.length} events${capEnabled ? ` (capped from ${topicGrouped.length})` : ", no cap"}`);

  }

  // "Listened" status fix (2026-07-03): mergeDuplicateEvents/topicGroupEvents
  // fold multiple raw articles into one survivor WITHOUT updating its eventId
  // (foldEventInto never touches it) — so on a same-day regeneration, a story
  // whose merge group grows or changes composition would otherwise silently
  // keep the old anchor article's id, wrongly inheriting its "heard" mark even
  // though the actual script gets rewritten fresh from a different set of
  // sources. Recomputing each id from the full (sorted) set of source-article
  // ids means: same exact composition -> same id (correctly stays "heard");
  // different composition -> different id (no false carryover, genuinely new).
  finalizeEventIds(selectedEvents);

  const clusterSec = (Date.now() - t1) / 1000;

  log(`${selectedEvents.length} events — est. ~${Math.round(selectedEvents.length * WORDS_PER_STORY / WORDS_PER_MINUTE)} min briefing`);

  if (isAbortRequested()) throw new Error("Aborted by user");

  // Early save
  await saveBriefing({
    date, generatedAt: new Date().toISOString(), generatedLanguages,
    stories: selectedEvents.map(ev => ({
      id: ev.eventId, title: ev.title, source: ev.publishers[0] ?? "",
      link: ev.sourceStories[0]?.link ?? "", publishedAt: ev.firstPublishedAt,
      section: ev.section, imageUrl: ev.imageUrl, scriptEn: "", scriptHi: "",
    })),
  });

  // Step 5: Scripts
  const t2 = Date.now();
  const stories = await scriptAllEvents(selectedEvents, log);
  const scriptSec = (Date.now() - t2) / 1000;
  log(`Scripts done in ${scriptSec.toFixed(1)}s`);

  if (isAbortRequested()) throw new Error("Aborted by user");

  // Step 5b: Translate English → other languages (before the pre-TTS checkpoint)
  const translateLangs = targetLangs.filter(l => l !== "en");
  if (translateLangs.length && !isAbortRequested()) {
    const tT = Date.now();
    await translateAll(stories, translateLangs, log);
    log(`Translation done in ${((Date.now() - tT) / 1000).toFixed(1)}s`);
  }

  if (isAbortRequested()) throw new Error("Aborted by user");

  // Meta
  const estimatedWords       = stories.reduce((n, s) => n + (s.wordCount ?? s.scriptEn.split(/\s+/).length), 0);
  const estimatedDurationSec = Math.round((estimatedWords / WORDS_PER_MINUTE) * 60);
  const sectionSet           = new Set<SectionId>(stories.map(s => s.section));
  const meta: BriefingMeta   = {
    totalStories: stories.length,
    totalArticles: rawStories.length,
    estimatedDurationSec,
    sections: [...SECTION_ORDER].filter(s => sectionSet.has(s)),
  };

  // Save with scripts
  await saveBriefing({ date, generatedAt: new Date().toISOString(), stories, meta, generatedLanguages });
  log(`Pre-TTS checkpoint: ${stories.length} stories saved`);

  // Step 6: TTS
  const t3 = Date.now();
  const { stories: withAudio, costInfo } = await generateAllTTS(
    stories, date, ttsProvider, targetLangs, log,
    async (s) => saveBriefing({ date, generatedAt: new Date().toISOString(), stories: s, meta, generatedLanguages }),
  );
  const ttsSec     = (Date.now() - t3) / 1000;
  const elapsedSec = (Date.now() - runStart) / 1000;

  const runSummary: RunSummary = {
    elapsedSec, fetchSec, clusterSec, scriptSec, ttsSec,
    rawStories: rawStories.length,
    selectedStories: stories.length,
    tts: costInfo,
  };

  const mins = Math.floor(elapsedSec / 60);
  const secs = Math.round(elapsedSec % 60);
  log(`✅ Done in ${mins}m ${secs}s — ${withAudio.length} stories, ~${(estimatedDurationSec / 60).toFixed(1)} min briefing, est. $${costInfo.estimatedUsd.toFixed(3)}`);

  const briefing: DailyBriefing & { runSummary?: RunSummary } = {
    date, generatedAt: new Date().toISOString(),
    stories: withAudio, meta, generatedLanguages, runSummary,
  };

  await saveBriefing(briefing);
  return briefing;
}

// ─── Admin: patch missing sections ────────────────────────────────────────────

export async function generateMissingSections(
  logger: Logger = () => {},
): Promise<{ added: string[]; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };
  const existing = await getLatestBriefing();
  if (!existing) {
    log("No existing briefing — running full generation…");
    const full = await generateDailyBriefing(logger);
    return { added: ["(full generation)"], briefing: full };
  }
  log(`Refreshing: ${existing.stories.length} stories exist — running full regeneration…`);
  const fresh = await generateDailyBriefing(logger, "edge", existing.generatedLanguages ?? ["en"]);
  return { added: ["(full regeneration)"], briefing: fresh };
}

// ─── Admin: patch missing TTS ──────────────────────────────────────────────────

export async function generateMissingTTS(
  logger: Logger = () => {},
  provider: TtsProvider = "edge",
  overrideLangs?: string[],
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };
  const existing = await getLatestBriefing();
  if (!existing) {
    log("No briefing found");
    return { patched: 0, briefing: { date: "", generatedAt: "", stories: [] } };
  }

  const languages = overrideLangs ?? existing.generatedLanguages ?? ["en"];
  const storiesNeedingAudio = existing.stories.filter(s => s.scriptEn && !s.audioUrlEn);
  log(`TTS patch: ${storiesNeedingAudio.length} stories need audio`);

  if (storiesNeedingAudio.length === 0) {
    return { patched: 0, briefing: existing };
  }

  const date = existing.date;
  const { stories: patched, costInfo } = await generateAllTTS(
    storiesNeedingAudio, date, provider, languages, log,
    async (updated) => {
      const allStories = existing.stories.map(s => updated.find(u => u.id === s.id) ?? s);
      await saveBriefing({ ...existing, stories: allStories });
    },
  );

  const allStories = existing.stories.map(s => patched.find(u => u.id === s.id) ?? s);
  const updatedBriefing: DailyBriefing = { ...existing, stories: allStories };
  await saveBriefing(updatedBriefing);

  log(`TTS patch done — ${costInfo.storiesWithAudio} patched`);
  return { patched: costInfo.storiesWithAudio, briefing: updatedBriefing };
}

// ─── Admin: patch scripts ─────────────────────────────────────────────────────

export async function patchScripts(
  logger: Logger = () => {},
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };
  const existing = await getLatestBriefing();
  if (!existing) return { patched: 0, briefing: { date: "", generatedAt: "", stories: [] } };

  const needsScript = existing.stories.filter(s => !isValidScript(s.scriptEn));
  log(`Script patch: ${needsScript.length} stories need rescripting`);
  if (needsScript.length === 0) return { patched: 0, briefing: existing };

  // Re-script as SelectedEvents with no source bodies (best-effort from description only)
  const fakeEvents: SelectedEvent[] = needsScript.map(s => ({
    eventId:         s.id,
    title:           s.title,
    section:         s.section,
    sourceStories:   [s],
    publisherCount:  s.publisherCount ?? 1,
    publishers:      s.publishers ?? [s.source],
    imageUrl:        s.imageUrl,
    firstPublishedAt: s.publishedAt,
    inHeadlinesFeed: false,
    whyImportant:    s.importanceReason ?? "",
  }));

  const rescripted = await scriptAllEvents(fakeEvents, log);
  // Clear translations + audio derived from the OLD (broken) English script —
  // otherwise a patched story ends up with a corrected scriptEn sitting next to
  // a stale Hindi translation of the previous text, and/or stale audio in either
  // language that no longer matches what's on screen. translateAll + TTS will
  // regenerate these fresh on the next pass since scriptHi/audioUrlEn/audioUrlHi
  // are now empty again, same as a brand-new story.
  const allStories = existing.stories.map(s => {
    const patched = rescripted.find(r => r.id === s.id);
    if (!patched) return s;
    return {
      ...s,
      scriptEn: patched.scriptEn,
      wordCount: patched.wordCount,
      scriptHi: "", titleHi: undefined,
      scriptTa: undefined, titleTa: undefined,
      scriptMr: undefined, titleMr: undefined,
      audioUrlEn: undefined, audioUrlHi: undefined,
      audioUrlTa: undefined, audioUrlMr: undefined,
    };
  });

  const updatedBriefing: DailyBriefing = { ...existing, stories: allStories };
  await saveBriefing(updatedBriefing);
  log(`Script patch done — ${rescripted.length} stories rescripted`);
  return { patched: rescripted.length, briefing: updatedBriefing };
}
