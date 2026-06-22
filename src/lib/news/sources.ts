/**
 * Google News RSS feed configuration — direct topic feeds.
 * No Gemini categorisation needed: Google already sorts these.
 */

export type SectionId =
  | "headlines"
  | "india"
  | "world"
  | "business"
  | "technology"
  | "entertainment"
  | "sports"
  | "science"
  | "health"
  | "local";

export type FeedConfig = {
  id: SectionId;
  label: string;
  labelHi: string;
  emoji: string;
  /** Build the RSS URL, optionally parameterised (e.g. local city). */
  buildUrl: (opts?: { city?: string }) => string;
  /** Fallback URL if buildUrl returns 0 results (e.g. topic ID expired). */
  fallbackUrl?: string;
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

// ── Feed configs ──────────────────────────────────────────────────────────────

export const FEEDS: FeedConfig[] = [
  {
    id: "headlines",
    label: "Headlines",
    labelHi: "मुख्य खबरें",
    emoji: "🔥",
    buildUrl: () => `${GN_BASE}?${LOCALE}`,
  },
  {
    id: "india",
    label: "India",
    labelHi: "भारत",
    emoji: "🇮🇳",
    // Topic ID can expire — search URL is a reliable fallback (rss.ts tries topic first)
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.india}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+news&${LOCALE}`,
  },
  {
    id: "world",
    label: "World",
    labelHi: "विश्व",
    emoji: "🌍",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.world}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=world+international+news&${LOCALE}`,
  },
  {
    id: "business",
    label: "Business",
    labelHi: "व्यापार",
    emoji: "💼",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.business}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+business+economy+markets&${LOCALE}`,
  },
  {
    id: "technology",
    label: "Technology",
    labelHi: "तकनीक",
    emoji: "💻",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.technology}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=technology+ai+tech+news+india&${LOCALE}`,
  },
  {
    id: "entertainment",
    label: "Entertainment",
    labelHi: "मनोरंजन",
    emoji: "🎬",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.entertainment}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=bollywood+entertainment+movies+india&${LOCALE}`,
  },
  {
    id: "sports",
    label: "Sports",
    labelHi: "खेल",
    emoji: "⚽",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.sports}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=cricket+sports+news+india&${LOCALE}`,
  },
  {
    id: "science",
    label: "Science",
    labelHi: "विज्ञान",
    emoji: "🔬",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.science}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=science+space+research+news&${LOCALE}`,
  },
  {
    id: "health",
    label: "Health",
    labelHi: "स्वास्थ्य",
    emoji: "🏥",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.health}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=health+medicine+wellness+news+india&${LOCALE}`,
  },
  {
    id: "local",
    label: "Local",
    labelHi: "स्थानीय",
    emoji: "📍",
    buildUrl: ({ city } = {}) =>
      `${GN_BASE}/search?q=${encodeURIComponent((city ?? "Mumbai") + " local news")}&${LOCALE}`,
  },
];

export const FEED_MAP = new Map<SectionId, FeedConfig>(FEEDS.map((f) => [f.id, f]));

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
  return new Set(FEEDS.map((f) => f.id)); // default: all sections
}
