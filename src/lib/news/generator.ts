/**
 * Khabar AI Briefing Generator — v4
 *
 * Pipeline:
 *  1. Fetch all Google News RSS feeds in parallel
 *  2. URL/title dedup → flat raw stories
 *  3. OG image fetching [parallel with step 4]
 *  4. Gemini clustering: group same-event articles per section → ClusteredEvents
 *  5. Batch importance scoring: one Gemini call, all events compared + mustInclude flags
 *  6. mustInclude events (PM, disasters, RBI, etc.) flagged by AI — no hardcoded patterns
 *  7. Briefing plan: slot-based selection → 16-20 stories across sections
 *  8. Script generation: 130-160 word Hook/What/Why/Next per selected event
 *  9. Briefing wrapper: static opening + LLM transitions + static closing
 * 10. TTS: per story + per segment, 4 languages (EN/HI/TA/MR) via ElevenLabs
 * 11. Save DailyBriefing with stories[], segments[], meta{} to Supabase Storage
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRss, type RssItem } from "./rss";
import { FEEDS, FEED_MAP, DEFAULT_CITY, type SectionId } from "./sources";
import { elevenLabsTTS, isQuotaExhausted } from "@/lib/tts/elevenlabs";
import { googleTTS, isDailyQuotaExhausted } from "@/lib/tts/google";
import { edgeTTS } from "@/lib/tts/edge";
import { kokoroTTS } from "@/lib/tts/kokoro";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";
import { isAbortRequested } from "@/lib/abort";

export type TtsProvider = "google" | "elevenlabs" | "edge" | "kokoro";

const LOCAL_MODE = process.env.LOCAL_MODE === "true";

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
  scriptHi: string;
  scriptTa?: string;
  scriptMr?: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
  audioUrlTa?: string;
  audioUrlMr?: string;
  audioStartSec?: number;
  // v4 additions
  importanceScore?: number;
  importanceReason?: string;
  forcedByEditorial?: boolean;
  wordCount?: number;
  publisherCount?: number;
  publishers?: string[];
  // roundup
  isRoundup?: boolean;
  roundupItems?: { title: string; titleHi?: string; titleTa?: string; titleMr?: string }[];
};

/** A non-story audio segment: opening, section transition, or closing. */
export type BriefingSegment = {
  id: string;
  type: "opening" | "transition" | "closing";
  /** For transitions: the section that starts AFTER this segment plays. */
  section?: SectionId;
  scriptEn: string;
  scriptHi: string;
  scriptTa?: string;
  scriptMr?: string;
  audioUrlEn?: string;
  audioUrlHi?: string;
  audioUrlTa?: string;
  audioUrlMr?: string;
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
  scoreSec: number;
  scriptSec: number;
  ttsSec: number;
  rawStories: number;
  clusteredEvents: number;
  selectedStories: number;
  tts: TtsCostInfo;
};

export type TtsCostInfo = {
  provider: TtsProvider;
  enChars: number;
  hiChars: number;
  taChars: number;
  mrChars: number;
  totalChars: number;
  estimatedUsd: number;
  storiesAttempted: number;
  storiesWithAudio: number;
};

// ─── Internal type: event after clustering, before scripting ──────────────────

type ClusteredEvent = {
  eventId: string;
  canonicalTitle: string;
  section: SectionId;          // source section from RSS feed
  assignedSection: SectionId;  // final section in briefing (may differ)
  sourceStories: Story[];      // all raw stories merged into this event
  publisherCount: number;
  publishers: string[];
  imageUrl?: string;
  firstPublishedAt: string;
  importanceScore: number;
  importanceReason: string;
  forcedByEditorial: boolean;
  inHeadlinesFeed: boolean;    // appeared on Google News homepage/top feed
  roundupGroup?: ClusteredEvent[]; // set when this is a synthetic roundup placeholder
};

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_WPM = 150;

// No roundup clubbing — every story gets its own full script.
const ROUNDUP_SECTIONS = new Set<SectionId>([]);

// Score threshold — lowered to let more stories through.
// Full day coverage is the goal; score is a deprioritisation tool, not a gate.
const MIN_SCORE_THRESHOLD = 2.5;
// Hard safety valve only.
const MAX_TOTAL_STORIES   = 60;

// Guaranteed minimum slots per section — backfilled even if score < threshold.
const MIN_SECTION_SLOTS: Partial<Record<SectionId, number>> = {
  india:         5,
  business:      3,
  world:         3,
  sports:        2,
  health:        2,
  technology:    2,
  entertainment: 1,
  science:       1,
  local:         1,
};

const SECTION_ORDER: SectionId[] = [
  "india", "world", "business", "technology", "sports",
  "health", "entertainment", "science", "local",
];

// ─── Gemini helpers ───────────────────────────────────────────────────────────

// gemini-2.0-flash: stable GA model, far fewer 503 demand spikes than 2.5-flash.
// Plenty capable for clustering, scoring, and scripting.
const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

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

const RETRYABLE_STATUSES   = new Set([429, 500, 502, 503, 504]);
const GEMINI_MAX_RETRIES   = 4;   // 503 demand spikes need patience — up to 4 retries
const GEMINI_MAX_TIMEOUTS  = 2;
const GEMINI_BASE_DELAY_MS = 20_000; // 20s → 40s → 80s → 160s exponential backoff

// Global flag: set when daily quota is detected — all subsequent calls skip immediately.
let _geminiDailyQuotaExhausted = false;
function isGeminiDailyQuota(body: string): boolean {
  return body.includes("per_day") || body.includes("DAILY") || body.includes("per_model_per_day");
}
const GEMINI_TIMEOUT_MS    = 90_000;

/** Simple concurrency limiter — caps simultaneous Gemini calls to avoid 429 bursts. */
function makeConcurrencyLimiter(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return async function<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>(res => queue.push(res));
    running++;
    try { return await fn(); }
    finally {
      running--;
      queue.shift()?.();
    }
  };
}
const geminiLimit = makeConcurrencyLimiter(1); // sequential — prevents burst 429s

async function geminiJson(prompt: string, maxOutputTokens = 8192): Promise<any> {
  return geminiLimit(async () => {
  if (_geminiDailyQuotaExhausted) throw new Error("Gemini daily quota exhausted");
  let lastError: Error | null = null;
  let timeouts = 0;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = GEMINI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[gemini] retry ${attempt}/${GEMINI_MAX_RETRIES} after ${delayMs / 1000}s`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    const ctrl  = new AbortController();
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
        if (res.status === 429 && isGeminiDailyQuota(body)) {
          _geminiDailyQuotaExhausted = true;
          console.error("[gemini] Daily quota exhausted — aborting all Gemini calls");
          throw lastError; // no point retrying
        }
        if (RETRYABLE_STATUSES.has(res.status)) {
          const nextDelay = GEMINI_BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[gemini] ${res.status} — will retry in ${nextDelay / 1000}s (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES})`);
          continue;
        }
        throw lastError;
      }

      const json = await res.json();
      const parts: any[] = json.candidates?.[0]?.content?.parts ?? [];
      const text = parts.find((p: any) => p.text && !p.thought)?.text
        ?? parts.find((p: any) => p.text)?.text
        ?? "[]";
      return parseGeminiJson(text);
    } catch (err: any) {
      if (err.name === "AbortError") {
        timeouts++;
        lastError = new Error(`Gemini timed out (${timeouts}/${GEMINI_MAX_TIMEOUTS + 1})`);
        if (timeouts > GEMINI_MAX_TIMEOUTS) throw lastError;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Gemini request failed after retries");
  }); // geminiLimit
}

// ─── Language metadata ────────────────────────────────────────────────────────

const LANG_META: Record<string, { name: string; scriptNote: string; example: string }> = {
  hi: {
    name:       "Hindi",
    scriptNote: "MUST use Devanagari script. NEVER Roman/English letters for Hindi words.",
    example:    "भारत में इस हफ्ते तकनीक क्षेत्र में बड़ा बदलाव आया।",
  },
  ta: {
    name:       "Tamil",
    scriptNote: "MUST use Tamil script. NEVER Roman/English letters for Tamil words.",
    example:    "இந்தியாவில் இந்த வாரம் தொழில்நுட்பத்தில் பெரிய மாற்றம் ஏற்பட்டது.",
  },
  mr: {
    name:       "Marathi",
    scriptNote: "MUST use Devanagari script. NEVER Roman/English letters for Marathi words.",
    example:    "भारतात या आठवड्यात तंत्रज्ञान क्षेत्रात मोठा बदल झाला.",
  },
};

const SCRIPT_RE: Record<string, RegExp> = {
  hi: /[ऀ-ॿ]/,
  mr: /[ऀ-ॿ]/,
  ta: /[஀-௿]/,
};

function hasExpectedScript(text: string | undefined, lang: string): boolean {
  if (!text || text.trim().length < 3) return false;
  const re = SCRIPT_RE[lang];
  return re ? re.test(text) : true;
}

// ─── Step 1: Fetch all feeds ──────────────────────────────────────────────────

async function fetchAllFeeds(city: string): Promise<Map<SectionId, RssItem[]>> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const url = feed.buildUrl({ city });
      let items = await fetchRss(url, feed.label, feed.id);
      if (items.length === 0 && feed.fallbackUrl) {
        console.warn(`[feeds] ${feed.label}: topic URL returned 0 — trying fallback`);
        items = await fetchRss(feed.fallbackUrl, feed.label, feed.id);
      }
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

// ─── Step 2: Build raw stories (dedup) ───────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function storyId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function buildRawStories(feedMap: Map<SectionId, RssItem[]>): Story[] {
  const seenIds    = new Set<string>();
  const seenTitles = new Set<string>();
  const stories: Story[] = [];

  // Process section feeds before headlines so section metadata is preserved
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

