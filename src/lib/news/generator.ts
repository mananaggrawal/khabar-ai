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
};

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_WPM = 150;

const TOP_STORIES_MIN  = 4;
const TOP_STORIES_MAX  = 5;
const TOP_STORIES_THRESHOLD = 6.5;

// Section slots: min/max stories per section + minimum importance score to qualify
const SECTION_SLOTS: Partial<Record<SectionId, { min: number; max: number; threshold: number }>> = {
  india:         { min: 2, max: 4, threshold: 4.0 },
  world:         { min: 2, max: 4, threshold: 4.0 },
  business:      { min: 1, max: 3, threshold: 4.0 },
  technology:    { min: 1, max: 2, threshold: 3.5 },
  sports:        { min: 1, max: 2, threshold: 3.0 },
  health:        { min: 0, max: 1, threshold: 3.0 },
  entertainment: { min: 0, max: 1, threshold: 3.0 },
  science:       { min: 0, max: 1, threshold: 3.0 },
  local:         { min: 0, max: 1, threshold: 3.0 },
};

const SECTION_ORDER: SectionId[] = [
  "india", "world", "business", "technology", "sports",
  "health", "entertainment", "science", "local",
];

const MAX_TOTAL_STORIES = 20;

// ─── Gemini helpers ───────────────────────────────────────────────────────────

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
const GEMINI_MAX_RETRIES   = 3;
const GEMINI_MAX_TIMEOUTS  = 1;
const GEMINI_BASE_DELAY_MS = 5_000;
const GEMINI_TIMEOUT_MS    = 90_000;

async function geminiJson(prompt: string): Promise<any> {
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
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        lastError = new Error(`Gemini ${res.status}: ${body}`);
        if (RETRYABLE_STATUSES.has(res.status)) continue;
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

async function clusterSection(
  sectionStories: Story[],
  sectionId: SectionId,
  logger: Logger,
): Promise<ClusteredEvent[]> {
  if (sectionStories.length === 0) return [];

  const label       = FEED_MAP.get(sectionId)?.label ?? sectionId;
  const isHeadlines = sectionId === "headlines";

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

    const covered       = new Set<number>();
    const emittedTitles = new Set<string>();
    const events: ClusteredEvent[] = [];

    for (const g of groups) {
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

      // For headlines feed, inherit the best matching non-headlines section
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
      if (covered.has(i)) continue;
      const s = sectionStories[i];
      const nonHLSection = s.section !== "headlines" ? s.section : "india";
      events.push({
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
      });
    }

    return events;
  } catch (err: any) {
    logger(`  ✗ cluster ${sectionId}: ${err.message?.slice(0, 80)} — each article = 1 event`);
    return sectionStories.map(s => {
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
        inHeadlinesFeed:   sectionId === "headlines",
      };
    });
  }
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

  logger(`Clustering ${rawStories.length} stories across ${bySection.size} sections…`);
  const allEvents: ClusteredEvent[] = [];

  for (const [sectionId, stories] of bySection) {
    if (isAbortRequested()) { logger("⛔ Aborted"); break; }
    const emoji = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    logger(`  ${emoji} ${sectionId}: ${stories.length} articles…`);
    const events = await clusterSection(stories, sectionId, logger);
    logger(`    → ${events.length} events`);
    allEvents.push(...events);
  }

  const deduped = dedupeEvents(allEvents);
  logger(`Clustering complete — ${allEvents.length} raw events → ${deduped.length} after cross-section dedup`);
  return deduped;
}

// ─── Step 5: Batch importance scoring ─────────────────────────────────────────

