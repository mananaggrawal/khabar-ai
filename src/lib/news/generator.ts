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
import { edgeTTS } from "@/lib/tts/edge";
import { kokoroTTS } from "@/lib/tts/kokoro";
import { saveBriefingToStorage, loadBriefingFromStorage } from "@/lib/supabase-storage";
import { isAbortRequested } from "@/lib/abort";

export type TtsProvider = "google" | "elevenlabs" | "edge" | "kokoro";

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
  titleHi?: string;        // Hindi title — shown in UI when language = "hi"
  titleTa?: string;        // Tamil title
  titleMr?: string;        // Marathi title
  source: string;
  link: string;
  publishedAt: string;
  section: SectionId;
  imageUrl?: string;
  description?: string;   // RSS snippet — used by Gemini to write richer scripts
  sources?: StorySource[]; // all raw articles that were merged into this story
  scriptEn: string;
  scriptHi: string;
  scriptTa?: string;       // Tamil script
  scriptMr?: string;       // Marathi script
  audioUrlEn?: string;
  audioUrlHi?: string;
  audioUrlTa?: string;     // Tamil audio
  audioUrlMr?: string;     // Marathi audio
  audioStartSec?: number; // always 0 — kept for compatibility with player
};

export type DailyBriefing = {
  date: string;
  generatedAt: string;
  stories: Story[];
  generatedLanguages?: string[];  // which languages TTS was generated for
};

export type Logger = (msg: string) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_WPM   = 150;  // average reading/speech rate
const TARGET_MINS  = 30;   // soft cap — secondary sections trimmed only if well over this


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

// Retryable status codes: 429 (rate limit), 500, 502, 503, 504 (transient server errors)
const RETRYABLE_STATUSES  = new Set([429, 500, 502, 503, 504]);
const GEMINI_MAX_RETRIES  = 3;      // for HTTP errors (rate limit, server error)
const GEMINI_MAX_TIMEOUTS = 1;      // only 1 retry on hang — fail fast, don't block the run
const GEMINI_BASE_DELAY_MS = 5_000; // 5s → 10s → 20s
const GEMINI_TIMEOUT_MS   = 60_000; // 60s per attempt — Gemini Flash responds in <30s normally