// ─── Step 2b: OG image fetching ───────────────────────────────────────────────

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

const FETCH_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

async function fetchOgImage(url: string): Promise<string | undefined> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":      FETCH_UA,
        "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
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
      chunks.push(value);
      total += value.byteLength;
    }
    ctrl.abort();
    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const a = new Uint8Array(acc.length + c.length);
        a.set(acc); a.set(c, acc.length); return a;
      }, new Uint8Array(0))
    );
    return extractOgImage(html);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllOgImages(
  stories: Story[],
  logger: Logger,
  liveMap?: Map<string, string>,
): Promise<Story[]> {
  logger(`Fetching OG images for ${stories.length} stories…`);
  const updated     = stories.map((s) => ({ ...s }));
  const CONCURRENCY = 10;

  for (let i = 0; i < stories.length; i += CONCURRENCY) {
    const slice = stories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      slice.map(async (story, j) => {
        const idx = i + j;
        if (updated[idx].imageUrl) {
          liveMap?.set(story.id, updated[idx].imageUrl!);
          return;
        }
        const img = await fetchOgImage(story.link);
        if (img) {
          updated[idx] = { ...updated[idx], imageUrl: img };
          liveMap?.set(story.id, img);
        }
      }),
    );
  }

  const withImages = updated.filter((s) => s.imageUrl).length;
  logger(`OG images: ${withImages}/${stories.length} fetched`);
  return updated;
}

// ─── Step 4: Cluster articles into events (per section, no scripts) ───────────

interface ClusterGroup {
  canonicalTitle: string;
  sourceIndices:  number[];
  imageIndex?:    number;
}

const CLUSTER_CHUNK_SIZE = 30; // max articles per Gemini clustering call (TPM budget)

async function clusterSectionChunk(
  sectionStories: Story[],
  sectionId: SectionId,
  indexOffset: number,
): Promise<ClusterGroup[]> {
  const label       = FEED_MAP.get(sectionId)?.label ?? sectionId;
  const isHeadlines = sectionId === "headlines";
  void isHeadlines; // used downstream

  const prompt = `You are a news editor. These ${sectionStories.length} articles are from the "${label}" section.

Group articles that cover EXACTLY the same event or announcement.
Different stories — even if loosely related — MUST stay in separate groups.
When in doubt, keep separate.

Return JSON array only:
[{"canonicalTitle":"concise event title (max 12 words)","sourceIndices":[0,2],"imageIndex":0}]

Rules:
- Every index 0-${sectionStories.length - 1} must appear in exactly one group
- canonicalTitle: specific and factual, state the event clearly
- imageIndex: which sourceIndex is most likely to have an image (prefer Reuters, AP, PTI, AFP)

Articles:
${sectionStories.map((s, i) => `${i}. [${s.source}] ${s.title}`).join("\n")}`;

  const groups: ClusterGroup[] = await geminiJson(prompt);
  if (!Array.isArray(groups) || groups.length === 0) throw new Error("empty result");

  // Remap indices to global offset
  return groups.map(g => ({
    ...g,
    sourceIndices: (g.sourceIndices ?? []).map(i => i + indexOffset),
    imageIndex:    g.imageIndex != null ? g.imageIndex + indexOffset : undefined,
  }));
}

async function clusterSection(
  sectionStories: Story[],
  sectionId: SectionId,
  logger: Logger,
): Promise<ClusteredEvent[]> {
  if (sectionStories.length === 0) return [];

  const label       = FEED_MAP.get(sectionId)?.label ?? sectionId;
  const isHeadlines = sectionId === "headlines";

  // Split into chunks to stay within TPM limits — large sections (India 104, Local 101) would
  // otherwise send 5000+ token prompts that hit Gemini's tokens-per-minute quota.
  let allGroups: ClusterGroup[];
  if (sectionStories.length <= CLUSTER_CHUNK_SIZE) {
    const prompt = `You are a news editor. These ${sectionStories.length} articles are from the "${label}" section.

Group articles that cover EXACTLY the same event or announcement.
Different stories — even if loosely related — MUST stay in separate groups.
When in doubt, keep separate.

Return JSON array only:
[{"canonicalTitle":"concise event title (max 12 words)","sourceIndices":[0,2],"imageIndex":0}]

Rules:
- Every index 0-${sectionStories.length - 1} must appear in exactly one group
- canonicalTitle: specific and factual, state the event clearly
- imageIndex: which sourceIndex is most likely to have an image (prefer Reuters, AP, PTI, AFP)

Articles:
${sectionStories.map((s, i) => `${i}. [${s.source}] ${s.title}`).join("\n")}`;

    try {
      const groups: ClusterGroup[] = await geminiJson(prompt);
      if (!Array.isArray(groups) || groups.length === 0) throw new Error("empty result");
      allGroups = groups;
    } catch (err: any) {
      logger(`  ✗ cluster ${sectionId}: ${err.message?.slice(0, 80)} — each article = 1 event`);
      return sectionStories.map(s => soloEvent(s, sectionId, isHeadlines));
    }
  } else {
    // Chunked clustering — split large sections to stay within TPM limits
    const chunks: Story[][] = [];
    for (let i = 0; i < sectionStories.length; i += CLUSTER_CHUNK_SIZE) {
      chunks.push(sectionStories.slice(i, i + CLUSTER_CHUNK_SIZE));
    }
    logger(`    ↳ ${sectionId}: ${sectionStories.length} articles → ${chunks.length} chunks of ≤${CLUSTER_CHUNK_SIZE}`);
    allGroups = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const offset = ci * CLUSTER_CHUNK_SIZE;
      try {
        const chunkGroups = await clusterSectionChunk(chunks[ci], sectionId, offset);
        allGroups.push(...chunkGroups);
      } catch (err: any) {
        logger(`  ✗ cluster ${sectionId} chunk ${ci}: ${err.message?.slice(0, 200)} — soloing chunk`);
        // Solo-event fallback for this chunk only
        for (const s of chunks[ci]) allGroups.push({ canonicalTitle: s.title, sourceIndices: [sectionStories.indexOf(s)] });
      }
    }
  }

  // Build ClusteredEvent objects from groups (same logic for both paths)
  const covered       = new Set<number>();
  const emittedTitles = new Set<string>();
  const events: ClusteredEvent[] = [];

  for (const g of allGroups) {
    const indices = (g.sourceIndices ?? []).filter(i => i >= 0 && i < sectionStories.length);
    if (indices.length === 0) continue;
    indices.forEach(i => covered.add(i));

    const title = (g.canonicalTitle ?? "").trim();
    if (!title || emittedTitles.has(title)) continue;
    emittedTitles.add(title);

    const imageIdx      = g.imageIndex != null && indices.includes(g.imageIndex) ? g.imageIndex : indices[0];
    const primaryUrl    = sectionStories[imageIdx]?.link ?? sectionStories[indices[0]].link;
    const publishers    = [...new Set(indices.map(i => sectionStories[i].source))];
    const dates         = indices.map(i => sectionStories[i].publishedAt).sort();
    const imageUrl      = indices.map(i => sectionStories[i].imageUrl).find(Boolean);
    const sourceStories = indices.map(i => sectionStories[i]);

    const nonHeadlineSection = sourceStories
      .map(s => s.section)
      .find(s => s !== "headlines") ?? "india";

    events.push({
      eventId:           storyId(primaryUrl),
      canonicalTitle:    title,
      section:           isHeadlines ? nonHeadlineSection : sectionId,
      assignedSection:   isHeadlines ? nonHeadlineSection : sectionId,
      sourceStories,
      publisherCount:    publishers.length,
      publishers,
      imageUrl,
      firstPublishedAt:  dates[0] ?? new Date().toISOString(),
      importanceScore:   0,
      importanceReason:  "",
      forcedByEditorial: false,
      inHeadlinesFeed:   isHeadlines || sourceStories.some(s => s.section === "headlines"),
    });
  }

  // Uncovered stories → solo events
  for (let i = 0; i < sectionStories.length; i++) {
    if (!covered.has(i)) events.push(soloEvent(sectionStories[i], sectionId, isHeadlines));
  }

  return events;
}

function soloEvent(s: Story, sectionId: SectionId, isHeadlines: boolean): ClusteredEvent {
  const nonHLSection = s.section !== "headlines" ? s.section : "india";
  return {
    eventId:           s.id,
    canonicalTitle:    s.title.replace(/\s*[-–|]\s*[^-–|]{1,40}$/, "").trim(),
    section:           isHeadlines ? nonHLSection : sectionId,
    assignedSection:   isHeadlines ? nonHLSection : sectionId,
    sourceStories:     [s],
    publisherCount:    1,
    publishers:        [s.source],
    imageUrl:          s.imageUrl,
    firstPublishedAt:  s.publishedAt,
    importanceScore:   0,
    importanceReason:  "",
    forcedByEditorial: false,
    inHeadlinesFeed:   isHeadlines,
  };
}

/** Deduplicate clustered events across sections by title token overlap. */
function dedupeEvents(events: ClusteredEvent[]): ClusteredEvent[] {
  function tokenize(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(t => t.length > 2);
  }
  function overlap(a: string[], b: string[]): number {
    const sb = new Set(b);
    return a.filter(t => sb.has(t)).length / Math.max(a.length, b.length, 1);
  }

  const kept: { event: ClusteredEvent; tokens: string[] }[] = [];
  for (const ev of events) {
    const toks  = tokenize(ev.canonicalTitle);
    const isDup = kept.some(k => overlap(toks, k.tokens) >= 0.55);
    if (!isDup) kept.push({ event: ev, tokens: toks });
  }
  return kept.map(k => k.event);
}

