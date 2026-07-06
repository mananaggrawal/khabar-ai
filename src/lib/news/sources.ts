/**
 * Google News RSS feed configuration.
 * headlines | local | india | world | business | technology | sports | science | health
 * (Local/city-scoped feed removed 2026-07-02 for being hardcoded to a single
 * default city with no real per-user wiring; reintroduced 2026-07-06 — Mumbai
 * only for now, city selection lives in Settings, see CITIES below. Generation
 * stays single-tenant/global: everyone gets the same Mumbai "local" content
 * until more cities are actually generated.)
 */

// ── Section IDs — straight from Google News feed names ───────────────────────

export type SectionId =
  | "headlines" | "local" | "india" | "world" | "business"
  | "technology" | "sports" | "science" | "health";

// ── City selection (2026-07-06) ───────────────────────────────────────────────
// Only Mumbai has a real generated feed right now. The rest are listed so the
// picker communicates what's coming rather than looking unfinished — they're
// not selectable until a real feed + generation entry exists for them.
export type CityId = "mumbai" | "delhi" | "bangalore" | "chennai" | "kolkata";

export type CityConfig = { id: CityId; label: string; available: boolean };

export const CITIES: CityConfig[] = [
  { id: "mumbai",    label: "Mumbai",    available: true },
  { id: "delhi",     label: "Delhi",     available: false },
  { id: "bangalore", label: "Bangalore", available: false },
  { id: "chennai",   label: "Chennai",   available: false },
  { id: "kolkata",   label: "Kolkata",   available: false },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedConfig = {
  feedId: SectionId;
  label: string;
  labelHi: string;
  labelTa: string;
  labelMr: string;
  emoji: string;
  buildUrl: () => string;
  fallbackUrl?: string;
};

export type SectionConfig = {
  id: SectionId;
  label: string;
  labelHi: string;
  labelTa: string;
  labelMr: string;
  emoji: string;
};

// ── URL builders ──────────────────────────────────────────────────────────────

const LOCALE  = "hl=en-IN&gl=IN&ceid=IN:en";
const GN_BASE = "https://news.google.com/rss";

const TOPIC: Record<string, string> = {
  india:      "CAAqIQgKIhtDQkFTRGdvSUwyMHZNRHBxY0dNU0FtVnVLQUFQAQ",
  world:      "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pKVGlnQVAB",
  business:   "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pKVGlnQVAB",
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pKVGlnQVAB",
  sports:     "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pKVGlnQVAB",
  science:    "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RJU0FtVnVHZ0pKVGlnQVAB",
  health:     "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
};

// ── Feed configs ──────────────────────────────────────────────────────────────

export const FEEDS: FeedConfig[] = [
  {
    feedId:  "headlines",
    label:   "Headlines",
    labelHi: "मुख्य खबरें",
    labelTa: "தலைப்புச் செய்திகள்",
    labelMr: "ठळक बातम्या",
    emoji:   "🔥",
    buildUrl: () => `${GN_BASE}?${LOCALE}`,
  },
  {
    // Mumbai-only for now (2026-07-06) — hardcoded label until more cities are
    // actually generated (see CITIES above). No Google News topic ID exists for
    // a city, so this uses a search query like the other feeds' fallbackUrl does.
    feedId:  "local",
    label:   "Mumbai",
    labelHi: "मुंबई",
    labelTa: "மும்பை",
    labelMr: "मुंबई",
    emoji:   "🏙️",
    buildUrl: () => `${GN_BASE}/search?q=Mumbai&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=Mumbai+news&${LOCALE}`,
  },
  {
    feedId:  "india",
    label:   "India",
    labelHi: "भारत",
    labelTa: "இந்தியா",
    labelMr: "भारत",
    emoji:   "🇮🇳",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.india}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+news&${LOCALE}`,
  },
  {
    feedId:  "world",
    label:   "World",
    labelHi: "विश्व",
    labelTa: "உலகம்",
    labelMr: "जग",
    emoji:   "🌍",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.world}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=world+international+news&${LOCALE}`,
  },
  {
    feedId:  "business",
    label:   "Business",
    labelHi: "व्यापार",
    labelTa: "வணிகம்",
    labelMr: "व्यवसाय",
    emoji:   "💼",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.business}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=india+business+economy+markets&${LOCALE}`,
  },
  {
    feedId:  "technology",
    label:   "Technology",
    labelHi: "तकनीक",
    labelTa: "தொழில்நுட்பம்",
    labelMr: "तंत्रज्ञान",
    emoji:   "💻",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.technology}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=technology&${LOCALE}`,
  },
  {
    feedId:  "sports",
    label:   "Sports",
    labelHi: "खेल",
    labelTa: "விளையாட்டு",
    labelMr: "क्रीडा",
    emoji:   "🏆",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.sports}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=sports&${LOCALE}`,
  },
  {
    feedId:  "science",
    label:   "Science",
    labelHi: "विज्ञान",
    labelTa: "அறிவியல்",
    labelMr: "विज्ञान",
    emoji:   "🔬",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.science}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=science&${LOCALE}`,
  },
  {
    feedId:  "health",
    label:   "Health",
    labelHi: "स्वास्थ्य",
    labelTa: "சுகாதாரம்",
    labelMr: "आरोग्य",
    emoji:   "🩺",
    buildUrl: () => `${GN_BASE}/topics/${TOPIC.health}?${LOCALE}`,
    fallbackUrl: `${GN_BASE}/search?q=health&${LOCALE}`,
  },
];

