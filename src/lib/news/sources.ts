/**
 * Google News RSS feed configuration — topic-first section taxonomy.
 * 10 RSS feeds map to 5 display sections: politics | world | business | sports | techlife
 */

// ── Display section IDs (used in UI, stories, scripts) ───────────────────────

export type SectionId =
  | "politics"
  | "world"
  | "business"
  | "sports"
  | "techlife";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Configuration for a single RSS feed source. */
export type FeedConfig = {
  feedId: string;        // internal feed identifier (legacy section name)
  section: SectionId;   // display section this feed belongs to
  label: string;
  labelHi: string;
  emoji: string;
  /** Build the RSS URL, optionally parameterised (e.g. local city). */
  buildUrl: (opts?: { city?: string }) => string;
  /** Fallback URL if buildUrl returns 0 results (e.g. topic ID expired). */
  fallbackUrl?: string;
};

/** Display config for a section (used in UI: pills, StoryCard label, transitions). */
export type SectionConfig = {
  id: SectionId;
  label: string;
  labelHi: string;
  emoji: string;
};

// ── URL builders ──────────────────────────────────────────────────────────────

const LOCALE = "hl=en-IN&gl=IN&ceid=IN:en";
const GN_BASE = "https://news.google.com/rss";

// Google News section topic IDs (IN:en locale)
const TOPIC: Record<string, string> = {
  world:         "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pKVGlnQVAB",
  india:         "CAAqIQgKIhtDQkFTRGdvSUwyMHZNRHBxY0dNU0FtVnVLQUFQAQ",
  business:      "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pKVGlnQVAB",
  technology:    "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pKVGlnQVAB",
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYVdjU0FtVnVHZ0pKVGlnQVAB",
  sports:        "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pKVGlnQVAB",
  science:       "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pKVGlnQVAB",
  health:        "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRJU0FtVnVLQUFQAQ",
};

// ── Feed configs — 10 RSS feeds mapped to 5 display sections ──────────────────
//
// politics  ← headlines + india + local
// world     ← world
// business  ← business
// sports    ← sports
// techlife  ← technology + entertainment + science + health

export const FEEDS: FeedConfig[] = [
  {
    feedId:  "headlines",
    section: "politics",
    label:   "Headlines",
    labelHi: "मुख्य खबरें",
    emoji:   "🔥",
    buildUrl: () => `${GN_BASE}?${LOCALE}`,
  },
  {
    feedId:  "india",
    section: "politics",
    label:   "India",
    labelHi: "भारत",
    emoji:   "🇮🇳",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.india}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+news&${LOCALE}`,
  },
  {
    feedId:  "world",
    section: "world",
    label:   "World",
    labelHi: "विश्व",
    emoji:   "🌍",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.world}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=world+international+news&${LOCALE}`,
  },
  {
    feedId:  "business",
    section: "business",
    label:   "Business",
    labelHi: "व्यापार",
    emoji:   "💼",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.business}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+business+economy+markets&${LOCALE}`,
  },
  {
    feedId:  "technology",
    section: "techlife",
    label:   "Technology",
    labelHi: "तकनीक",
    emoji:   "💻",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.technology}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=technology+ai+tech+news+india&${LOCALE}`,
  },
  {
    feedId:  "entertainment",
    section: "techlife",
    label:   "Entertainment",
    labelHi: "मनोरंजन",
    emoji:   "🎬",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.entertainment}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=bollywood+entertainment+movies+india&${LOCALE}`,
  },
  {
    feedId:  "sports",
    section: "sports",
    label:   "Sports",
    labelHi: "खेल",
    emoji:   "⚽",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.sports}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=cricket+sports+news+india&${LOCALE}`,
  },
  {
    feedId:  "science",
    section: "techlife",
    label:   "Science",
    labelHi: "विज्ञान",
    emoji:   "🔬",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.science}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=science+space+research+news&${LOCALE}`,
  },
  {
    feedId:  "health",
    section: "techlife",
    label:   "Health",
    labelHi: "स्वास्थ्य",
    emoji:   "🏥",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.health}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=health+medicine+wellness+news+india&${LOCALE}`,
  },
  {
    feedId:  "local",
    section: "politics",
    label:   "Local",
    labelHi: "स्थानीय",
    emoji:   "📍",
    buildUrl: ({ city } = {}) =>
      `${GN_BASE}/search?q=${encodeURIComponent((city ?? "Mumbai") + " local news")}&${LOCALE}`,
  },
];

// ── Display section configs ────────────────────────────────────────────────────

const SECTION_CONFIGS: SectionConfig[] = [
  { id: "politics",  label: "Politics",    labelHi: "राजनीति",        emoji: "🏛️" },
  { id: "world",     label: "World",       labelHi: "विश्व",           emoji: "🌍" },
  { id: "business",  label: "Business",    labelHi: "व्यापार",         emoji: "💼" },
  { id: "sports",    label: "Sports",      labelHi: "खेल",             emoji: "⚽" },
  { id: "techlife",  label: "Tech & Life", labelHi: "तकनीक और जीवन",  emoji: "💡" },
];

/**
 * FEED_MAP maps SectionId → SectionConfig.
 * Used throughout UI and scripting for labels, emojis.
 */
export const FEED_MAP = new Map<SectionId, SectionConfig>(
  SECTION_CONFIGS.map((c) => [c.id, c]),
);

// ── City setting (localStorage, client-side only) ─────────────────────────────

export const CITY_KEY = "khabar-city";
export const DEFAULT_CITY = "Mumbai";

export const MAJOR_CITIES = [
  "Mumbai",
  "Delhi",
  "Bengaluru",
  "Hyderabad",
  "Chennai",
  "Kolkata",
  "Pune",
  "Ahmedabad",
  "Jaipur",
  "Surat",
];

export function readCity(): string {
  try { return localStorage.getItem(CITY_KEY) || DEFAULT_CITY; } catch { return DEFAULT_CITY; }
}

// ── Section preferences (localStorage, client-side only) ──────────────────────

export const SECTIONS_KEY = "khabar-preferred-sections";

export function readPreferredSections(): Set<SectionId> {
  try {
    const stored = localStorage.getItem(SECTIONS_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as SectionId[];
      if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
    }
  } catch {}
  return new Set(SECTION_CONFIGS.map((c) => c.id)); // default: all 5 sections
}