async function scoreEvents(
  events: ClusteredEvent[],
  logger: Logger,
): Promise<ClusteredEvent[]> {
  if (events.length === 0) return [];

  logger(`Scoring ${events.length} events (1 batch Gemini call)…`);

  const eventList = events.map((ev, i) =>
    `${i}. [${ev.section}] [${ev.publisherCount}pub] ${ev.canonicalTitle}` +
    (ev.inHeadlinesFeed ? " ★" : "")
  ).join("\n");

  const prompt = `You are Khabar AI's editorial director. Score each news event by civic importance for an average Indian listener.

SCORING GUIDE (0-10):
10 = Every Indian is directly affected right now (budget, election result, major disaster)
8-9 = Major event shaping this week's national narrative
6-7 = Significant; informed citizens should know
4-5 = Relevant but not urgent
2-3 = Niche, regional, or low-stakes
0-1 = Entertainment/celebrity with no civic significance

★ = Appeared on Google News homepage (add 0.5 bonus)

Compare events against each other — scores should reflect relative importance.

MANDATORY COVERAGE — set mustInclude: true for these regardless of score:
• Any decision, statement, or action by the PM, Cabinet, or President of India
• Supreme Court judgments affecting public life
• Union Budget announcements or major fiscal policy
• Natural disasters with casualties (earthquake, cyclone, major floods)
• Terror attacks or major security incidents in India or involving Indians
• RBI policy decisions (repo rate, monetary policy committee)
• National or state election results
• Major airline crashes or industrial disasters
• Pandemic or health emergency declarations
Use your judgment — when in doubt, set mustInclude: false and let the score decide.

Return a JSON array (same order as input, ${events.length} items):
[{"importance": 7.5, "reason": "one clear sentence", "confidence": "high", "breaking": false, "mustInclude": false}]

Events:
${eventList}`;

  try {
    const results: Array<{ importance: number; reason: string; confidence: string; breaking: boolean; mustInclude: boolean }> =
      await geminiJson(prompt);

    if (!Array.isArray(results) || results.length < events.length * 0.8) {
      throw new Error(`Unexpected result length: ${results?.length} for ${events.length} events`);
    }

    return events.map((ev, i) => {
      const r = results[i] ?? { importance: 3, reason: "No score returned", confidence: "low", mustInclude: false };
      const mustInclude = Boolean(r.mustInclude);
      return {
        ...ev,
        importanceScore:   Math.max(0, Math.min(10, Number(r.importance) || 3)),
        importanceReason:  String(r.reason ?? "").slice(0, 200),
        forcedByEditorial: mustInclude,
      };
    });
  } catch (err: any) {
    logger(`  ✗ Scoring failed: ${err.message?.slice(0, 80)} — fallback to publisher count`);
    return events.map(ev => ({
      ...ev,
      importanceScore:  Math.min(9, ev.publisherCount * 1.5 + (ev.inHeadlinesFeed ? 1 : 0)),
      importanceReason: `Scored by publisher coverage (${ev.publisherCount} publishers)`,
    }));
  }
}

// ─── Step 7: Briefing plan ────────────────────────────────────────────────────