async function clusterAllSections(
  rawStories: Story[],
  logger: Logger,
): Promise<ClusteredEvent[]> {
  const bySection = new Map<SectionId, Story[]>();
  for (const s of rawStories) {
    const arr = bySection.get(s.section) ?? [];
    arr.push(s);
    bySection.set(s.section, arr);
  }

  logger(`Clustering ${rawStories.length} stories across ${bySection.size} sections (sequential)…`);

  // Process sections sequentially to avoid burst rate limiting.
  // All chunks within a section are already sequential via the concurrency limiter.
  const allEvents: ClusteredEvent[] = [];
  for (const [sectionId, stories] of bySection.entries()) {
    const emoji = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    logger(`  ${emoji} ${sectionId}: ${stories.length} articles…`);
    try {
      const events = await clusterSection(stories, sectionId, logger);
      logger(`    → ${events.length} events (${sectionId})`);
      allEvents.push(...events);
    } catch (err: any) {
      logger(`  ✗ ${sectionId} section failed: ${err.message?.slice(0, 80)}`);
    }
  }

  const deduped = dedupeEvents(allEvents);
  logger(`Clustering complete — ${allEvents.length} raw events → ${deduped.length} after cross-section dedup`);
  return deduped;
}

// ─── Step 4b: Pre-filter events before scoring ────────────────────────────────
// Scoring sends all events in one Gemini call. 400+ events exceeds the JSON
// output token limit (~8K tokens = ~150 events max). Pre-filter to ~120 by:
//   • Always keeping multi-publisher events (≥2 sources = genuinely covered)
//   • Always keeping events that appeared on the Headlines feed
//   • For solo-publisher events, keeping the N most recent per section

const SOLO_KEEP_PER_SECTION: Partial<Record<SectionId, number>> = {
  india:         12,
  business:      10,
  world:          8,
  technology:     8,
  sports:         6,
  health:         5,
  entertainment:  4,
  science:        4,
  local:          5,
};

function preFilterForScoring(events: ClusteredEvent[], logger: Logger): ClusteredEvent[] {
  const alwaysKeep    = events.filter(ev => ev.publisherCount >= 2 || ev.inHeadlinesFeed);
  const alwaysKeepIds = new Set(alwaysKeep.map(e => e.eventId));

  const bySection = new Map<SectionId, ClusteredEvent[]>();
  for (const ev of events) {
    if (alwaysKeepIds.has(ev.eventId)) continue;
    const arr = bySection.get(ev.section) ?? [];
    arr.push(ev);
    bySection.set(ev.section, arr);
  }

  const soloKept: ClusteredEvent[] = [];
  for (const [sectionId, sectionEvents] of bySection) {
    const limit  = SOLO_KEEP_PER_SECTION[sectionId] ?? 5;
    const sorted = [...sectionEvents].sort((a, b) =>
      new Date(b.firstPublishedAt).getTime() - new Date(a.firstPublishedAt).getTime()
    );
    soloKept.push(...sorted.slice(0, limit));
  }

  const filtered = [...alwaysKeep, ...soloKept];
  if (filtered.length < events.length) {
    logger(`Pre-filter: ${events.length} events → ${filtered.length} kept for scoring`);
  }
  return filtered;
}

// ─── Step 5: Batch importance scoring ─────────────────────────────────────────

function scoringPrompt(events: ClusteredEvent[]): string {
  const eventList = events.map((ev, i) =>
    `${i}. [${ev.section}] [${ev.publisherCount}pub] ${ev.canonicalTitle}` +
    (ev.inHeadlinesFeed ? " ★" : "")
  ).join("\n");

  return `You are Khabar AI's editorial director. Your audience is retired Indians aged 60+, living in tier-1 and tier-2 cities. They are educated, politically aware, and deeply interested in how governance, policy, and the economy affect their daily lives and their children's futures. They follow cricket. They care about health. They are not interested in startup funding rounds, celebrity gossip, or gadget launches unless these have clear national significance.

Score each news event 0-10 by importance to THIS audience.

SCORING GUIDE:
10 = Directly and immediately affects their lives (budget, election result, major disaster, health emergency)
8-9 = Major national event they will want to discuss with family today
6-7 = Significant governance, policy, or civic news an informed citizen should know
4-5 = Relevant but not urgent — worth mentioning
2-3 = Niche, regional with limited impact, or low-stakes
0-1 = Celebrity gossip, product launches, startup funding — no civic significance

TOPICS THAT SCORE HIGHER for this audience (all else equal):
• National & state politics: Parliament sessions, CM decisions, party developments, by-elections
• Economic policy: inflation, petrol/LPG prices, gold rates, FD/savings rates, pension schemes, stock market moves
• Business & markets: RBI decisions, banking news, major corporate events affecting Indian households
• Governance & welfare: government schemes, subsidies, Aadhaar, ration policy, senior citizen benefits
• Judiciary: Supreme Court and High Court judgments on property, rights, civil matters
• India's foreign relations: Pakistan, China, USA, trade deals, NRI policy, diaspora
• Infrastructure: roads, railways, airports affecting daily life
• ISRO and national science achievements
• Cricket — any format, any match result, team selection, controversies
• Sports — Indian athletes at major international events (Olympics, World Cup, Asian Games)
• Major religious or cultural events of national significance

HEALTH SCORING — be precise:
• Score 7-9: disease outbreaks (dengue surge, new Covid variant), medicine price hikes, hospital policy, senior health schemes, AIIMS announcements
• Score 4-6: general health advisories that are timely and actionable (e.g. heatwave precautions in summer)
• Score 1-3: routine wellness tips, diet advice, generic study findings with no immediate impact — these are low priority

TOPICS THAT SCORE LOWER for this audience:
• Startup funding, VC investments, unicorn valuations
• Gadget launches, app updates, social media trends
• Celebrity birthdays, film releases, OTT content
• Academic conference findings with no immediate application

★ = Appeared on Google News homepage (add 0.5 bonus)

Compare events against each other — scores must reflect relative importance to this specific audience.

MANDATORY COVERAGE — set mustInclude: true regardless of score:
• Any decision, statement, or action by the PM, Cabinet, or President of India
• Supreme Court judgments affecting public life
• Union Budget announcements or major fiscal policy
• Natural disasters with casualties (earthquake, cyclone, major floods)
• Terror attacks or major security incidents in India or involving Indians
• RBI policy decisions (repo rate, monetary policy committee)
• National or state election results
• Major airline crashes or industrial disasters
• Pandemic or health emergency declarations
• Any event affecting pension, PF, or senior citizen schemes
Use your judgment — when in doubt, set mustInclude: false and let the score decide.

Return a JSON array (same order as input, ${events.length} items):
[{"importance": 7.5, "reason": "one clear sentence why this matters to a retired Indian", "confidence": "high", "breaking": false, "mustInclude": false}]

Events:
${eventList}`;
}

function fallbackScore(ev: ClusteredEvent): number {
  const now = Date.now();
  const ageMs = now - new Date(ev.firstPublishedAt).getTime();
  const recencyBonus = ageMs < 6 * 3600_000 ? 1.5 : ageMs < 12 * 3600_000 ? 0.8 : 0;
  return Math.min(9, ev.publisherCount * 1.8 + (ev.inHeadlinesFeed ? 2.0 : 0) + recencyBonus);
}

async function scoreEvents(
  events: ClusteredEvent[],
  logger: Logger,
): Promise<ClusteredEvent[]> {
  if (events.length === 0) return [];

  // Pre-filter to stay within Gemini JSON output token limit
  // (~50 tokens/event × 150 events = 7500 tokens, safe under 16K)
  const filtered = preFilterForScoring(events, logger);
  const filteredIds = new Set(filtered.map(e => e.eventId));

  // Events dropped by pre-filter get fallback scores (they're low-priority solo stories)
  const droppedWithFallback = events
    .filter(ev => !filteredIds.has(ev.eventId))
    .map(ev => ({
      ...ev,
      importanceScore:  fallbackScore(ev),
      importanceReason: `Pre-filter fallback: solo source, low recency`,
    }));

  type ScoreResult = { importance: number; reason: string; confidence: string; breaking: boolean; mustInclude: boolean };

  async function scoreOneBatch(batch: ClusteredEvent[]): Promise<ScoreResult[]> {
    // 16K tokens supports ~300 events; batch should always be ≤150 after pre-filter
    const results: ScoreResult[] = await geminiJson(scoringPrompt(batch), 16384);
    if (!Array.isArray(results) || results.length < batch.length * 0.8) {
      throw new Error(`Bad result length: ${results?.length} for ${batch.length} events`);
    }
    return results;
  }

  const BATCH_SIZE = 120;

  let scored: ClusteredEvent[];
  try {
    if (filtered.length <= BATCH_SIZE) {
      // Single call (the common case after pre-filter)
      logger(`Scoring ${filtered.length} events (1 Gemini call)…`);
      const results = await scoreOneBatch(filtered);
      scored = filtered.map((ev, i) => {
        const r = results[i] ?? { importance: 3, reason: "No score", confidence: "low", mustInclude: false };
        return {
          ...ev,
          importanceScore:   Math.max(0, Math.min(10, Number(r.importance) || 3)),
          importanceReason:  String(r.reason ?? "").slice(0, 200),
          forcedByEditorial: Boolean(r.mustInclude),
        };
      });
    } else {
      // Batch scoring — split into chunks, then do a final comparative re-rank on top events
      const batches: ClusteredEvent[][] = [];
      for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
        batches.push(filtered.slice(i, i + BATCH_SIZE));
      }
      logger(`Scoring ${filtered.length} events in ${batches.length} batches…`);

      const batchScored: ClusteredEvent[] = [];
      for (const [bi, batch] of batches.entries()) {
        logger(`  Batch ${bi + 1}/${batches.length}: ${batch.length} events…`);
        try {
          const results = await scoreOneBatch(batch);
          batchScored.push(...batch.map((ev, i) => {
            const r = results[i] ?? { importance: 3, reason: "No score", confidence: "low", mustInclude: false };
            return {
              ...ev,
              importanceScore:   Math.max(0, Math.min(10, Number(r.importance) || 3)),
              importanceReason:  String(r.reason ?? "").slice(0, 200),
              forcedByEditorial: Boolean(r.mustInclude),
            };
          }));
        } catch {
          batchScored.push(...batch.map(ev => ({
            ...ev, importanceScore: fallbackScore(ev), importanceReason: "Batch fallback",
          })));
        }
      }
      scored = batchScored;
    }
  } catch (err: any) {
    logger(`  ✗ Scoring failed: ${err.message?.slice(0, 80)} — using fallback scores`);
    scored = filtered.map(ev => ({
      ...ev,
      importanceScore:  fallbackScore(ev),
      importanceReason: `Fallback: ${ev.publisherCount} publishers${ev.inHeadlinesFeed ? ", in headlines" : ""}`,
    }));
  }

  logger(`Scoring done — ${scored.length} scored + ${droppedWithFallback.length} pre-filter fallbacks`);
  return [...scored, ...droppedWithFallback];
}

