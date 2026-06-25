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
import { FEEDS, FEED_MAP, SECTION_ORDER, DEFAULT_CITY, type SectionId } from "./sources";
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
// Override via TARGET_MINUTES env var (default: 25 min → ~63 stories)
const TARGET_MINUTES    = Number(process.env.TARGET_MINUTES ?? 25);
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

// GPT-4o for scripting — narrative quality. Override via OPENAI_SCRIPT_MODEL.
function getScriptModel(): string {
  return process.env.OPENAI_SCRIPT_MODEL ?? "gpt-4o";
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

async function fetchAllFeeds(city: string): Promise<Map<SectionId, RssItem[]>> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const url = feed.buildUrl({ city });
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
 * Dedup articles across all 4 feeds.
 * Processing order: india → world → business → headlines
 * Stories from the headlines feed that match a topical story → inHeadlinesFeed flag set.
 * Stories unique to the headlines feed → section = "headlines".
 */
function buildRawStories(feedMap: Map<SectionId, RssItem[]>): { stories: Story[]; headlineIds: Set<string> } {
  const seenIds    = new Set<string>();
  const seenTitles = new Set<string>();
  const idToIdx    = new Map<string, number>();
  const titleToIdx = new Map<string, number>();
  const stories: Story[] = [];
  const headlineIds = new Set<string>();

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
  for (const feedId of ["india", "world", "business", "local"] as SectionId[]) {
    for (const item of feedMap.get(feedId) ?? []) {
      const id  = storyId(item.link);
      const key = normalize(item.title).slice(0, 60);
      if (!seenIds.has(id) && !seenTitles.has(key)) addStory(item, feedId);
    }
  }

  // Headlines last — mark matches, add unique ones as "headlines" section
  for (const item of feedMap.get("headlines") ?? []) {
    const id  = storyId(item.link);
    const key = normalize(item.title).slice(0, 60);
    if (seenIds.has(id) || seenTitles.has(key)) {
      const idx = idToIdx.get(id) ?? titleToIdx.get(key);
      if (idx != null) headlineIds.add(stories[idx].id);
    } else {
      const idx = addStory(item, "headlines");
      headlineIds.add(stories[idx].id);
    }
  }

  return { stories, headlineIds };
}

// ─── Step 2b: OG image fetching ───────────────────────────────────────────────

const FETCH_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

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
}

async function fetchOgImage(url: string): Promise<string | undefined> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": FETCH_UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-IN,en;q=0.9" },
      redirect: "follow",
    });
    if (!res.ok) return undefined;
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 40_000) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); total += value.byteLength;
    }
    ctrl.abort();
    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => { const a = new Uint8Array(acc.length + c.length); a.set(acc); a.set(c, acc.length); return a; }, new Uint8Array(0))
    );
    return extractOgImage(html);
  } catch { return undefined; } finally { clearTimeout(timer); }
}

async function fetchAllOgImages(stories: Story[], logger: Logger, liveMap?: Map<string, string>): Promise<Story[]> {
  logger(`Fetching OG images for ${stories.length} stories…`);
  const updated = stories.map(s => ({ ...s }));
  const CONCURRENCY = 10;
  for (let i = 0; i < stories.length; i += CONCURRENCY) {
    await Promise.allSettled(
      stories.slice(i, i + CONCURRENCY).map(async (story, j) => {
        const idx = i + j;
        if (updated[idx].imageUrl) { liveMap?.set(story.id, updated[idx].imageUrl!); return; }
        const img = await fetchOgImage(story.link);
        if (img) { updated[idx] = { ...updated[idx], imageUrl: img }; liveMap?.set(story.id, img); }
      }),
    );
  }
  const withImages = updated.filter(s => s.imageUrl).length;
  logger(`OG images: ${withImages}/${stories.length} fetched`);
  return updated;
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

function titlesSimilar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  if (inter < 2) return false; // need at least 2 shared content words
  const union       = a.size + b.size - inter;
  const jaccard     = inter / union;
  const containment = inter / Math.min(a.size, b.size);
  // Same story worded differently → high token overlap, or one title's content
  // words are mostly contained in the other's.
  return jaccard >= 0.5 || containment >= 0.6;
}