function buildBriefingPlan(events: ClusteredEvent[], logger: Logger): ClusteredEvent[] {
  const sorted = [...events].sort((a, b) => b.importanceScore - a.importanceScore);
  const used   = new Set<string>();
  const plan:  ClusteredEvent[] = [];

  // 1. Force editorial overrides into top stories
  for (const ev of sorted) {
    if (!ev.forcedByEditorial) continue;
    if (plan.length >= TOP_STORIES_MAX) break;
    ev.assignedSection = "headlines";
    plan.push(ev);
    used.add(ev.eventId);
  }

  // 2. Fill top stories with highest-scoring events
  for (const ev of sorted) {
    if (used.has(ev.eventId)) continue;
    if (plan.length >= TOP_STORIES_MAX) break;
    if (ev.importanceScore >= TOP_STORIES_THRESHOLD) {
      ev.assignedSection = "headlines";
      plan.push(ev);
      used.add(ev.eventId);
    }
  }

  // Ensure minimum top stories count even if scores are low
  for (const ev of sorted) {
    if (used.has(ev.eventId)) continue;
    if (plan.length >= TOP_STORIES_MIN) break;
    ev.assignedSection = "headlines";
    plan.push(ev);
    used.add(ev.eventId);
  }

  // 3. Fill section slots
  for (const sectionId of SECTION_ORDER) {
    const slot = SECTION_SLOTS[sectionId];
    if (!slot) continue;

    const sectionEvents = sorted
      .filter(ev => !used.has(ev.eventId) && ev.section === sectionId && ev.importanceScore >= slot.threshold)
      .slice(0, slot.max);

    for (const ev of sectionEvents) {
      ev.assignedSection = sectionId;
      plan.push(ev);
      used.add(ev.eventId);
    }

    if (sectionEvents.length < slot.min) {
      logger(`  ⚠ ${sectionId}: ${sectionEvents.length}/${slot.min} min (threshold ${slot.threshold})`);
    }
  }

  const final = plan.slice(0, MAX_TOTAL_STORIES);

  const bySection = new Map<string, number>();
  for (const ev of final) bySection.set(ev.assignedSection, (bySection.get(ev.assignedSection) ?? 0) + 1);
  logger(`Briefing plan: ${final.length} events`);
  for (const [section, count] of bySection) logger(`  ${section}: ${count}`);

  return final;
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

  const jsonShape = `[{"title":"...","titleHi":"..."${extraTitleFields ? "," + extraTitleFields : ""},"scriptEn":"...","scriptHi":"..."${extraScriptFields ? "," + extraScriptFields : ""}}]`;

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  const eventsPayload = sectionEvents.map((ev, i) => {
    const sources = ev.sourceStories.slice(0, 4).map(s => {
      const desc = s.description
        ?.replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      return `  [${s.source}] ${s.title}${desc ? `\n   → ${desc}` : ""}`;
    }).join("\n");
    return `${i}. ${ev.canonicalTitle} (${ev.publisherCount} publishers)\n${sources}`;
  }).join("\n\n");

  const prompt = `You are Khabar AI — India's voice-first news briefing. Today: ${today}.
Section: "${label}" (${sectionEvents.length} events to script)

Write one spoken-audio script per event. These will be read aloud by a professional voice.

━━━ SCRIPT STRUCTURE — follow EXACTLY ━━━

1. HOOK (1 sentence, ~20 words)
   Make the listener lean in immediately. State the stakes or surprising angle.
   NEVER start with: "Today", "In a", "According to", "The", "India's", "A new"
   ✓ "Your home loan EMI stays exactly where it is for now."
   ✓ "India and China may be closer to a border deal than most people think."
   ✓ "The price of something millions of Indians eat every day just fell significantly."

2. WHAT HAPPENED (2-3 sentences)
   Every relevant number, name, percentage, date. Be precise and specific.
   No vagueness. No hedging. State what is known as fact.

3. WHY IT MATTERS (1-2 sentences)
   Connect to the listener's life. Stakes for an average Indian.

4. WHAT'S NEXT (1 sentence)
   Forward-looking. What to watch for. Makes the story feel alive, not closed.

━━━ WRITING RULES ━━━
• WORD COUNT: 130-160 words per script. Shorter is a mistake — use the full range.
• SENTENCES: Never exceed 18 words. Mix short punchy with medium-length for rhythm.
• VOICE: Conversational but authoritative. Sharp friend who read everything so you didn't have to.
• NEVER: "reportedly", "it is said", "details are unclear", "sources say", "according to"
• NEVER: bullet points, lists, parentheses, em-dashes mid-sentence
• NEVER: invent facts. If information is thin, make the known facts vivid — don't pad.
• ALWAYS: full natural sentences. Flowing spoken rhythm. No cliffhangers.

━━━ TRANSLATIONS ━━━
${langRules}
• Keep proper nouns, brand names, acronyms, and numbers in their original form.
• NEVER use Roman letters for native-language words.
• Each translation is a complete spoken script — same structure, native script only.

Return JSON array only (${sectionEvents.length} objects):
${jsonShape}

Events:
${eventsPayload}`;

  try {
    const results: ScriptedEvent[] = await geminiJson(prompt);
    if (!Array.isArray(results) || results.length === 0) throw new Error("empty result");

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

    const scripted = await scriptEventBatch(events, sectionId, logger, languages);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
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
  }

  const nonEnLangs = languages.filter(l => l !== "en");
  const fixed = await fixScriptLanguages(stories, nonEnLangs, logger);
  logger(`Scripting done — ${fixed.length} stories`);
  return fixed;
}

// ─── Step 9: Briefing wrapper ─────────────────────────────────────────────────

function makeOpeningScript(): { en: string; hi: string; ta: string; mr: string } {
  const now     = new Date();
  const dayName = now.toLocaleDateString("en-IN", { weekday: "long",  timeZone: "Asia/Kolkata" });
  const dateStr = now.toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });
  return {
    en: `Good morning. Today is ${dayName}, ${dateStr}. Here's everything important that happened in the last twenty-four hours.`,
    hi: `सुप्रभात। आज ${dayName} है, ${dateStr}। पिछले चौबीस घंटों में जो महत्वपूर्ण हुआ, वह यहाँ है।`,
    ta: `காலை வணக்கம். இன்று ${dayName}, ${dateStr}. கடந்த இருபத்து நான்கு மணி நேரத்தில் நடந்த முக்கியமான செய்திகள் இங்கே.`,
    mr: `शुभ प्रभात. आज ${dayName} आहे, ${dateStr}. गेल्या चोवीस तासांत जे महत्त्वाचे घडले ते येथे आहे.`,
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

    // Google RPM guard
    if (provider === "google" && i < stories.length - 1) {
      await new Promise(r => setTimeout(r, 6_000));
    }
  }

  const totalChars = enChars + hiChars + taChars + mrChars;
  // ElevenLabs Flash v2.5: ~$0.30/1K chars; Google: negligible; Edge/Kokoro: free
  const estimatedUsd =
    provider === "elevenlabs" ? (totalChars / 1000) * 0.30 :
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