// ─── Step 7: Briefing plan ────────────────────────────────────────────────────

function buildBriefingPlan(events: ClusteredEvent[], logger: Logger): ClusteredEvent[] {
  // Sort purely by importance score — the AI already weighted for the user persona
  const sorted = [...events].sort((a, b) => b.importanceScore - a.importanceScore);
  const used = new Set<string>();
  const plan: ClusteredEvent[] = [];

  const add = (ev: ClusteredEvent, section: string) => {
    ev.assignedSection = section;
    plan.push(ev);
    used.add(ev.eventId);
  };

  // 1. mustInclude events always air — no cap, no section limit
  for (const ev of sorted) {
    if (!ev.forcedByEditorial) continue;
    add(ev, ev.section);
  }

  // 2. Include all events scoring >= MIN_SCORE_THRESHOLD, ranked by score.
  //    No per-section caps — score decides everything.
  for (const ev of sorted) {
    if (used.has(ev.eventId)) continue;
    if (plan.length >= MAX_TOTAL_STORIES) break;
    if (ev.importanceScore < MIN_SCORE_THRESHOLD) break; // sorted desc, so can stop here
    add(ev, ev.section);
  }

  // 2b. Section minimums — backfill key sections that fell below their floor.
  //     Takes top-scoring unused events from that section regardless of threshold.
  //     Roundup sections are excluded (they get guaranteed coverage via clubbing).
  for (const [sec, min] of Object.entries(MIN_SECTION_SLOTS) as [SectionId, number][]) {
    if (ROUNDUP_SECTIONS.has(sec)) continue;
    const have = plan.filter(ev => ev.assignedSection === sec || ev.section === sec).length;
    if (have >= min) continue;
    const candidates = sorted.filter(ev => !used.has(ev.eventId) && ev.section === sec);
    for (const ev of candidates.slice(0, min - have)) {
      logger(`  📌 backfill ${sec}: ${ev.canonicalTitle.slice(0, 50)} (score ${ev.importanceScore.toFixed(1)})`);
      add(ev, sec);
    }
  }

  // 3. Club roundup sections: merge ≥2 events from the same section into one placeholder
  const roundupSectionEvents = new Map<SectionId, ClusteredEvent[]>();
  const nonRoundupPlan: ClusteredEvent[] = [];

  for (const ev of plan) {
    const sec = ev.assignedSection as SectionId;
    if (ROUNDUP_SECTIONS.has(sec)) {
      const arr = roundupSectionEvents.get(sec) ?? [];
      arr.push(ev);
      roundupSectionEvents.set(sec, arr);
    } else {
      nonRoundupPlan.push(ev);
    }
  }

  const finalPlan = [...nonRoundupPlan];
  for (const [sec, evs] of roundupSectionEvents) {
    if (evs.length < 2) {
      // Only 1 story in this roundup section — keep as individual
      finalPlan.push(...evs);
    } else {
      // Merge into synthetic roundup placeholder
      const feed = FEED_MAP.get(sec);
      const placeholder: ClusteredEvent = {
        eventId:           `roundup-${sec}`,
        canonicalTitle:    `${feed?.label ?? sec} Roundup`,
        section:           sec,
        assignedSection:   sec,
        sourceStories:     evs.flatMap(e => e.sourceStories),
        publisherCount:    evs.reduce((s, e) => s + e.publisherCount, 0),
        publishers:        [...new Set(evs.flatMap(e => e.publishers))],
        imageUrl:          evs.find(e => e.imageUrl)?.imageUrl,
        firstPublishedAt:  evs[0].firstPublishedAt,
        importanceScore:   Math.max(...evs.map(e => e.importanceScore)),
        importanceReason:  `Roundup of ${evs.length} ${sec} stories`,
        forcedByEditorial: false,
        inHeadlinesFeed:   false,
        roundupGroup:      evs,
      };
      finalPlan.push(placeholder);
      logger(`  🗂 Roundup: ${sec} (${evs.length} stories → 1 segment)`);
    }
  }

  const bySection = new Map<string, number>();
  for (const ev of finalPlan) bySection.set(ev.assignedSection, (bySection.get(ev.assignedSection) ?? 0) + 1);
  logger(`Briefing plan: ${finalPlan.length} segments (~${Math.round(finalPlan.length * 1.5)} min listen)`);
  for (const [section, count] of bySection) logger(`  ${section}: ${count}`);

  return finalPlan;
}

// ─── Step 8: Script generation ────────────────────────────────────────────────

interface ScriptedEvent {
  title:    string;
  titleHi?: string;
  titleTa?: string;
  titleMr?: string;
  scriptEn: string;
  scriptHi: string;
  scriptTa?: string;
  scriptMr?: string;
}

async function scriptEventBatch(
  sectionEvents: ClusteredEvent[],
  sectionId: SectionId,
  logger: Logger,
  languages: string[],
): Promise<ScriptedEvent[]> {
  if (sectionEvents.length === 0) return [];

  const label    = sectionId === "headlines" ? "Top Stories" : (FEED_MAP.get(sectionId)?.label ?? sectionId);
  const withTa   = languages.includes("ta");
  const withMr   = languages.includes("mr");

  const langRules = [
    `- scriptHi: Translate scriptEn into Hindi. ${LANG_META.hi.scriptNote}`,
    withTa ? `- scriptTa: Translate scriptEn into Tamil. ${LANG_META.ta.scriptNote}` : "",
    withMr ? `- scriptMr: Translate scriptEn into Marathi. ${LANG_META.mr.scriptNote}` : "",
    `- titleHi: Translate English title to Hindi (Devanagari).`,
    withTa ? `- titleTa: Translate English title to Tamil script.` : "",
    withMr ? `- titleMr: Translate English title to Marathi (Devanagari).` : "",
  ].filter(Boolean).join("\n");

  const extraTitleFields = [
    withTa ? `"titleTa":"..."` : "",
    withMr ? `"titleMr":"..."` : "",
  ].filter(Boolean).join(",");

  const extraScriptFields = [
    withTa ? `"scriptTa":"..."` : "",
    withMr ? `"scriptMr":"..."` : "",
  ].filter(Boolean).join(",");

  const jsonShape = `[{"eventIndex":0,"title":"...","titleHi":"..."${extraTitleFields ? "," + extraTitleFields : ""},"scriptEn":"...","scriptHi":"..."${extraScriptFields ? "," + extraScriptFields : ""}}]`;

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  const eventsPayload = sectionEvents.map((ev, i) => {
    const sources = ev.sourceStories.slice(0, 6).map(s => {
      const desc = s.description
        ?.replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400);
      return `  [${s.source}] ${s.title}${desc ? `\n   → ${desc}` : ""}`;
    }).join("\n");
    const editorialHint = ev.importanceReason ? `\n  Editorial: ${ev.importanceReason}` : "";
    return `eventIndex ${i}: ${ev.canonicalTitle} (${ev.publisherCount} publishers)${editorialHint}\n${sources}`;
  }).join("\n\n");

  const prompt = `You are Khabar AI's senior scriptwriter. Today: ${today}.
You are scripting the "${label}" section — ${sectionEvents.length} stories.

These scripts are spoken aloud. Think All India Radio meets a sharp, well-read friend. Complete. Engaging. Never thin.

━━━ SCRIPT STRUCTURE (follow for every story) ━━━

1. OPENING LINE — 1 sentence, 15-20 words.
   Hook immediately. Lead with the most surprising or consequential fact.
   NEVER begin with: "Today", "In a", "According to", "The", "A new", "India's"
   ✓ "Your home loan EMI stays put — the RBI has held rates for the sixth time running."
   ✓ "Something shifted quietly on India's northern border, and it matters."
   ✓ "Petrol just got cheaper in four major cities, and more may follow."

2. THE FULL STORY — 4-6 sentences.
   • Name everyone relevant. Quote every number.
   • Explain what led to this — context and backstory matter.
   • Who is doing what, and why.
   • State things clearly. No hedging. No vagueness.

3. WHY IT MATTERS — 2 sentences.
   Make it personal. How does this affect a retired Indian in a tier-1 or tier-2 city?
   Think: savings, family, pension, cost of living, safety, governance.

4. WHAT'S NEXT — 1 sentence.
   What should the listener keep an eye on? Leave them informed, not anxious.

━━━ WRITING RULES ━━━
• WORD COUNT: 160-200 words. Non-negotiable. Shorter is a failure. Use the full range.
• Use your knowledge of Indian news, history, and context freely. If source material is sparse, draw on everything you know about this story, its background, and its implications.
• Do NOT fabricate specific quotes, unverified votes, or numbers that contradict the source. But DO write with authority about context, history, significance, and implications.
• VOICE: Warm, confident, conversational. Like a knowledgeable friend — not a newsreader robot.
• FORBIDDEN: "reportedly", "it is said", "sources say", "according to", "details are unclear"
• FORBIDDEN: bullet points, numbered lists, parentheses, em-dashes mid-sentence
• SENTENCES: Max 18 words. Vary rhythm — some short and punchy, some medium-length.
• ALWAYS flow naturally when spoken aloud. No awkward written-language constructions.

━━━ TRANSLATIONS ━━━
${langRules}
• Proper nouns, numbers, acronyms, brand names — keep in original form.
• NEVER romanise native-language words.
• Each translation is a complete spoken script in the target language — same depth and energy.

Return JSON only (${sectionEvents.length} objects, same order as input):
${jsonShape}

STORIES TO SCRIPT:
${eventsPayload}`;

  try {
    // 16384 tokens: needed for large sections (8+ events × 4 languages × ~200 tokens each)
    const rawResults: Array<{ eventIndex?: number } & ScriptedEvent> = await geminiJson(prompt, 16384);
    if (!Array.isArray(rawResults) || rawResults.length === 0) throw new Error("empty result");

    // Sort by eventIndex if present so misreordered responses still align correctly
    const byIndex = new Map(rawResults.map(r => [r.eventIndex ?? -1, r]));
    const results = sectionEvents.map((_, i) => byIndex.get(i) ?? rawResults[i] ?? {});

    return sectionEvents.map((ev, i) => {
      const r = results[i] ?? {};
      return {
        title:    r.title    || ev.canonicalTitle,
        titleHi:  hasExpectedScript(r.titleHi, "hi") ? r.titleHi : undefined,
        titleTa:  hasExpectedScript(r.titleTa, "ta") ? r.titleTa : undefined,
        titleMr:  hasExpectedScript(r.titleMr, "mr") ? r.titleMr : undefined,
        scriptEn: r.scriptEn || ev.canonicalTitle + ".",
        scriptHi: hasExpectedScript(r.scriptHi, "hi") ? r.scriptHi : "",
        scriptTa: hasExpectedScript(r.scriptTa, "ta") ? r.scriptTa : undefined,
        scriptMr: hasExpectedScript(r.scriptMr, "mr") ? r.scriptMr : undefined,
      };
    });
  } catch (err: any) {
    logger(`  ✗ Script ${sectionId}: ${err.message?.slice(0, 80)} — using fallback`);
    return sectionEvents.map(ev => ({
      title:    ev.canonicalTitle,
      scriptEn: ev.canonicalTitle + ". " + (ev.sourceStories[0]?.description?.replace(/<[^>]+>/g, "").slice(0, 200) ?? ""),
      scriptHi: "",
    }));
  }
}