function mergeDuplicateEvents(events: SelectedEvent[]): { merged: SelectedEvent[]; removed: number } {
  const kept: SelectedEvent[] = [];
  const keptTokens: Set<string>[] = [];
  let removed = 0;

  for (const ev of events) {
    const toks = titleTokens(ev.title);
    let target = -1;
    for (let i = 0; i < kept.length; i++) {
      if (titlesSimilar(toks, keptTokens[i])) { target = i; break; }
    }
    if (target >= 0) {
      const k = kept[target];
      const seen = new Set(k.sourceStories.map(s => s.id));
      for (const s of ev.sourceStories) if (!seen.has(s.id)) k.sourceStories.push(s);
      k.publishers      = [...new Set(k.sourceStories.map(s => s.source))];
      k.publisherCount  = k.publishers.length;
      if (!k.imageUrl) k.imageUrl = ev.imageUrl;
      k.inHeadlinesFeed = k.inHeadlinesFeed || ev.inHeadlinesFeed;
      if (!k.whyImportant && ev.whyImportant) k.whyImportant = ev.whyImportant;
      // Accumulate tokens so later variants of the same story still match the cluster
      for (const w of toks) keptTokens[target].add(w);
      removed++;
    } else {
      kept.push(ev);
      keptTokens.push(toks);
    }
  }
  return { merged: kept, removed };
}

// ─── Step 4: Cluster same-event articles (single AI call) ────────────────────