async function geminiJson(prompt: string): Promise<any> {
  let lastError: Error | null = null;
  let timeouts = 0;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = GEMINI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[gemini] retry ${attempt}/${GEMINI_MAX_RETRIES} after ${delayMs / 1000}s (${lastError?.message?.slice(0, 60)})`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);

    try {
      const res = await fetch(GEMINI_URL(getKey()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 16384,
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
      const finishReason = json.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") {
        console.warn(`[gemini] finishReason=${finishReason}`);
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      return parseGeminiJson(text);
    } catch (err: any) {
      if (err.name === "AbortError") {
        timeouts++;
        lastError = new Error(`Gemini timed out after ${GEMINI_TIMEOUT_MS / 1000}s (timeout ${timeouts}/${GEMINI_MAX_TIMEOUTS + 1})`);
        console.warn(`[gemini] attempt ${attempt} timed out`);
        if (timeouts > GEMINI_MAX_TIMEOUTS) throw lastError; // give up fast after 2 timeouts
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Gemini request failed after retries");
}

// ─── Step 1: Fetch all feeds ──────────────────────────────────────────────────

async function fetchAllFeeds(city: string): Promise<Map<SectionId, RssItem[]>> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const url = feed.buildUrl({ city });
      let items = await fetchRss(url, feed.label, feed.id);
      // If primary URL returned nothing and a fallback exists, try it
      if (items.length === 0 && feed.fallbackUrl) {
        console.warn(`[feeds] ${feed.label}: topic URL returned 0 — trying fallback URL`);
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

// Real Chrome UA — Googlebot gets blocked or served bot-challenge pages on most Indian news sites
const FETCH_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

async function fetchOgImage(url: string): Promise<string | undefined> {
  const ctrl  = new AbortController();
  // Single timer covers the ENTIRE request (connect + headers + body read)
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
    // Read up to 40KB — enough to clear verbose <head> sections on Indian news sites
    while (total < 40_000) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    // Abort to cleanly close the connection (better than reader.cancel())
    ctrl.abort();
    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => { const a = new Uint8Array(acc.length + c.length); a.set(acc); a.set(c, acc.length); return a; }, new Uint8Array(0))
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
  liveMap?: Map<string, string>,  // optional shared map populated as images arrive
): Promise<Story[]> {
  logger(`Fetching OG images for ${stories.length} stories (10 concurrent)…`);
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
          liveMap?.set(story.id, img);   // make available to concurrent scripting saves
        }
      }),
    );
  }

  const withImages = updated.filter((s) => s.imageUrl).length;
  logger(`OG images: ${withImages}/${stories.length} fetched`);
  return updated;
}

// Build the best possible fallback script from raw RSS fields (no Gemini)
function fallbackScript(s: Story): string {
  const desc = s.description
    ?.replace(/<[^>]+>/g, "")   // strip HTML tags
    .replace(/&nbsp;/gi, " ")   // decode &nbsp; in case description came from an older briefing
    .replace(/&#160;/g, " ")
    .replace(/  +/g, " ")       // collapse double-spaces
    .replace(/\s+/g, " ")
    .trim();
  // Google News descriptions are a list of article titles — not useful as a summary.
  // Detect by: very few periods but many distinct source-name-like segments.
  const isArticleList = desc
    ? (desc.match(/\s{1,}[A-Z][a-z]+ [A-Z][a-z]+\s/g) ?? []).length > 2 && !desc.includes(".")
    : false;
  if (desc && desc.length > 40 && !isArticleList) {
    // Combine title + description into a readable sentence
    const titleClean = s.title.replace(/\s*[-–|].*$/, "").trim(); // strip source suffix
    const descTrimmed = desc.slice(0, 220).trim();
    // Avoid repeating the title verbatim in the description
    const descStart = descTrimmed.toLowerCase().startsWith(titleClean.toLowerCase().slice(0, 20))
      ? descTrimmed
      : `${titleClean}. ${descTrimmed}`;
    return descStart.endsWith(".") || descStart.endsWith("?") || descStart.endsWith("!")
      ? descStart
      : `${descStart}.`;
  }
  // Last resort: use cleaned title (strip " – Source" suffix common in Google News)
  const cleanTitle = s.title.replace(/\s*[-–|]\s*[^-–|]{1,40}$/, "").trim();
  return `${cleanTitle}.`;
}

// ─── Step 3: Script stories — merge duplicates, keep distinct ones separate ───
//
// One Gemini call for all stories in a section.
// Stories covering the same event are merged into one group; distinct ones stay separate.
// No group cap — Gemini decides what's truly the same story.
// Target: 50-70 words per group, capturing key facts, numbers, and metrics.

// ── Script language validation ────────────────────────────────────────────────
// Checks that a text field is actually written in the expected unicode block.

const SCRIPT_RE: Record<string, RegExp> = {
  hi: /[ऀ-ॿ]/,  // Devanagari
  mr: /[ऀ-ॿ]/,  // Devanagari (Marathi)
  ta: /[஀-௿]/,  // Tamil
};

function hasExpectedScript(text: string | undefined, lang: string): boolean {
  if (!text || text.trim().length < 3) return false;
  const re = SCRIPT_RE[lang];
  return re ? re.test(text) : true; // EN has no unicode block requirement
}

// Language metadata used for prompt construction and fix-up calls
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

// ── Fix-up pass: re-translate any scripts that came back in the wrong language ──
//
// Called after Gemini returns. For any story where a non-EN script field is
// empty or lacks the expected unicode block, we run one targeted Gemini call
// per batch of broken stories to get the correct native-script translation.

async function fixScriptLanguages(
  stories: Story[],
  nonEnLangs: string[],
  logger: Logger,
): Promise<Story[]> {
  if (nonEnLangs.length === 0) return stories;

  // Find stories that need any non-EN field fixed
  const toFix = stories
    .map((s, idx) => {
      const missingLangs = nonEnLangs.filter(lang => {
        const script = lang === "hi" ? s.scriptHi :
                       lang === "ta" ? s.scriptTa :
                       lang === "mr" ? s.scriptMr : undefined;
        return !hasExpectedScript(script, lang);
      });
      return missingLangs.length > 0 ? { idx, story: s, missingLangs } : null;
    })
    .filter(Boolean) as Array<{ idx: number; story: Story; missingLangs: string[] }>;

  if (toFix.length === 0) return stories;
  logger(`  ⚙ Re-translating ${toFix.length} stories with missing/wrong-script fields…`);

  const updated = stories.map(s => ({ ...s }));

  // Batch all broken stories into one Gemini call
  const batchLangs = [...new Set(toFix.flatMap(x => x.missingLangs))];
  const langDescs = batchLangs.map(lang => {
    const m = LANG_META[lang]!;
    return `- ${lang.toUpperCase()} (${m.name}): ${m.scriptNote} Example: "${m.example}"`;
  }).join("\n");

  const storiesPayload = toFix.map((x, i) =>
    `${i}. title: "${x.story.title}"\n   scriptEn: "${x.story.scriptEn}"\n   needs: ${x.missingLangs.join(", ")}`
  ).join("\n");

  const prompt = `Translate these news scripts into the specified Indian languages.
Each translation MUST use the native script characters — never Roman transliteration.

LANGUAGE RULES:
${langDescs}

Return a JSON array with one object per story (same order), containing only the fields needed:
[${toFix.map(x => `{${x.missingLangs.flatMap(l => [`"script${l.charAt(0).toUpperCase() + l.slice(1)}":"..."`, `"title${l.charAt(0).toUpperCase() + l.slice(1)}":"..."`]).join(",")}}`).join(",")}]

Stories:
${storiesPayload}`;

  try {
    const results: any[] = await geminiJson(prompt);
    if (!Array.isArray(results)) throw new Error("not an array");

    for (let i = 0; i < toFix.length && i < results.length; i++) {
      const { idx, missingLangs } = toFix[i];
      const r = results[i] ?? {};
      for (const lang of missingLangs) {
        const sKey = `script${lang.charAt(0).toUpperCase() + lang.slice(1)}` as keyof Story;
        const tKey = `title${lang.charAt(0).toUpperCase() + lang.slice(1)}`  as keyof Story;
        const newScript = r[sKey as string];
        const newTitle  = r[tKey as string];
        if (hasExpectedScript(newScript, lang)) {
          (updated[idx] as any)[sKey] = newScript;
          logger(`    ✓ ${lang.toUpperCase()} fixed: ${updated[idx].title.slice(0, 45)}`);
        } else {
          logger(`    ✗ ${lang.toUpperCase()} still wrong-script — skipping audio for this story`);
        }
        if (newTitle && hasExpectedScript(newTitle, lang)) {
          (updated[idx] as any)[tKey] = newTitle;
        }
      }
    }
  } catch (err: any) {
    logger(`  ✗ Script fix-up Gemini call failed: ${err.message?.slice(0, 80)}`);
    // Leave stories as-is — they'll have empty non-EN scripts, so no audio generated
  }

  return updated;
}

interface ScriptedGroup {
  title:         string;
  titleHi:       string;
  titleTa?:      string;
  titleMr?:      string;
  scriptEn:      string;
  scriptHi:      string;
  scriptTa?:     string;
  scriptMr?:     string;
  sourceIndices: number[];
}

async function scriptBatch(
  sectionStories: Story[],
  sectionId: SectionId,
  logger: Logger = () => {},
  languages: string[] = ["en", "hi"],
): Promise<Story[]> {
  if (sectionStories.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const label = FEED_MAP.get(sectionId)?.label ?? sectionId;

  const withTa = languages.includes("ta");
  const withMr = languages.includes("mr");
  const nonEnLangs = languages.filter(l => l !== "en");

  // Build per-language script rules with explicit unicode mandate
  const langScriptRules = [
    `- scriptHi, titleHi: ${LANG_META.hi.scriptNote} Example script: "${LANG_META.hi.example}"`,
    withTa ? `- scriptTa, titleTa: ${LANG_META.ta.scriptNote} Example script: "${LANG_META.ta.example}"` : "",
    withMr ? `- scriptMr, titleMr: ${LANG_META.mr.scriptNote} Example script: "${LANG_META.mr.example}"` : "",
  ].filter(Boolean).join("\n");

  const extraLangFields = [
    withTa ? `"titleTa":"...","scriptTa":"..."` : "",
    withMr ? `"titleMr":"...","scriptMr":"..."` : "",
  ].filter(Boolean).join(",");

  const jsonExample = `[{"title":"...","titleHi":"..."${extraLangFields ? "," + extraLangFields : ""},"scriptEn":"...","scriptHi":"..."${withTa ? `,"scriptTa":"..."` : ""}${withMr ? `,"scriptMr":"..."` : ""},"sourceIndices":[0,2]}]`;

  const prompt = `You are Khabar AI — India's sharpest spoken-audio news editor. Today: ${today}.
Section: "${label}" (${sectionStories.length} stories).

YOUR JOB:
1. GROUPING: Merge stories only if they cover the exact same event or announcement. Different topics — even loosely related — stay in separate groups. When in doubt, keep separate.
2. SCRIPT: Write one crisp, engaging 70-100 word spoken-audio script per group.

SCRIPT RULES (scriptEn):
- 70-100 words. Conversational but authoritative — like a sharp friend who just read everything so you don't have to.
- Open with the most gripping fact or the "why this matters" angle. Never start with "In a...", "According to...", "Today,", or a restatement of the headline.
- Weave in every number, figure, percentage, and named person or place — these make the story real.
- Vary sentence length: mix short punchy sentences with longer ones for natural spoken rhythm.
- Close with one sentence of context — what this means, what to watch next, or what's at stake.
- Never hedge with "details are unclear", "reportedly", or "it is said". State what is known as fact; omit what isn't.
- Do NOT invent facts. If information is thin, make the known facts vivid — don't pad with filler phrases.

SCRIPT LANGUAGE REQUIREMENTS — STRICTLY ENFORCED:
${langScriptRules}
- Keep English names, brands, numbers (digits) in their original form across all languages.
- titleHi/titleTa/titleMr: natural translation of the English title — MUST use the native script.

CRITICAL: Every index 0–${sectionStories.length - 1} must appear in exactly one group's sourceIndices.

Return JSON array only:
${jsonExample}

Stories:
${sectionStories.map((s, i) => {
    const desc = s.description?.replace(/\s+/g, " ").trim().slice(0, 300);
    return `${i}. [${s.source}] ${s.title}${desc ? `\n   → ${desc}` : ""}`;
  }).join("\n")}`;

  try {
    const result: ScriptedGroup[] = await geminiJson(prompt);
    if (!Array.isArray(result) || result.length === 0) throw new Error("empty result");

    const covered = new Set<number>();
    for (const g of result) (g.sourceIndices ?? []).forEach(i => covered.add(i));

    const output: Story[] = [];

    for (const group of result) {
      const indices = (group.sourceIndices ?? []).filter(i => i >= 0 && i < sectionStories.length);
      if (indices.length === 0) continue;

      const primaryIdx = indices.find(i => sectionStories[i]?.imageUrl) ?? indices[0];
      const primary    = sectionStories[primaryIdx];
      const sources: StorySource[] = indices.map(i => ({
        title:  sectionStories[i].title,
        source: sectionStories[i].source,
        link:   sectionStories[i].link,
      }));

      // Validate each non-EN script: discard if it's not in the expected unicode block
      const safeHi = hasExpectedScript(group.scriptHi, "hi")  ? group.scriptHi  : undefined;
      const safeTa = hasExpectedScript(group.scriptTa, "ta")  ? group.scriptTa  : undefined;
      const safeMr = hasExpectedScript(group.scriptMr, "mr")  ? group.scriptMr  : undefined;
      const safeTitleHi = hasExpectedScript(group.titleHi, "hi") ? group.titleHi : undefined;
      const safeTitleTa = hasExpectedScript(group.titleTa, "ta") ? group.titleTa : undefined;
      const safeTitleMr = hasExpectedScript(group.titleMr, "mr") ? group.titleMr : undefined;

      output.push({
        ...primary,
        title:    group.title    || primary.title,
        titleHi:  safeTitleHi,
        titleTa:  safeTitleTa,
        titleMr:  safeTitleMr,
        sources,
        scriptEn: group.scriptEn || `${primary.title}.`,
        scriptHi: safeHi  ?? "",   // empty = no Hindi audio generated
        scriptTa: safeTa  ?? undefined,
        scriptMr: safeMr  ?? undefined,
        audioUrlEn:   undefined,
        audioUrlHi:   undefined,
        audioUrlTa:   undefined,
        audioUrlMr:   undefined,
        audioStartSec: 0,
      });
    }

    // Any uncovered → stub (EN only; non-EN left empty until fix-up pass)
    for (let i = 0; i < sectionStories.length; i++) {
      if (covered.has(i)) continue;
      const s = sectionStories[i];
      logger(`    ⚠ ${sectionId}[${i}] not in any group — adding standalone`);
      output.push({
        ...s,
        sources:  [{ title: s.title, source: s.source, link: s.link }],
        scriptEn: fallbackScript(s),
        scriptHi: "",
        audioStartSec: 0,
      });
    }

    // Fix-up pass: stories where Gemini returned English in a non-English field
    const fixed = await fixScriptLanguages(output, nonEnLangs, logger);
    return fixed;
  } catch (err: any) {
    logger(`  ✗ ${sectionId} Gemini script failed: ${err.message?.slice(0, 120)} — using fallback stubs`);
    return sectionStories.map(s => ({
      ...s,
      sources:  [{ title: s.title, source: s.source, link: s.link }],
      scriptEn: fallbackScript(s),
      scriptHi: "",   // empty — no Hindi audio rather than English audio
      audioStartSec: 0,
    }));
  }
}

async function scriptAllStories(
  stories: Story[],
  logger: Logger,
  onSectionDone?: (scripted: Story[]) => Promise<void>,
  languages: string[] = ["en", "hi"],
): Promise<Story[]> {
  if (stories.length === 0) return [];

  // Group by section, process each with one Gemini call
  const bySection = new Map<SectionId, Story[]>();
  for (const story of stories) {
    const arr = bySection.get(story.section) ?? [];
    arr.push(story);
    bySection.set(story.section, arr);
  }

  const sectionOrder: SectionId[] = [
    ...PRIORITY_SECTIONS.filter(id => bySection.has(id)),
    ...[...bySection.keys()].filter(id => !PRIORITY_SECTIONS.includes(id)),
  ];

  logger(`Scripting ${stories.length} stories across ${bySection.size} sections… (langs: ${languages.join(",")})`);

  const all: Story[] = [];

  for (const sectionId of sectionOrder) {
    if (isAbortRequested()) { logger("⛔ Aborted"); break; }
    const sectionStories = bySection.get(sectionId)!;
    const emoji = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    logger(`  ${emoji} ${sectionId}: ${sectionStories.length} raw stories…`);

    const scripted = await scriptBatch(sectionStories, sectionId, logger, languages);
    all.push(...scripted);
    logger(`    → ${scripted.length} stories`);

    if (onSectionDone) await onSectionDone([...all]);
  }

  logger(`Scripting done — ${all.length} stories total`);
  return all;
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

export type TtsCostInfo = {
  provider: TtsProvider;
  enChars: number;
  hiChars: number;
  totalChars: number;
  /** Rough cost in USD (ElevenLabs: $0.50/1K chars; Google: $0.50/1M chars after free tier) */
  estimatedUsd: number;
  storiesAttempted: number;
  storiesWithAudio: number;
};

// Map from lang code to Story audio URL field
function getStoryScript(story: Story, lang: string): string | undefined {
  if (lang === "en") return story.scriptEn;
  if (lang === "hi") return story.scriptHi;
  if (lang === "ta") return story.scriptTa;
  if (lang === "mr") return story.scriptMr;
  return undefined;
}

function setStoryAudioUrl(story: Story, lang: string, url: string): void {
  if (lang === "en") { story.audioUrlEn = url; story.audioStartSec = 0; }
  else if (lang === "hi") story.audioUrlHi = url;
  else if (lang === "ta") story.audioUrlTa = url;
  else if (lang === "mr") story.audioUrlMr = url;
}

async function generateAllTTS(
  stories: Story[],
  date: string,
  provider: TtsProvider,
  logger: Logger,
  onStoryDone?: (stories: Story[]) => Promise<void>,
  languages: string[] = ["en", "hi"],
): Promise<{ stories: Story[]; costInfo: TtsCostInfo }> {
  const updated = stories.map(s => ({ ...s }));
  const label   = provider === "google" ? "Google" : provider === "elevenlabs" ? "ElevenLabs" : provider === "edge" ? "Edge" : "Kokoro";
  let enChars = 0;
  let hiChars = 0;
  let storiesWithAudio = 0;

  logger(`TTS (${label}): ${stories.length} stories × ${languages.length} languages [${languages.join(",")}] = ${stories.length * languages.length} calls…`);

  const synthesize = async (script: string, filename: string): Promise<string> => {
    if (provider === "google")     { const { url } = await googleTTS(script, filename);     return url; }
    if (provider === "elevenlabs") { const { url } = await elevenLabsTTS(script, filename);  return url; }
    if (provider === "edge")       { const { url } = await edgeTTS(script, filename);        return url; }
    if (provider === "kokoro")     { const { url } = await kokoroTTS(script, filename);      return url; }
    throw new Error(`Unknown TTS provider: ${provider}`);
  };

  for (let i = 0; i < stories.length; i++) {
    if (isAbortRequested()) { logger("⛔ Aborted by stop request"); break; }
    if (provider === "google"     && isDailyQuotaExhausted()) { logger("⛔ Google TTS daily quota exhausted"); break; }
    if (provider === "elevenlabs" && isQuotaExhausted())      { logger("⛔ ElevenLabs quota exhausted — top up credits to continue."); break; }

    const story    = stories[i];
    const fileBase = `${date}-${story.id}`;
    let gotAny = false;

    for (const lang of languages) {
      if (isAbortRequested()) break;
      if (provider === "google"     && isDailyQuotaExhausted()) break;
      if (provider === "elevenlabs" && isQuotaExhausted())      break;

      // Kokoro only supports EN
      if (provider === "kokoro" && lang !== "en") continue;
      // Google TTS only supports EN and HI in this pipeline
      if (provider === "google" && lang !== "en" && lang !== "hi") continue;
      // ElevenLabs only supports EN and HI
      if (provider === "elevenlabs" && lang !== "en" && lang !== "hi") continue;

      const script = getStoryScript(story, lang);
      if (!script) continue;

      try {
        const url = await synthesize(script, `${fileBase}-${lang}`);
        setStoryAudioUrl(updated[i], lang, url);
        if (lang === "en") enChars += script.length;
        else if (lang === "hi") hiChars += script.length;
        gotAny = true;
      } catch (err: any) {
        logger(`  ✗ ${lang.toUpperCase()} [${i + 1}/${stories.length}]: ${err.message?.slice(0, 80)}`);
      }
    }

    if (gotAny) {
      storiesWithAudio++;
      logger(`  ✓ [${i + 1}/${stories.length}] ${story.title.slice(0, 55)}`);
    } else {
      logger(`  ⚠ [${i + 1}/${stories.length}] no audio — ${story.title.slice(0, 45)}`);
    }
    if (onStoryDone) await onStoryDone([...updated]);

    // Proactive inter-call delay for Google to stay under RPM limit (~10 RPM on preview model)
    if (provider === "google" && i < stories.length - 1) {
      await new Promise(r => setTimeout(r, 6_000));
    }
  }

  const totalChars = enChars + hiChars;
  // ElevenLabs Flash v2.5: ~$0.50/1K chars; Google: $0.50/1M chars; Edge/Kokoro: free
  const estimatedUsd =
    provider === "elevenlabs" ? (totalChars / 1000) * 0.50 :
    provider === "google"     ? (totalChars / 1_000_000) * 0.50 :
    0;

  const costInfo: TtsCostInfo = { provider, enChars, hiChars, totalChars, estimatedUsd, storiesAttempted: stories.length, storiesWithAudio };
  logger(`TTS done: ${storiesWithAudio}/${stories.length} stories, ${(totalChars / 1000).toFixed(1)}K chars, est. $${estimatedUsd.toFixed(2)}`);

  return { stories: updated, costInfo };
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

export type RunSummary = {
  elapsedSec: number;
  fetchSec: number;
  clubSec: number;
  ttsSec: number;
  stories: number;
  tts: TtsCostInfo;
};

export async function generateDailyBriefing(
  logger: Logger = () => {},
  city = DEFAULT_CITY,
  ttsProvider: TtsProvider = "google",
  languages: string[] = ["en", "hi"],
): Promise<DailyBriefing & { runSummary?: RunSummary }> {
  const runStart = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const log  = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  log(`Starting briefing for ${date} (city: ${city}, TTS: ${ttsProvider}, langs: ${languages.join(",")})`);

  // Step 1: Fetch all feeds
  const t0 = Date.now();
  log(`Fetching ${FEEDS.length} Google News feeds…`);
  const feedMap  = await fetchAllFeeds(city);
  const rawTotal = [...feedMap.values()].reduce((n, v) => n + v.length, 0);
  const fetchSec = (Date.now() - t0) / 1000;
  log(`Fetched ${rawTotal} raw items from ${feedMap.size} feeds (${fetchSec.toFixed(1)}s)`);

  // Step 2: Dedup
  const rawStories = buildStories(feedMap);
  log(`After dedup: ${rawStories.length} unique stories`);
  for (const feed of FEEDS) {
    const n = rawStories.filter(s => s.section === feed.id).length;
    if (n > 0) log(`  ${feed.emoji} ${feed.label}: ${n}`);
  }

  // Steps 2b + 3 in parallel: OG images and club+script are independent.
  // Images are collected into a shared map as they arrive so partial saves
  // during scripting can include already-fetched images.
  const t1 = Date.now();
  log(`Fetching OG images and scripting in parallel…`);
  const liveImageById = new Map<string, string>(); // populated as OG fetches complete

  const [withImages, clubbed] = await Promise.all([
    // Image fetcher: fill liveImageById as each batch completes
    (async () => {
      const result = await fetchAllOgImages(rawStories, log, liveImageById);
      return result;
    })(),
    scriptAllStories(rawStories, log, async (partial) => {
      // Merge whatever images have arrived so far into the partial save
      const withLiveImages = partial.map(s =>
        s.imageUrl ? s : { ...s, imageUrl: liveImageById.get(s.id) }
      );
      await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: withLiveImages, generatedLanguages: languages });
      log(`  💾 saved ${partial.length} stories (${withLiveImages.filter(s => s.imageUrl).length} with images)`);
    }, languages),
  ]);
  const clubSec = (Date.now() - t1) / 1000;
  log(`Clubbing done in ${clubSec.toFixed(1)}s → ${clubbed.length} stories`);

  // Merge images into clubbed stories by matching id
  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  const merged = clubbed.map(s => ({
    ...s,
    imageUrl: s.imageUrl ?? imageById.get(s.id),
  }));

  // Step 4: Time guard
  const guarded = applyTimeGuard(merged, log);

  // Save after scripting (before TTS so scripts survive TTS quota failures)
  await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: guarded, generatedLanguages: languages });
  log(`Scripts done — ${guarded.length} stories, saving before TTS…`);

  // Step 5: TTS — per-story, same structure for all providers
  const t2 = Date.now();
  log(`TTS provider: ${ttsProvider} (${guarded.length} stories × ${languages.length} langs [${languages.join(",")}] = ${guarded.length * languages.length} calls)`);
  const { stories: withAudio, costInfo } = await generateAllTTS(guarded, date, ttsProvider, log, async (partialStories) => {
    await saveBriefing({ date, generatedAt: new Date().toISOString(), stories: partialStories, generatedLanguages: languages });
  }, languages);
  const ttsSec = (Date.now() - t2) / 1000;
  const elapsedSec = (Date.now() - runStart) / 1000;

  const runSummary: RunSummary = { elapsedSec, fetchSec, clubSec, ttsSec, stories: withAudio.length, tts: costInfo };

  const mins = Math.floor(elapsedSec / 60);
  const secs = Math.round(elapsedSec % 60);
  log(`✅ Done in ${mins}m ${secs}s — ${withAudio.length} stories, TTS: ${(costInfo.totalChars / 1000).toFixed(1)}K chars, est. $${costInfo.estimatedUsd.toFixed(2)}`);

  const briefing = {
    date,
    generatedAt: new Date().toISOString(),
    stories: withAudio,
    generatedLanguages: languages,
    runSummary,
  };

  await saveBriefing(briefing);
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
    scriptAllStories(newStories, log),
  ]);

  const imageById = new Map(withImages.map(s => [s.id, s.imageUrl]));
  const mergedNew = clubbedNew.map(s => ({
    ...s,
    imageUrl: s.imageUrl ?? imageById.get(s.id),
  }));

  // TTS for new stories (default to google for patch runs)
  const { stories: withAudio } = await generateAllTTS(mergedNew, existing.date, "google", log, async (partial) => {
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

// ─── Script patch ────────────────────────────────────────────────────────────
// Re-script stories where scriptEn is garbled (leftover &nbsp; from older RSS parser,
// or title-only fallbacks that never got a real Gemini script)

function isGarbledScript(s: Story): boolean {
  const script = s.scriptEn;
  if (!script || script.length < 40) return true;
  if (script.includes("&nbsp;") || script.includes("&#160;")) return true;

  // Title-only fallback: script is the story title (with optional trailing period)
  // Covers both the full title and the cleaned title (source suffix stripped)
  const scriptCore  = script.replace(/\.$/, "").trim();
  const titleFull   = s.title.trim();
  const titleClean  = titleFull.replace(/\s*[-–|]\s*[^-–|]{1,40}$/, "").trim();
  if (scriptCore === titleFull || scriptCore === titleClean) return true;
  // Catch near-matches: script starts with the title base and adds almost nothing
  if (scriptCore.startsWith(titleClean) && scriptCore.length < titleClean.length + 20) return true;

  // Article list fallback: many words but no sentence-ending punctuation at all
  const periods = (script.match(/[.!?]/g) ?? []).length;
  const words   = script.trim().split(/\s+/).length;
  if (words > 15 && periods === 0) return true;

  return false;
}

export async function patchScripts(
  logger: Logger = () => {},
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) throw new Error("No existing briefing — run full generation first");

  const badStories = existing.stories.filter(isGarbledScript);

  if (badStories.length === 0) {
    log("All scripts look clean — nothing to patch");
    return { patched: 0, briefing: existing };
  }

  log(`Found ${badStories.length} stories with garbled/missing scripts — re-scripting…`);

  const languages = existing.generatedLanguages ?? ["en", "hi"];
  log(`Re-scripting for languages: ${languages.join(",")}`);

  // Group bad stories by section
  const bySection = new Map<SectionId, Story[]>();
  for (const s of badStories) {
    const arr = bySection.get(s.section) ?? [];
    arr.push(s);
    bySection.set(s.section, arr);
  }

  const updated = existing.stories.map(s => ({ ...s }));
  let patched = 0;

  for (const [sectionId, sectionStories] of bySection) {
    if (isAbortRequested()) { log("⛔ Aborted"); break; }
    const emoji = FEED_MAP.get(sectionId)?.emoji ?? "📰";
    log(`  ${emoji} Re-scripting ${sectionId}: ${sectionStories.length} stories…`);

    try {
      const rescripted = await scriptBatch(sectionStories, sectionId, log, languages);

      for (const rs of rescripted) {
        const idx = updated.findIndex(s => s.id === rs.id);
        if (idx < 0) continue;
        // Keep existing audio URLs; update scripts + titles only
        updated[idx] = {
          ...updated[idx],
          scriptEn: rs.scriptEn || updated[idx].scriptEn,
          scriptHi: rs.scriptHi || updated[idx].scriptHi,
          ...(rs.scriptTa !== undefined ? { scriptTa: rs.scriptTa } : {}),
          ...(rs.scriptMr !== undefined ? { scriptMr: rs.scriptMr } : {}),
          ...(rs.titleHi  !== undefined ? { titleHi:  rs.titleHi  } : {}),
          ...(rs.titleTa  !== undefined ? { titleTa:  rs.titleTa  } : {}),
          ...(rs.titleMr  !== undefined ? { titleMr:  rs.titleMr  } : {}),
        };
        patched++;
      }
    } catch (err: any) {
      log(`  ✗ ${sectionId}: ${err.message?.slice(0, 80)}`);
    }

    // Save after each section so progress survives a partial run
    await saveBriefing({ ...existing, generatedAt: new Date().toISOString(), stories: updated });
  }

  const briefing: DailyBriefing = {
    ...existing,
    generatedAt: new Date().toISOString(),
    stories: updated,
  };
  await saveBriefing(briefing);
  log(`✅ Patched ${patched} scripts`);
  return { patched, briefing };
}

// ─── TTS-only patch ───────────────────────────────────────────────────────────

export async function generateMissingTTS(
  logger: Logger = () => {},
  provider: TtsProvider = "google",
): Promise<{ patched: number; briefing: DailyBriefing }> {
  const log = (msg: string) => { console.log(`[generator] ${msg}`); logger(msg); };

  const existing = await getLatestBriefing();
  if (!existing) throw new Error("No existing briefing — run full generation first");

  // All 4 languages — a story is "missing" if it has a script but no audio for any lang
  const PATCH_LANGS = ["en", "hi", "ta", "mr"] as const;
  const scriptKey = (lang: string) => `script${lang.charAt(0).toUpperCase() + lang.slice(1)}` as keyof Story;
  const audioKey  = (lang: string) => `audioUrl${lang.charAt(0).toUpperCase() + lang.slice(1)}` as keyof Story;

  const missing = existing.stories.filter(s =>
    PATCH_LANGS.some(lang => (s as any)[scriptKey(lang)] && !(s as any)[audioKey(lang)])
  );

  if (missing.length === 0) {
    log("All stories already have audio — nothing to do");
    return { patched: 0, briefing: existing };
  }

  const synthesize = async (script: string, filename: string): Promise<string> => {
    if (provider === "google")     { const { url } = await googleTTS(script, filename);     return url; }
    if (provider === "elevenlabs") { const { url } = await elevenLabsTTS(script, filename);  return url; }
    if (provider === "edge")       { const { url } = await edgeTTS(script, filename);        return url; }
    if (provider === "kokoro")     { const { url } = await kokoroTTS(script, filename);      return url; }
    throw new Error(`Unknown TTS provider: ${provider}`);
  };

  log(`TTS patch (${provider}): ${missing.length} stories with missing audio…`);

  const updated = existing.stories.map(s => ({ ...s }));
  let patched   = 0;

  for (const story of missing) {
    if (isAbortRequested())                                    { log("⛔ Aborted by stop request"); break; }
    if (provider === "elevenlabs" && isQuotaExhausted())       { log("⛔ ElevenLabs quota exhausted — stopping."); break; }
    if (provider === "google"     && isDailyQuotaExhausted())  { log("⛔ Google TTS daily quota exhausted — stopping."); break; }

    const idx = updated.findIndex(s => s.id === story.id);
    if (idx < 0) continue;
    const fileBase = `${existing.date}-${story.id}`;
    let gotAny = false;

    for (const lang of PATCH_LANGS) {
      if (isAbortRequested()) break;
      if (provider === "elevenlabs" && isQuotaExhausted()) break;
      if (provider === "google"     && isDailyQuotaExhausted()) break;

      // Provider language restrictions
      if (provider === "kokoro"     && lang !== "en")              continue;
      if (provider === "google"     && lang !== "en" && lang !== "hi") continue;
      if (provider === "elevenlabs" && lang !== "en" && lang !== "hi") continue;

      const sk = scriptKey(lang);
      const ak = audioKey(lang);
      const script   = (story as any)[sk] as string | undefined;
      const hasAudio = (story as any)[ak] as string | undefined;

      if (!script || hasAudio) continue;

      try {
        (updated[idx] as any)[ak] = await synthesize(script, `${fileBase}-${lang}`);
        if (lang === "en") updated[idx].audioStartSec = 0;
        patched++;
        gotAny = true;
      } catch (err: any) {
        log(`  ✗ ${lang.toUpperCase()} ${story.id.slice(0, 8)}: ${err.message?.slice(0, 80)}`);
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