async function scriptRoundupGroup(
  ev: ClusteredEvent,
  logger: Logger,
  languages: string[],
): Promise<ScriptedEvent> {
  const items = ev.roundupGroup!;
  const label = FEED_MAP.get(ev.assignedSection)?.label ?? ev.assignedSection;
  const withTa = languages.includes("ta");
  const withMr = languages.includes("mr");

  const itemsPayload = items.map((item, i) =>
    `${i + 1}. ${item.canonicalTitle} (${item.publisherCount} publishers)\n   ${item.sourceStories[0]?.description?.replace(/<[^>]+>/g, "").trim().slice(0, 150) ?? ""}`
  ).join("\n\n");

  const extraFields = [
    withTa ? `"titleTa":"...","scriptTa":"..."` : "",
    withMr ? `"titleMr":"...","scriptMr":"..."` : "",
  ].filter(Boolean).join(",");

  const prompt = `You are Khabar AI. Write a single flowing spoken-audio roundup segment for the "${label}" section covering ${items.length} brief stories.

STYLE: Tight, punchy delivery. No hook/structure — just the facts with natural connectors between items.
 ("Meanwhile in tech...", "Also worth noting...", "And finally...").
WORD COUNT: ${items.length * 55}–${items.length * 70} words total. Each item gets 1-2 sentences max.
NEVER start with "In ${label} news" or "${label} roundup" — jump straight into the first story.
NEVER invent facts. Keep numbers and names precise.

Also provide:
- title: Short English label like "${label} Roundup"
- titleHi: Hindi label in Devanagari
- scriptHi: Full Hindi translation of the roundup script
${withTa ? "- titleTa: Tamil label\n- scriptTa: Full Tamil translation" : ""}
${withMr ? "- titleMr: Marathi label\n- scriptMr: Full Marathi translation" : ""}

Return a single JSON object:
{"title":"...","titleHi":"...","scriptEn":"...","scriptHi":"..."${extraFields ? "," + extraFields : ""}}

Stories to cover:
${itemsPayload}`;

  try {
    const raw = await geminiJson(prompt, 4096) as ScriptedEvent & { title?: string };
    return {
      title:   raw.title   || `${label} Roundup`,
      titleHi: raw.titleHi,
      titleTa: withTa ? raw.titleTa : undefined,
      titleMr: withMr ? raw.titleMr : undefined,
      scriptEn: raw.scriptEn || items.map(i => i.canonicalTitle).join(". ") + ".",
      scriptHi: hasExpectedScript(raw.scriptHi, "hi") ? raw.scriptHi : "",
      scriptTa: withTa && hasExpectedScript(raw.scriptTa, "ta") ? raw.scriptTa : undefined,
      scriptMr: withMr && hasExpectedScript(raw.scriptMr, "mr") ? raw.scriptMr : undefined,
    };
  } catch (err: any) {
    logger(`  ✗ Roundup script ${ev.assignedSection}: ${err.message?.slice(0, 80)}`);
    return {
      title:    `${label} Roundup`,
      scriptEn: items.map(i => i.canonicalTitle).join(". ") + ".",
      scriptHi: "",
    };
  }
}

/** Fix-up pass: re-translate fields that came back in wrong script. */
async function fixScriptLanguages(
  stories: Story[],
  nonEnLangs: string[],
  logger: Logger,
): Promise<Story[]> {
  if (nonEnLangs.length === 0) return stories;

  const toFix = stories.map((s, idx) => {
    const missingLangs = nonEnLangs.filter(lang => {
      const script = lang === "hi" ? s.scriptHi : lang === "ta" ? s.scriptTa : lang === "mr" ? s.scriptMr : undefined;
      return !hasExpectedScript(script, lang);
    });
    return missingLangs.length > 0 ? { idx, story: s, missingLangs } : null;
  }).filter(Boolean) as Array<{ idx: number; story: Story; missingLangs: string[] }>;

  if (toFix.length === 0) return stories;
  logger(`  ⚙ Re-translating ${toFix.length} stories with missing-script fields…`);

  const updated    = stories.map(s => ({ ...s }));
  const batchLangs = [...new Set(toFix.flatMap(x => x.missingLangs))];
  const langDescs  = batchLangs.map(lang => {
    const m = LANG_META[lang]!;
    return `- ${lang.toUpperCase()} (${m.name}): ${m.scriptNote} Example: "${m.example}"`;
  }).join("\n");

  const storiesPayload = toFix.map((x, i) =>
    `${i}. title: "${x.story.title}"\n   scriptEn: "${x.story.scriptEn}"\n   needs: ${x.missingLangs.join(", ")}`
  ).join("\n");

  const prompt = `Translate these news scripts into the specified Indian languages. Native script ONLY — no Roman letters.

LANGUAGE RULES:
${langDescs}

Return JSON array (${toFix.length} objects, same order):
[${toFix.map(x => `{${x.missingLangs.flatMap(l => [`"script${l[0].toUpperCase() + l.slice(1)}":"..."`, `"title${l[0].toUpperCase() + l.slice(1)}":"..."`]).join(",")}}`).join(",")}]

Stories:
${storiesPayload}`;

  try {
    const results: any[] = await geminiJson(prompt);
    if (!Array.isArray(results)) throw new Error("not an array");
    for (let i = 0; i < toFix.length && i < results.length; i++) {
      const { idx, missingLangs } = toFix[i];
      const r = results[i] ?? {};
      for (const lang of missingLangs) {
        const sKey = `script${lang[0].toUpperCase() + lang.slice(1)}` as keyof Story;
        const tKey = `title${lang[0].toUpperCase() + lang.slice(1)}`  as keyof Story;
        const newScript = r[sKey as string];
        const newTitle  = r[tKey as string];
        if (hasExpectedScript(newScript, lang)) {
          (updated[idx] as any)[sKey] = newScript;
          logger(`    ✓ ${lang.toUpperCase()} fixed: ${updated[idx].title.slice(0, 45)}`);
        }
        if (newTitle && hasExpectedScript(newTitle, lang)) {
          (updated[idx] as any)[tKey] = newTitle;
        }
      }
    }
  } catch (err: any) {
    logger(`  ✗ Script fix-up failed: ${err.message?.slice(0, 80)}`);
  }

  return updated;
}