async function clusterAndSelect(
  stories: Story[],
  headlineIds: Set<string>,
  maxStories: number,
  logger: Logger,
): Promise<SelectedEvent[]> {
  const articleList = stories.map((s, i) =>
    `${i}. [${s.source}]${headlineIds.has(s.id) ? " ★" : ""} [${s.section}] ${s.title}`
  ).join("\n");

  // Per-section soft cap: at most ~60% of total from any one section
  const perSectionCap = Math.ceil(maxStories * 0.6);

  const prompt = `You are the news editor for Khabar AI — India's top audio news briefing.

Here are ${stories.length} articles from today's Google News feeds (India, World, Business, Local, Headlines).
★ = appeared on Google's homepage — stronger editorial signal.

TASK:
1. Group every article about the same underlying event into ONE cluster — even when the headlines are worded differently or come from different publishers. Be aggressive about merging: if two headlines describe the same ruling, announcement, incident, or statement, they are the SAME event and must share one cluster. Put every article index covering that event in its sourceIndices.
2. Cover as many genuinely DISTINCT events as possible — up to ${maxStories}. Include every unique story, but never list the same event twice.
3. Order from most to least important.
4. Balance sections — aim for at least 4 events per section where news exists; no single section should exceed ${perSectionCap} events.

IMPORTANCE GUIDE (order by this):
- Major: Parliament/Cabinet decisions, elections, RBI/budget/market moves, India-Pakistan/China, Supreme Court, major disasters
- Medium: International events affecting India, corporate/economic policy, state-level governance
- Lower: Routine updates, niche stories, individual match results (unless major tournament)
- ★ stories get a +1 importance boost in ordering

Return a JSON object with a single key "events":
{"events": [
  {
    "title": "specific, factual event title — max 10 words",
    "section": "headlines|india|world|business|local",
    "sourceIndices": [0, 4, 12],
    "imageIndex": 0,
    "whyImportant": "one sentence — the key reason this matters"
  }
]}

RULES:
- Return exactly ${maxStories} events (or fewer if total distinct events is less)
- Every index used in sourceIndices must be in range 0–${stories.length - 1}
- section: assign based on content — "headlines" for major cross-cutting stories, "local" for city/regional news, else india/world/business
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

    const section  = (["headlines", "india", "world", "business", "local"].includes(g.section)
      ? g.section : stories[indices[0]].section) as SectionId;

    const imageIdx      = (g.imageIndex != null && indices.includes(g.imageIndex)) ? g.imageIndex : indices[0];
    const publishers    = [...new Set(indices.map((i: number) => stories[i].source))] as string[];
    const dates         = indices.map((i: number) => stories[i].publishedAt).sort();
    const imageUrl      = stories[imageIdx]?.imageUrl ?? indices.map((i: number) => stories[i].imageUrl).find(Boolean);
    const sourceStories = indices.map((i: number) => stories[i]);
    const inHeadlines   = sourceStories.some(s => headlineIds.has(s.id));

    events.push({
      eventId:         storyId(stories[imageIdx]?.link ?? stories[indices[0]].link),
      title,
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

  // Deterministic near-duplicate merge (safety net for missed clustering)
  const { merged, removed } = mergeDuplicateEvents(events);
  if (removed > 0) logger(`Merged ${removed} near-duplicate event(s) by title overlap`);

  // Hard cap — keep the most important after de-duping
  const capped = merged.slice(0, maxStories);
  logger(`Clustered into ${capped.length} events (target: ${maxStories}, ~${Math.round(capped.length * WORDS_PER_STORY / WORDS_PER_MINUTE)} min)`);
  return capped;
}

// ─── Step 5: Script generation ────────────────────────────────────────────────

function isValidScript(text: string | undefined): boolean {
  if (!text || text.trim().length < 10) return false;
  if (text.trim().split(/\s+/).length < 25) return false;
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

  const sectionLabel = ev.section === "headlines" ? "Top Stories"
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

STORY: ${ev.title}
SECTION: ${sectionLabel}
SOURCES (${ev.publisherCount} publisher${ev.publisherCount !== 1 ? "s" : ""}${ev.inHeadlinesFeed ? ", ★ on Google homepage" : ""}):
${sourcesText}

STRUCTURE (very short):
- Sentence 1: the headline fact — what happened, with the concrete specifics (who/what/when/where)
- Sentence 2-3: the remaining key facts or numbers straight from the sources, then stop

VOICE & STYLE:
- Plain, factual, neutral — like a newsreader, not a columnist
- Active voice throughout
- Use the real numbers, names, dates and places from the sources; nothing vague
- State facts directly; do not characterize them as good, bad, surprising, or important

HARD RULES:
- FORBIDDEN openers: "Today", "In a significant development", "According to", "A new", "The", "In what"
- FORBIDDEN endings: "Stay tuned", "Watch this space", "Keep an eye on", any tease or CTA
- FORBIDDEN: interpretation, analysis, predictions, or editorializing — facts only
- FORBIDDEN words: "reportedly", "sources say", "it is said", "stakeholders", "signals", "could mean", "experts say", "analysts"
- NO demographic mentions: "Indians", "citizens", "the public", "people"
- NO bullet points, no parentheses, no lists
- NEVER invent facts — only use what is in the sources

Return ONLY valid JSON: {"title": "...", "scriptEn": "..."}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await aiJson(prompt, getScriptModel(), 4096);
      const title    = (raw.title    || ev.title).trim();
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

async function synthesizeOne(text: string, filename: string, provider: TtsProvider): Promise<string> {
  if (provider === "google")     { const { url } = await googleTTS(text, filename);    return url; }
  if (provider === "elevenlabs") { const { url } = await elevenLabsTTS(text, filename); return url; }
  if (provider === "edge")       { const { url } = await edgeTTS(text, filename);       return url; }
  if (provider === "kokoro")     { const { url } = await kokoroTTS(text, filename);     return url; }
  if (provider === "openai")     { const { url } = await openaiTTS(text, filename);     return url; }
  throw new Error(`Unknown TTS provider: ${provider}`);
}

async function generateAllTTS(
  stories: Story[],
  date: string,
  provider: TtsProvider,
  logger: Logger,
  onProgress?: (stories: Story[]) => Promise<void>,
): Promise<{ stories: Story[]; costInfo: TtsCostInfo }> {
  logger(`TTS (${provider}): ${stories.length} stories, English`);
  const updated = stories.map(s => ({ ...s }));
  let totalChars = 0;
  let storiesWithAudio = 0;

  // 5 concurrent for TTS — Edge has no rate limit; others are conservative
  const ttsLimit = makeConcurrencyLimiter(5);

  // Serialize checkpoint saves so concurrent TTS tasks don't interleave the
  // read-modify-write in saveBriefing (lost updates / corrupt JSON in LOCAL_MODE).
  const saveQueue = makeSerializer();
  const safeProgress = onProgress
    ? (s: Story[]) => saveQueue(() => onProgress(s))
    : undefined;

  await Promise.all(
    stories.map((story, i) =>
      ttsLimit(async () => {
        if (isAbortRequested()) return;
        if (provider === "google"     && isDailyQuotaExhausted()) return;
        if (provider === "elevenlabs" && isQuotaExhausted())      return;

        const script = story.scriptEn;
        if (!script) return;

        try {
          const url = await synthesizeOne(script, `${date}-${story.id}-en`, provider);
          updated[i] = { ...updated[i], audioUrlEn: url, audioStartSec: 0 };
          totalChars += script.length;
          storiesWithAudio++;
          logger(`  ✓ [${i + 1}/${stories.length}] ${story.title.slice(0, 55)}`);
        } catch (err: any) {
          logger(`  ✗ [${i + 1}/${stories.length}]: ${err.message?.slice(0, 60)}`);
        }

        if (safeProgress) await safeProgress([...updated]);
      }),
    ),
  );

  const estimatedUsd =
    provider === "elevenlabs" ? (totalChars / 1000) * 0.08 :
    provider === "google"     ? (totalChars / 1_000_000) * 0.50 : 0;

  logger(`TTS done: ${storiesWithAudio}/${stories.length} stories, est. $${estimatedUsd.toFixed(3)}`);
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
    headlines: "headlines", india: "india", world: "world", business: "business", local: "local",
    // old taxonomy → nearest new section
    politics: "india",
    sports: "india", techlife: "india", technology: "india",
    entertainment: "india", science: "india", health: "india",
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
  city: string = DEFAULT_CITY,
  ttsProvider: TtsProvider = "edge",
  languages: string[] = ["en"],
): Promise<DailyBriefing & { runSummary?: RunSummary }> {
  const runStart = Date.now();
  const date     = new Date().toISOString().slice(0, 10);
  const log      = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing v5 — ${date} | city: ${city} | TTS: ${ttsProvider}`);

  // v5 generates English audio only. Report exactly what's produced so the app
  // never advertises a language that has no scripts or audio behind it.
  const extraLangs = languages.filter(l => l !== "en");
  if (extraLangs.length) {
    log(`Note: v5 generates English only — ignoring requested language(s): ${extraLangs.join(", ")}`);
  }
  const generatedLanguages = ["en"];

  // Step 1: Fetch
  const t0 = Date.now();
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap  = await fetchAllFeeds(city);
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (isAbortRequested()) throw new Error("Aborted by user");

  // Step 2: Dedup
  const { stories: rawStories, headlineIds } = buildRawStories(feedMap);
  log(`After dedup: ${rawStories.length} unique articles (${headlineIds.size} on Google homepage)`);
  for (const [sectionId, config] of FEED_MAP) {
    const n = rawStories.filter(s => s.section === sectionId).length;
    if (n > 0) log(`  ${config.emoji} ${config.label}: ${n}`);
  }
  const fetchSec = (Date.now() - t0) / 1000;

  // Steps 2b + 4 in parallel: OG images + cluster
  const t1 = Date.now();
  const liveImageById = new Map<string, string>();
  const [withImages, selectedEvents] = await Promise.all([
    fetchAllOgImages(rawStories, log, liveImageById),
    clusterAndSelect(rawStories, headlineIds, MAX_STORIES, log),
  ]);
  const clusterSec = (Date.now() - t1) / 1000;

  // Merge OG images into events
  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  for (const ev of selectedEvents) {
    if (!ev.imageUrl) ev.imageUrl = ev.sourceStories.map(s => imageById.get(s.id)).find(Boolean);
  }

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
    stories, date, ttsProvider, log,
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
  city = DEFAULT_CITY,
): Promise<{ added: string[]; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };
  const existing = await getLatestBriefing();
  if (!existing) {
    log("No existing briefing — running full generation…");
    const full = await generateDailyBriefing(logger, city);
    return { added: ["(full generation)"], briefing: full };
  }
  log(`Refreshing: ${existing.stories.length} stories exist — running full regeneration…`);
  const fresh = await generateDailyBriefing(logger, city, "edge", existing.generatedLanguages ?? ["en"]);
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
    storiesNeedingAudio, date, provider, log,
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
  const allStories = existing.stories.map(s => {
    const patched = rescripted.find(r => r.id === s.id);
    return patched ? { ...s, scriptEn: patched.scriptEn, wordCount: patched.wordCount } : s;
  });

  const updatedBriefing: DailyBriefing = { ...existing, stories: allStories };
  await saveBriefing(updatedBriefing);
  log(`Script patch done — ${rescripted.length} stories rescripted`);
  return { patched: rescripted.length, briefing: updatedBriefing };
}
