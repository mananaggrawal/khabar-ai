/**
 * Google News RSS feed configuration.
 * headlines | india | world | business | technology | sports | science | health
 *
 * "local" (city-scoped) section and city selection removed entirely
 * (2026-07-08, per explicit request) — it was reintroduced 2026-07-06 with
 * Mumbai-only coverage and never grew beyond that. Languages are English and
 * Hindi only (Tamil/Marathi removed the same day).
 */

// ── Section IDs — straight from Google News feed names ───────────────────────

export type SectionId =
  | "headlines" | "india" | "world" | "business"
  | "technology" | "sports" | "science" | "health";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedConfig = {
  feedId: SectionId;
  label: string;
  labelHi: string;
  emoji: string;
  buildUrl: () => string;
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

// Still used as each section's FALLBACK feed (2026-07-11) — no longer
// primary. Google News topic feeds are relevance/prominence-curated, not
// strictly recency-sorted, so a still-prominent-but-day-old story can sit at
// the top of a topic feed well after it's been superseded (confirmed case:
// a "Spain's Yamal warned ahead of Belgium clash" preview, published
// 2026-07-10, still appearing prominently during a 2026-07-11 run — the
// match had already been played and superseded by semifinal coverage).
// Search feeds with an explicit `when:1d` operator are query-driven and
// rotate on actual publish recency instead, so they're now primary; these
// topic feeds remain as the fallback if a search feed ever returns 0 items.
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
    emoji:   "🔥",
    buildUrl: () => `${GN_BASE}?${LOCALE}`,
  },
  {
    feedId:  "india",
    label:   "India",
    labelHi: "भारत",
    emoji:   "🇮🇳",
    // Search feed + `when:1d` is now PRIMARY, topic feed is the fallback —
    // swapped 2026-07-11 (see note above TOPIC). fallbackUrl only engages
    // if the primary returns 0 items (see fetchAllFeeds in generator.ts),
    // so this keeps the old topic-feed behavior as a safety net rather than
    // removing it outright.
    buildUrl: () => `${GN_BASE}/search?q=india+news+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.india}?${LOCALE}`,
  },
  {
    feedId:  "world",
    label:   "World",
    labelHi: "विश्व",
    emoji:   "🌍",
    buildUrl: () => `${GN_BASE}/search?q=world+international+news+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.world}?${LOCALE}`,
  },
  {
    feedId:  "business",
    label:   "Business",
    labelHi: "व्यापार",
    emoji:   "💼",
    buildUrl: () => `${GN_BASE}/search?q=india+business+economy+markets+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.business}?${LOCALE}`,
  },
  {
    feedId:  "technology",
    label:   "Technology",
    labelHi: "तकनीक",
    emoji:   "💻",
    buildUrl: () => `${GN_BASE}/search?q=technology+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.technology}?${LOCALE}`,
  },
  {
    feedId:  "sports",
    label:   "Sports",
    labelHi: "खेल",
    emoji:   "🏆",
    buildUrl: () => `${GN_BASE}/search?q=sports+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.sports}?${LOCALE}`,
  },
  {
    feedId:  "science",
    label:   "Science",
    labelHi: "विज्ञान",
    emoji:   "🔬",
    buildUrl: () => `${GN_BASE}/search?q=science+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.science}?${LOCALE}`,
  },
  {
    feedId:  "health",
    label:   "Health",
    labelHi: "स्वास्थ्य",
    emoji:   "🩺",
    buildUrl: () => `${GN_BASE}/search?q=health+when:1d&${LOCALE}`,
    fallbackUrl: `${GN_BASE}/topics/${TOPIC.health}?${LOCALE}`,
  },
];

// ── Display section configs ───────────────────────────────────────────────────

export const SECTION_ORDER: SectionId[] = ["headlines", "india", "world", "business", "technology", "sports", "science", "health"];

const SECTION_CONFIGS: SectionConfig[] = [
  { id: "headlines",  label: "Headlines",   labelHi: "मुख्य खबरें", emoji: "🔥" },
  { id: "india",      label: "India",       labelHi: "भारत",         emoji: "🇮🇳" },
  { id: "world",      label: "World",       labelHi: "विश्व",         emoji: "🌍" },
  { id: "business",   label: "Business",    labelHi: "व्यापार",       emoji: "💼" },
  { id: "technology", label: "Technology",  labelHi: "तकनीक",        emoji: "💻" },
  { id: "sports",     label: "Sports",      labelHi: "खेल",          emoji: "🏆" },
  { id: "science",    label: "Science",     labelHi: "विज्ञान",       emoji: "🔬" },
  { id: "health",     label: "Health",      labelHi: "स्वास्थ्य",     emoji: "🩺" },
];

/** FEED_MAP: SectionId → SectionConfig. Used in UI for labels and emojis. */
export const FEED_MAP = new Map<SectionId, SectionConfig>(
  SECTION_CONFIGS.map((c) => [c.id, c]),
);

// Legacy/removed section names → current SectionId (2026-07-09 centralization)
// — previously hand-copied near-identically across 6 different files
// (useMonologue.ts, context/player.tsx, routes/index.tsx, StoryCard.tsx,
// PlayerScreen.tsx, StoryDetailSheet.tsx), which is exactly how the Home-page
// crash happened: one copy (useMonologue.ts's sectionsWithStories) was never
// updated to fall back safely when "local" was removed, while the other five
// already had. Single source of truth now — every one of those files should
// import resolveSection from here instead of keeping its own copy.
const LEGACY_SECTION: Record<string, SectionId> = {
  politics: "india",
  techlife: "technology",
  entertainment: "india",
};

/** Normalizes any raw `Story.section` value — current, legacy, or otherwise
 * unrecognized — into a real, FEED_MAP-backed SectionId. Falls back to
 * "india" for anything unmapped, matching the fallback every one of the
 * duplicated copies already used. */
export function resolveSection(s: string): SectionId {
  if (s in LEGACY_SECTION) return LEGACY_SECTION[s];
  if (FEED_MAP.has(s as SectionId)) return s as SectionId;
  return "india";
}

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