async function scriptSelectedEvents(
  selectedEvents: ClusteredEvent[],
  logger: Logger,
  languages: string[],
): Promise<Story[]> {
  if (selectedEvents.length === 0) return [];

  const bySection = new Map<SectionId, ClusteredEvent[]>();
  for (const ev of selectedEvents) {
    const arr = bySection.get(ev.assignedSection) ?? [];
    arr.push(ev);
    bySection.set(ev.assignedSection, arr);
  }

  logger(`Scripting ${selectedEvents.length} events across ${bySection.size} sections…`);
  const stories: Story[] = [];
  const sectionProcessOrder: SectionId[] = ["headlines", ...SECTION_ORDER];

  for (const sectionId of sectionProcessOrder) {
    if (isAbortRequested()) { logger("⛔ Aborted"); break; }
    const events = bySection.get(sectionId);
    if (!events || events.length === 0) continue;

    const emoji = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    logger(`  ${emoji} ${sectionId}: scripting ${events.length} events…`);

    // Split events into individual vs roundup placeholders
    const individualEvents = events.filter(ev => !ev.roundupGroup);
    const roundupEvents    = events.filter(ev => !!ev.roundupGroup);

    // Script individual events as a batch
    const scripted = await scriptEventBatch(individualEvents, sectionId, logger, languages);

    for (let i = 0; i < individualEvents.length; i++) {
      const ev = individualEvents[i];
      const sc = scripted[i] ?? { title: ev.canonicalTitle, scriptEn: ev.canonicalTitle + ".", scriptHi: "" };
      const primary = ev.sourceStories[0];
      const sources: StorySource[] = ev.sourceStories.map(s => ({
        title: s.title, source: s.source, link: s.link,
      }));

      stories.push({
        id:                ev.eventId,
        title:             sc.title || ev.canonicalTitle,
        titleHi:           sc.titleHi,
        titleTa:           sc.titleTa,
        titleMr:           sc.titleMr,
        source:            ev.publishers[0] ?? primary.source,
        link:              primary.link,
        publishedAt:       ev.firstPublishedAt,
        section:           ev.assignedSection,
        imageUrl:          ev.imageUrl ?? primary.imageUrl,
        description:       primary.description,
        sources,
        scriptEn:          sc.scriptEn,
        scriptHi:          sc.scriptHi ?? "",
        scriptTa:          sc.scriptTa,
        scriptMr:          sc.scriptMr,
        audioStartSec:     0,
        importanceScore:   ev.importanceScore,
        importanceReason:  ev.importanceReason,
        forcedByEditorial: ev.forcedByEditorial,
        wordCount:         sc.scriptEn.trim().split(/\s+/).length,
        publisherCount:    ev.publisherCount,
        publishers:        ev.publishers,
      });
    }

    // Script roundup placeholders
    for (const ev of roundupEvents) {
      logger(`  🗂 ${sectionId}: scripting roundup (${ev.roundupGroup!.length} items)…`);
      const sc = await scriptRoundupGroup(ev, logger, languages);
      const primary = ev.sourceStories[0];
      stories.push({
        id:                ev.eventId,
        title:             sc.title || ev.canonicalTitle,
        titleHi:           sc.titleHi,
        titleTa:           sc.titleTa,
        titleMr:           sc.titleMr,
        source:            ev.publishers[0] ?? primary?.source ?? "",
        link:              primary?.link ?? "",
        publishedAt:       ev.firstPublishedAt,
        section:           ev.assignedSection,
        imageUrl:          ev.imageUrl,
        description:       `${ev.roundupGroup!.length} stories`,
        sources:           ev.sourceStories.map(s => ({ title: s.title, source: s.source, link: s.link })),
        scriptEn:          sc.scriptEn,
        scriptHi:          sc.scriptHi ?? "",
        scriptTa:          sc.scriptTa,
        scriptMr:          sc.scriptMr,
        audioStartSec:     0,
        importanceScore:   ev.importanceScore,
        importanceReason:  ev.importanceReason,
        forcedByEditorial: false,
        wordCount:         sc.scriptEn.trim().split(/\s+/).length,
        publisherCount:    ev.publisherCount,
        publishers:        ev.publishers,
        isRoundup:         true,
        roundupItems:      ev.roundupGroup!.map(item => ({
          title:   item.canonicalTitle,
          titleHi: undefined,
          titleTa: undefined,
          titleMr: undefined,
        })),
      });
    }
  }

  const nonEnLangs = languages.filter(l => l !== "en");
  const fixed = await fixScriptLanguages(stories, nonEnLangs, logger);
  logger(`Scripting done — ${fixed.length} stories`);
  return fixed;
}

// ─── Step 9: Briefing wrapper ─────────────────────────────────────────────────

function makeOpeningScript(): { en: string; hi: string; ta: string; mr: string } {
  const now = new Date();
  const opts = { timeZone: "Asia/Kolkata" } as const;

  const dayEn   = now.toLocaleDateString("en-IN",  { weekday: "long",  ...opts });
  const dateEn  = now.toLocaleDateString("en-IN",  { day: "numeric", month: "long", year: "numeric", ...opts });
  const dayHi   = now.toLocaleDateString("hi-IN",  { weekday: "long",  ...opts });
  const dateHi  = now.toLocaleDateString("hi-IN",  { day: "numeric", month: "long", year: "numeric", ...opts });
  const dayTa   = now.toLocaleDateString("ta-IN",  { weekday: "long",  ...opts });
  const dateTa  = now.toLocaleDateString("ta-IN",  { day: "numeric", month: "long", year: "numeric", ...opts });
  const dayMr   = now.toLocaleDateString("mr-IN",  { weekday: "long",  ...opts });
  const dateMr  = now.toLocaleDateString("mr-IN",  { day: "numeric", month: "long", year: "numeric", ...opts });

  return {
    en: `Good morning. Today is ${dayEn}, ${dateEn}. Here's everything important that happened in the last twenty-four hours.`,
    hi: `सुप्रभात। आज ${dayHi} है, ${dateHi}। पिछले चौबीस घंटों में जो महत्वपूर्ण हुआ, वह यहाँ है।`,
    ta: `காலை வணக்கம். இன்று ${dayTa}, ${dateTa}. கடந்த இருபத்து நான்கு மணி நேரத்தில் நடந்த முக்கியமான செய்திகள் இங்கே.`,
    mr: `शुभ प्रभात. आज ${dayMr} आहे, ${dateMr}. गेल्या चोवीस तासांत जे महत्त्वाचे घडले ते येथे आहे.`,
  };
}

function makeClosingScript(): { en: string; hi: string; ta: string; mr: string } {
  return {
    en: "That's your Khabar AI briefing for today. We'll be back tomorrow morning with everything that matters. Have a wonderful day.",
    hi: "यह था आज का आपका खबर एआई ब्रीफिंग। हम कल सुबह फिर लौटेंगे हर जरूरी खबर के साथ। आपका दिन शुभ हो।",
    ta: "இன்றைய உங்கள் கபர் ஏஐ பிரீஃபிங் இங்கே முடிகிறது. நாளை காலை முக்கியமான அனைத்து செய்திகளுடன் திரும்பி வருவோம். நல்ல நாள் வாழ்த்துகள்.",
    mr: "हे होते आजचे तुमचे खबर एआय ब्रीफिंग. उद्या सकाळी महत्त्वाच्या सर्व बातम्यांसह परत येऊ. आपला दिवस चांगला जावो.",
  };
}

const SECTION_LABELS: Partial<Record<SectionId, string>> = {
  headlines:     "Top Stories",
  india:         "India",
  world:         "World",
  business:      "Business",
  technology:    "Technology",
  sports:        "Sports",
  health:        "Health",
  entertainment: "Entertainment",
  science:       "Science",
  local:         "Local News",
};

const STATIC_TRANSITIONS: Partial<Record<SectionId, string>> = {
  india:         "Now let's turn to India.",
  world:         "From India to the world.",
  business:      "In business today...",
  technology:    "Now, some technology news.",
  sports:        "Here's what happened in sports.",
  health:        "On the health front...",
  entertainment: "And now, some lighter news.",
  science:       "In science and research...",
  local:         "Some local news now.",
};

async function generateTransitions(
  sections: SectionId[],
  logger: Logger,
  languages: string[],
): Promise<BriefingSegment[]> {
  // Need a transition before each section except the first
  const transitionSections = sections.slice(1);
  if (transitionSections.length === 0) return [];

  const withTa = languages.includes("ta");
  const withMr = languages.includes("mr");

  const extraFields = [
    withTa ? `"scriptTa":"..."` : "",
    withMr ? `"scriptMr":"..."` : "",
  ].filter(Boolean).join(",");

  const prompt = `You are Khabar AI's radio host. Write short section-intro lines for a news briefing.
These play between sections — warm, professional, like BBC Radio 4.

Each line: 8-15 words. One sentence. No filler like "And now let's move on to our next segment."
Sound human and direct. Use present tense or imperative mood.

✓ "Now let's turn to India."
✓ "In business today, a big day for Indian markets."
✓ "Turning to sports — a busy week in cricket."

Write ONE intro line per section. Return JSON array:
[{"section":"india","scriptEn":"...","scriptHi":"..."${extraFields ? "," + extraFields : ""}}]

All scriptHi must use Devanagari script only.
${withTa ? "All scriptTa must use Tamil script only." : ""}
${withMr ? "All scriptMr must use Devanagari script only (Marathi)." : ""}

Sections needed (${transitionSections.length} total):
${transitionSections.map((s, i) => `${i + 1}. ${s} → "${SECTION_LABELS[s] ?? s}"`).join("\n")}`;

  try {
    const results: Array<{ section: string; scriptEn: string; scriptHi: string; scriptTa?: string; scriptMr?: string }> =
      await geminiJson(prompt);

    if (!Array.isArray(results)) throw new Error("not array");

    return transitionSections.map((sectionId, i) => {
      const r = results.find(x => x.section === sectionId) ?? results[i] ?? {} as any;
      return {
        id:       `transition-${sectionId}`,
        type:     "transition" as const,
        section:  sectionId,
        scriptEn: r.scriptEn || STATIC_TRANSITIONS[sectionId] || `Now, ${SECTION_LABELS[sectionId] ?? sectionId}.`,
        scriptHi: hasExpectedScript(r.scriptHi, "hi") ? r.scriptHi : `अब, ${SECTION_LABELS[sectionId] ?? sectionId}.`,
        scriptTa: withTa && hasExpectedScript(r.scriptTa, "ta") ? r.scriptTa : undefined,
        scriptMr: withMr && hasExpectedScript(r.scriptMr, "mr") ? r.scriptMr : undefined,
      };
    });
  } catch (err: any) {
    logger(`  ✗ Transitions: ${err.message?.slice(0, 60)} — using static fallbacks`);
    return transitionSections.map(sectionId => ({
      id:       `transition-${sectionId}`,
      type:     "transition" as const,
      section:  sectionId,
      scriptEn: STATIC_TRANSITIONS[sectionId] ?? `Now, ${SECTION_LABELS[sectionId] ?? sectionId}.`,
      scriptHi: `अब, ${SECTION_LABELS[sectionId] ?? sectionId}.`,
      scriptTa: undefined,
      scriptMr: undefined,
    }));
  }
}

