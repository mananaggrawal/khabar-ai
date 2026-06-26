/**
 * Google News RSS feed configuration — 5 focused feeds.
 * headlines | india | world | business | local
 */

// ── Section IDs — straight from Google News feed names ───────────────────────

export type SectionId = "headlines" | "india" | "world" | "business" | "local";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedConfig = {
  feedId: SectionId;
  label: string;
  labelHi: string;
  emoji: string;
  buildUrl: (opts?: { city?: string }) => string;
  fallbackUrl?: string;
};

export type SectionConfig = {
  id: SectionId;
  label: string;
  labelHi: string;
  emoji: string;
};

// ── URL builders ──────────────────────────────────────────────────────────────

const LOCALE  = "hl=en-IN&gl=IN&ceid=IN:en";
const GN_BASE = "https://news.google.com/rss";

// Default city for the Local feed (also the Settings default). Declared here so
// the Local feed's buildUrl can reference it.
export const DEFAULT_CITY = "Mumbai";

const TOPIC: Record<string, string> = {
  india:    "CAAqIQgKIhtDQkFTRGdvSUwyMHZNRHBxY0dNU0FtVnVLQUFQAQ",
  world:    "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pKVGlnQVAB",
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pKVGlnQVAB",
};

// ── Feed configs ──────────────────────────────────────────────────────────────

export const FEEDS: FeedConfig[] = [
  {
    feedId:  "headlines",
    label:   "Top Stories",
    labelHi: "मुख्य खबरें",
    emoji:   "🔥",
    buildUrl: () => `${GN_BASE}?${LOCALE}`,
  },
  {
    feedId:  "india",
    label:   "India",
    labelHi: "भारत",
    emoji:   "🇮🇳",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.india}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+news&${LOCALE}`,
  },
  {
    feedId:  "world",
    label:   "World",
    labelHi: "विश्व",
    emoji:   "🌍",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.world}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=world+international+news&${LOCALE}`,
  },
  {
    feedId:  "business",
    label:   "Business",
    labelHi: "व्यापार",
    emoji:   "💼",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.business}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+business+economy+markets&${LOCALE}`,
  },
  {
    feedId:  "local",
    label:   "Local",
    labelHi: "स्थानीय",
    emoji:   "📍",
    // City-scoped headlines via Google News search (city comes from request/default)
    buildUrl: (opts) => `${GN_BASE}/search?q=${encodeURIComponent((opts?.city ?? DEFAULT_CITY) + " news")}&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=${encodeURIComponent(DEFAULT_CITY + " news")}&${LOCALE}`,
  },
];

// ── Display section configs ───────────────────────────────────────────────────

export const SECTION_ORDER: SectionId[] = ["headlines", "india", "world", "business", "local"];

const SECTION_CONFIGS: SectionConfig[] = [
  { id: "headlines", label: "Top Stories", labelHi: "मुख्य खबरें", emoji: "🔥" },
  { id: "india",     label: "India",       labelHi: "भारत",         emoji: "🇮🇳" },
  { id: "world",     label: "World",       labelHi: "विश्व",         emoji: "🌍" },
  { id: "business",  label: "Business",    labelHi: "व्यापार",       emoji: "💼" },
  { id: "local",     label: "Local",       labelHi: "स्थानीय",      emoji: "📍" },
];

/** FEED_MAP: SectionId → SectionConfig. Used in UI for labels and emojis. */
export const FEED_MAP = new Map<SectionId, SectionConfig>(
  SECTION_CONFIGS.map((c) => [c.id, c]),
);

// ── City setting (localStorage, client-side only) ─────────────────────────────

export const CITY_KEY    = "khabar-city";

export const MAJOR_CITIES = [
  "Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai",
  "Kolkata", "Pune", "Ahmedabad", "Jaipur", "Surat",
];

export function readCity(): string {
  try { return localStorage.getItem(CITY_KEY) || DEFAULT_CITY; } catch { return DEFAULT_CITY; }
}

// ── Section preferences (localStorage, client-side only) ─────────────────────

export const SECTIONS_KEY = "khabar-preferred-sections";

export function readPreferredSections(): Set<SectionId> {
  try {
    const stored = localStorage.getItem(SECTIONS_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as SectionId[];
      if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
    }
  } catch {}
  return new Set(SECTION_CONFIGS.map((c) => c.id)); // default: all 4 sections
}