// ── Display section configs ───────────────────────────────────────────────────

export const SECTION_ORDER: SectionId[] = ["headlines", "local", "india", "world", "business", "technology", "sports", "science", "health"];

const SECTION_CONFIGS: SectionConfig[] = [
  { id: "headlines",  label: "Headlines",   labelHi: "मुख्य खबरें", labelTa: "தலைப்புச் செய்திகள்", labelMr: "ठळक बातम्या", emoji: "🔥" },
  { id: "local",      label: "Mumbai",      labelHi: "मुंबई",        labelTa: "மும்பை",               labelMr: "मुंबई",        emoji: "🏙️" },
  { id: "india",      label: "India",       labelHi: "भारत",         labelTa: "இந்தியா",              labelMr: "भारत",         emoji: "🇮🇳" },
  { id: "world",      label: "World",       labelHi: "विश्व",         labelTa: "உலகம்",                labelMr: "जग",           emoji: "🌍" },
  { id: "business",   label: "Business",    labelHi: "व्यापार",       labelTa: "வணிகம்",               labelMr: "व्यवसाय",      emoji: "💼" },
  { id: "technology", label: "Technology",  labelHi: "तकनीक",        labelTa: "தொழில்நுட்பம்",         labelMr: "तंत्रज्ञान",   emoji: "💻" },
  { id: "sports",     label: "Sports",      labelHi: "खेल",          labelTa: "விளையாட்டு",           labelMr: "क्रीडा",       emoji: "🏆" },
  { id: "science",    label: "Science",     labelHi: "विज्ञान",       labelTa: "அறிவியல்",             labelMr: "विज्ञान",      emoji: "🔬" },
  { id: "health",     label: "Health",      labelHi: "स्वास्थ्य",     labelTa: "சுகாதாரம்",            labelMr: "आरोग्य",       emoji: "🩺" },
];

/** FEED_MAP: SectionId → SectionConfig. Used in UI for labels and emojis. */
export const FEED_MAP = new Map<SectionId, SectionConfig>(
  SECTION_CONFIGS.map((c) => [c.id, c]),
);

// ── Publisher allowlist (2026-07-02) ──────────────────────────────────────────
// Generation only keeps articles from these 7 mastheads — everything else is
// dropped during fetch. `match` recognises the RSS <source> string variants
// each publisher actually shows up as (e.g. "NDTV Profit", "NDTV Sports").
// Shared between the server (generator.ts allowlist filter) and the client
// (Settings "Sources" picker + the reader filter in context/player.tsx) so
// both sides agree on what counts as "NDTV" etc.
export type PublisherKey = "toi" | "ndtv" | "hindu" | "ht" | "ie" | "et" | "mint";

export const ALLOWED_PUBLISHERS: { key: PublisherKey; label: string; match: (source: string) => boolean }[] = [
  { key: "toi",   label: "Times of India",     match: (s) => s.toLowerCase().includes("times of india") },
  { key: "ndtv",  label: "NDTV",               match: (s) => s.toLowerCase().includes("ndtv") },
  { key: "hindu", label: "The Hindu",          match: (s) => s.toLowerCase().includes("the hindu") },
  { key: "ht",    label: "Hindustan Times",    match: (s) => s.toLowerCase().includes("hindustan times") },
  // "Indian Express" but NOT "The New Indian Express" — a different masthead.
  { key: "ie",    label: "Indian Express",     match: (s) => { const l = s.toLowerCase(); return l.includes("indian express") && !l.includes("new indian express"); } },
  { key: "et",    label: "Economic Times",     match: (s) => s.toLowerCase().includes("economic times") },
  { key: "mint",  label: "Mint",               match: (s) => { const l = s.toLowerCase(); return l === "mint" || l.includes("livemint"); } },
];

/**
 * Returns the PublisherKey a raw RSS source string belongs to, or null if it's
 * not one of the 7 mastheads. Only used server-side now (generator.ts's
 * ALLOW_ALL_SOURCES=false escape hatch) — the client-side "Sources" picker in
 * Settings that used to narrow the reader's own feed was removed 2026-07-03.
 */
export function matchPublisher(source: string | undefined): PublisherKey | null {
  if (!source) return null;
  for (const p of ALLOWED_PUBLISHERS) if (p.match(source)) return p.key;
  return null;
}