async function generateWrapper(
  stories: Story[],
  logger: Logger,
  languages: string[],
): Promise<BriefingSegment[]> {
  logger("Generating briefing wrapper (opening, transitions, closing)…");

  const opening = makeOpeningScript();
  const closing = makeClosingScript();

  // Determine ordered sections present in the briefing
  const sectionSet = new Set<SectionId>();
  for (const story of stories) sectionSet.add(story.section);
  const orderedSections = (["headlines", ...SECTION_ORDER] as SectionId[])
    .filter(s => sectionSet.has(s));

  const transitions = await generateTransitions(orderedSections, logger, languages);

  const segments: BriefingSegment[] = [
    {
      id:       "opening",
      type:     "opening",
      scriptEn: opening.en,
      scriptHi: opening.hi,
      scriptTa: languages.includes("ta") ? opening.ta : undefined,
      scriptMr: languages.includes("mr") ? opening.mr : undefined,
    },
    ...transitions,
    {
      id:       "closing",
      type:     "closing",
      scriptEn: closing.en,
      scriptHi: closing.hi,
      scriptTa: languages.includes("ta") ? closing.ta : undefined,
      scriptMr: languages.includes("mr") ? closing.mr : undefined,
    },
  ];

  logger(`Wrapper: 1 opening + ${transitions.length} transitions + 1 closing = ${segments.length} segments`);
  return segments;
}

// ─── Step 10: TTS ─────────────────────────────────────────────────────────────

function getStoryScript(story: Story, lang: string): string | undefined {
  if (lang === "en") return story.scriptEn || undefined;
  if (lang === "hi") return story.scriptHi || undefined;
  if (lang === "ta") return story.scriptTa;
  if (lang === "mr") return story.scriptMr;
  return undefined;
}

function getSegmentScript(seg: BriefingSegment, lang: string): string | undefined {
  if (lang === "en") return seg.scriptEn || undefined;
  if (lang === "hi") return seg.scriptHi || undefined;
  if (lang === "ta") return seg.scriptTa;
  if (lang === "mr") return seg.scriptMr;
  return undefined;
}

function setStoryAudioUrl(story: Story, lang: string, url: string): void {
  if (lang === "en") { story.audioUrlEn = url; story.audioStartSec = 0; }
  else if (lang === "hi") story.audioUrlHi = url;
  else if (lang === "ta") story.audioUrlTa = url;
  else if (lang === "mr") story.audioUrlMr = url;
}

function setSegmentAudioUrl(seg: BriefingSegment, lang: string, url: string): void {
  if (lang === "en") seg.audioUrlEn = url;
  else if (lang === "hi") seg.audioUrlHi = url;
  else if (lang === "ta") seg.audioUrlTa = url;
  else if (lang === "mr") seg.audioUrlMr = url;
}

function isProviderLangSupported(provider: TtsProvider, lang: string): boolean {
  if (provider === "kokoro") return lang === "en";
  if (provider === "google") return lang === "en" || lang === "hi";
  return true; // elevenlabs and edge support all 4 languages
}

async function synthesizeOne(text: string, filename: string, provider: TtsProvider): Promise<string> {
  if (provider === "google")     { const { url } = await googleTTS(text, filename);    return url; }
  if (provider === "elevenlabs") { const { url } = await elevenLabsTTS(text, filename); return url; }
  if (provider === "edge")       { const { url } = await edgeTTS(text, filename);       return url; }
  if (provider === "kokoro")     { const { url } = await kokoroTTS(text, filename);     return url; }
  throw new Error(`Unknown TTS provider: ${provider}`);
}

async function generateAllTTS(
  stories: Story[],
  segments: BriefingSegment[],
  date: string,
  provider: TtsProvider,
  languages: string[],
  logger: Logger,
  onProgress?: (stories: Story[], segments: BriefingSegment[]) => Promise<void>,
): Promise<{ stories: Story[]; segments: BriefingSegment[]; costInfo: TtsCostInfo }> {
  const updatedStories  = stories.map(s => ({ ...s }));
  const updatedSegments = segments.map(s => ({ ...s }));
  let enChars = 0, hiChars = 0, taChars = 0, mrChars = 0;
  let storiesWithAudio = 0;

  logger(`TTS (${provider}): ${stories.length} stories + ${segments.length} segments × ${languages.length} languages`);

  // Wrapper segments first (short, fast) — save after each segment completes all languages
  logger("  Wrapper segments…");
  for (let si = 0; si < updatedSegments.length; si++) {
    const seg = updatedSegments[si];
    if (isAbortRequested()) break;
    for (const lang of languages) {
      if (!isProviderLangSupported(provider, lang)) continue;
      const script = getSegmentScript(seg, lang);
      if (!script) continue;
      try {
        const url = await synthesizeOne(script, `${date}-${seg.id}-${lang}`, provider);
        setSegmentAudioUrl(seg, lang, url);
        if (lang === "en") enChars += script.length;
        else if (lang === "hi") hiChars += script.length;
        else if (lang === "ta") taChars += script.length;
        else if (lang === "mr") mrChars += script.length;
        logger(`    ✓ ${seg.type} ${lang.toUpperCase()}${seg.section ? ` (→${seg.section})` : ""}`);
      } catch (err: any) {
        logger(`    ✗ ${seg.id} ${lang.toUpperCase()}: ${err.message?.slice(0, 60)}`);
      }
    }
    // Save after each segment so partial progress survives an abort
    if (onProgress) await onProgress([...updatedStories], [...updatedSegments]);
  }

  // Stories
  for (let i = 0; i < stories.length; i++) {
    if (isAbortRequested()) { logger("⛔ Aborted"); break; }
    if (provider === "google"     && isDailyQuotaExhausted()) { logger("⛔ Google TTS quota"); break; }
    if (provider === "elevenlabs" && isQuotaExhausted())      { logger("⛔ ElevenLabs quota"); break; }

    const story    = stories[i];
    const fileBase = `${date}-${story.id}`;
    let gotAny = false;

    for (const lang of languages) {
      if (isAbortRequested()) break;
      if (!isProviderLangSupported(provider, lang)) continue;

      const script = getStoryScript(story, lang);
      if (!script) continue;

      try {
        const url = await synthesizeOne(script, `${fileBase}-${lang}`, provider);
        setStoryAudioUrl(updatedStories[i], lang, url);
        if (lang === "en") enChars += script.length;
        else if (lang === "hi") hiChars += script.length;
        else if (lang === "ta") taChars += script.length;
        else if (lang === "mr") mrChars += script.length;
        gotAny = true;
      } catch (err: any) {
        logger(`  ✗ [${i + 1}/${stories.length}] ${lang.toUpperCase()}: ${err.message?.slice(0, 60)}`);
      }
    }

    if (gotAny) {
      storiesWithAudio++;
      logger(`  ✓ [${i + 1}/${stories.length}] ${story.title.slice(0, 55)}`);
    } else {
      logger(`  ⚠ [${i + 1}/${stories.length}] no audio — ${story.title.slice(0, 45)}`);
    }

    if (onProgress) await onProgress([...updatedStories], [...updatedSegments]);
    // Note: Google TTS RPM spacing is handled inside google.ts (waitForRpmSlot — 6.5s gap)
  }

  const totalChars = enChars + hiChars + taChars + mrChars;
  // ElevenLabs Flash v2.5: ~$0.08/1K chars; Google Neural2: ~$0.50/1M chars; Edge/Kokoro: free
  const estimatedUsd =
    provider === "elevenlabs" ? (totalChars / 1000) * 0.08 :
    provider === "google"     ? (totalChars / 1_000_000) * 0.50 :
    0;

  const costInfo: TtsCostInfo = {
    provider, enChars, hiChars, taChars, mrChars, totalChars,
    estimatedUsd, storiesAttempted: stories.length, storiesWithAudio,
  };

  logger(`TTS done: ${storiesWithAudio}/${stories.length} stories, ${(totalChars / 1000).toFixed(1)}K chars, est. $${estimatedUsd.toFixed(2)}`);
  return { stories: updatedStories, segments: updatedSegments, costInfo };
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
    "india-sports":   "sports",  "india-tech":     "technology",
    "india-entertainment": "entertainment", "india-health": "health",
    "global-world":   "world",   "global-business": "business",
    "global-sports":  "sports",  "global-tech":    "technology",
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
          id:            topic.id ?? storyId(topic.sourceUrl ?? String(Math.random())),
          title:         topic.headline ?? topic.title ?? "",
          source:        topic.sourceName ?? "Unknown",
          link:          topic.sourceUrl ?? "",
          publishedAt:   raw.generatedAt ?? new Date().toISOString(),
          section:       mapOldCategory(section.category),
          scriptEn:      topic.monologueScript ?? "",
          scriptHi:      "",
          audioUrlEn:    topic.audioUrlEn ?? (topic as any).audioUrl,
          audioUrlHi:    topic.audioUrlHi,
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
  languages: string[] = ["en", "hi"],
): Promise<DailyBriefing & { runSummary?: RunSummary }> {
  const runStart = Date.now();
  const date     = new Date().toISOString().slice(0, 10);
  const log      = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing v4 — ${date} | city: ${city} | TTS: ${ttsProvider} | langs: ${languages.join(",")}`);

  // Step 1: Fetch
  const t0 = Date.now();
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap  = await fetchAllFeeds(city);
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  const fetchSec = (Date.now() - t0) / 1000;
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds (${fetchSec.toFixed(1)}s)`);

  // Step 2: Dedup
  const rawStories = buildRawStories(feedMap);
  log(`After dedup: ${rawStories.length} unique articles`);
  for (const feed of FEEDS) {
    const n = rawStories.filter(s => s.section === feed.id).length;
    if (n > 0) log(`  ${feed.emoji} ${feed.label}: ${n}`);
  }

  // Steps 2b + 4 in parallel: OG images + clustering
  const t1 = Date.now();
  const liveImageById = new Map<string, string>();
  const [withImages, allEvents] = await Promise.all([
    fetchAllOgImages(rawStories, log, liveImageById),
    clusterAllSections(rawStories, log),
  ]);
  const clusterSec = (Date.now() - t1) / 1000;

  // Merge OG images into events
  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  for (const ev of allEvents) {
    if (!ev.imageUrl) {
      ev.imageUrl = ev.sourceStories.map(s => imageById.get(s.id)).find(Boolean);
    }
  }

  // Step 5: Score
  const t2 = Date.now();
  const scoredEvents = await scoreEvents(allEvents, log);
  const scoreSec = (Date.now() - t2) / 1000;
  log(`Scoring done in ${scoreSec.toFixed(1)}s`);

  // Step 6: mustInclude events are already flagged by scoreEvents() via AI judgment
  const forced = scoredEvents.filter(e => e.forcedByEditorial).length;
  if (forced > 0) log(`AI editorial flags: ${forced} events marked mustInclude`);

  // Step 7: Briefing plan
  const selectedEvents = buildBriefingPlan(scoredEvents, log);

  // Early save (structure visible before scripts are generated)
  await saveBriefing({
    date, generatedAt: new Date().toISOString(), generatedLanguages: languages,
    stories: selectedEvents.map(ev => ({
      id: ev.eventId, title: ev.canonicalTitle,
      source: ev.publishers[0] ?? "", link: ev.sourceStories[0]?.link ?? "",
      publishedAt: ev.firstPublishedAt, section: ev.assignedSection,
      imageUrl: ev.imageUrl, scriptEn: "", scriptHi: "",
    })),
  });

  // Step 8: Scripts
  const t3 = Date.now();
  const stories = await scriptSelectedEvents(selectedEvents, log, languages);
  const scriptSec = (Date.now() - t3) / 1000;
  log(`Scripts done in ${scriptSec.toFixed(1)}s`);

  // Build meta
  const estimatedWords      = stories.reduce((n, s) => n + (s.wordCount ?? s.scriptEn.split(/\s+/).length), 0);
  const estimatedDurationSec = Math.round((estimatedWords / TARGET_WPM) * 60);
  const sectionSet           = new Set<SectionId>();
  for (const s of stories) sectionSet.add(s.section);
  const sections = (["headlines", ...SECTION_ORDER] as SectionId[]).filter(s => sectionSet.has(s));

  const meta: BriefingMeta = {
    totalStories:          stories.length,
    totalArticles:         rawStories.length,
    estimatedDurationSec,
    sections,
  };

  // Step 9: Wrapper
  const segments = await generateWrapper(stories, log, languages);

  // Save with scripts + segments (pre-TTS checkpoint)
  await saveBriefing({ date, generatedAt: new Date().toISOString(), stories, segments, meta, generatedLanguages: languages });
  log(`Pre-TTS checkpoint: ${stories.length} stories + ${segments.length} segments saved`);

  // Step 10: TTS
  const t4 = Date.now();
  const { stories: withAudio, segments: withSegmentAudio, costInfo } = await generateAllTTS(
    stories, segments, date, ttsProvider, languages, log,
    async (s, segs) => {
      await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: s, segments: segs, meta, generatedLanguages: languages });
    },
  );
  const ttsSec     = (Date.now() - t4) / 1000;
  const elapsedSec = (Date.now() - runStart) / 1000;

  const runSummary: RunSummary = {
    elapsedSec,
    fetchSec,
    clusterSec,
    scoreSec,
    scriptSec,
    ttsSec,
    rawStories:      rawStories.length,
    clusteredEvents: allEvents.length,
    selectedStories: stories.length,
    tts:             costInfo,
  };

  const mins = Math.floor(elapsedSec / 60);
  const secs = Math.round(elapsedSec % 60);
  log(`✅ Done in ${mins}m ${secs}s — ${withAudio.length} stories, ~${(estimatedDurationSec / 60).toFixed(1)} min briefing, est. $${costInfo.estimatedUsd.toFixed(2)}`);

  const briefing: DailyBriefing & { runSummary?: RunSummary } = {
    date,
    generatedAt:        new Date().toISOString(),
    stories:            withAudio,
    segments:           withSegmentAudio,
    meta,
    generatedLanguages: languages,
    runSummary,
  };

  await saveBriefing(briefing);
  return briefing;
}

// ─── Admin: generate missing sections ─────────────────────────────────────────

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

  // v4 pipeline is holistic (scoring requires all events together), so always regenerate
  log(`Refreshing: ${existing.stories.length} stories exist — running full regeneration…`);
  const fresh = await generateDailyBriefing(logger, city, "google", existing.generatedLanguages ?? ["en", "hi"]);
  return { added: ["(full regeneration)"], briefing: fresh };
}

// ─── Admin: generate missing TTS ──────────────────────────────────────────────

export async function generateMissingTTS(
  logger: Logger = () => {},
  provider: TtsProvider = "google",
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) {
    log("No briefing found");
    return { patched: 0, briefing: { date: "", generatedAt: "", stories: [] } };
  }

  const languages = existing.generatedLanguages ?? ["en", "hi"];

  const storiesNeedingAudio = existing.stories.filter(s =>
    languages.some(lang => {
      const script = getStoryScript(s, lang);
      const audio  = lang === "en" ? s.audioUrlEn : lang === "hi" ? s.audioUrlHi
                   : lang === "ta" ? s.audioUrlTa : s.audioUrlMr;
      return script && !audio;
    })
  );
  const segmentsNeedingAudio = (existing.segments ?? []).filter(seg =>
    languages.some(lang => {
      const script = getSegmentScript(seg, lang);
      const audio  = lang === "en" ? seg.audioUrlEn : lang === "hi" ? seg.audioUrlHi
                   : lang === "ta" ? seg.audioUrlTa : seg.audioUrlMr;
      return script && !audio;
    })
  );

  log(`TTS patch: ${storiesNeedingAudio.length} stories + ${segmentsNeedingAudio.length} segments need audio`);

  if (storiesNeedingAudio.length === 0 && segmentsNeedingAudio.length === 0) {
    log("All audio already generated");
    return { patched: 0, briefing: existing };
  }

  const { stories: patched, segments: patchedSegs, costInfo } = await generateAllTTS(
    storiesNeedingAudio, segmentsNeedingAudio, existing.date, provider, languages, log,
    async (patchedStories, patchedSegsPartial) => {
      // Merge partial results back into the full briefing and save incrementally
      const byId    = new Map(patchedStories.map(s => [s.id, s]));
      const segById = new Map(patchedSegsPartial.map(s => [s.id, s]));
      await saveBriefing({
        ...existing,
        stories:     existing.stories.map(s => byId.get(s.id) ?? s),
        segments:    (existing.segments ?? []).map(s => segById.get(s.id) ?? s),
        generatedAt: new Date().toISOString(),
      });
    },
  );

  const patchedById    = new Map(patched.map(s => [s.id, s]));
  const patchedSegById = new Map(patchedSegs.map(s => [s.id, s]));
  const mergedStories  = existing.stories.map(s => patchedById.get(s.id) ?? s);
  const mergedSegments = (existing.segments ?? []).map(s => patchedSegById.get(s.id) ?? s);

  const updatedBriefing: DailyBriefing = {
    ...existing,
    stories:     mergedStories,
    segments:    mergedSegments,
    generatedAt: new Date().toISOString(),
  };

  await saveBriefing(updatedBriefing);
  log(`TTS patch done: ${patched.filter(s => s.audioUrlEn).length} stories, est. $${costInfo.estimatedUsd.toFixed(2)}`);
  return { patched: patched.length, briefing: updatedBriefing };
}

// ─── Admin: patch garbled scripts ─────────────────────────────────────────────

export async function patchScripts(
  logger: Logger = () => {},
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) {
    log("No briefing found");
    return { patched: 0, briefing: { date: "", generatedAt: "", stories: [] } };
  }

  const languages  = existing.generatedLanguages ?? ["en", "hi"];
  const nonEnLangs = languages.filter(l => l !== "en");

  const needsFixup = existing.stories.filter(s =>
    nonEnLangs.some(lang => {
      const script = lang === "hi" ? s.scriptHi : lang === "ta" ? s.scriptTa : lang === "mr" ? s.scriptMr : undefined;
      return s.scriptEn && !hasExpectedScript(script, lang);
    })
  );

  log(`Script patch: ${needsFixup.length}/${existing.stories.length} stories need non-EN fix-up`);
  if (needsFixup.length === 0) {
    log("All scripts look healthy");
    return { patched: 0, briefing: existing };
  }

  const fixed       = await fixScriptLanguages(needsFixup, nonEnLangs, log);
  const fixedById   = new Map(fixed.map(s => [s.id, s]));
  const mergedStories = existing.stories.map(s => fixedById.get(s.id) ?? s);

  const updatedBriefing: DailyBriefing = {
    ...existing,
    stories:     mergedStories,
    generatedAt: new Date().toISOString(),
  };

  await saveBriefing(updatedBriefing);
  log(`Script patch done: ${fixed.length} stories updated`);
  return { patched: fixed.length, briefing: updatedBriefing };
}
