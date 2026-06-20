// News sources — single-pull architecture.
// Two top feeds are fetched; Gemini categorises all stories into sections.

export type CountryCode = "in" | "us" | "uk" | "global";

export type SectionCategory =
  | "india-national"
  | "india-business"
  | "india-sports"
  | "india-tech"
  | "india-entertainment"
  | "india-health"
  | "global-world"
  | "global-business"
  | "global-sports"
  | "global-tech"
  | "global-entertainment"
  | "global-health";

export type SectionConfig = {
  category: SectionCategory;
  label: string;
  labelHi: string;
  emoji: string;
  group: "india" | "global";
  required: boolean;
  /** One-line description used in the Gemini categorisation prompt. */
  description: string;
  storyCount: number;   // target stories per section
  wordTarget: number;   // target spoken words for the monologue script
};

// ── Feed builders ──────────────────────────────────────────────────────────

function gnTop(gl: string, hl: string, ceid: string) {
  return `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

// ── Top-level feeds (single-pull) ──────────────────────────────────────────
// These are the ONLY feeds fetched. Gemini categorises everything from here.
// Multiple locales give broader global coverage beyond just US news.

export const TOP_FEEDS = [
  // India
  { url: gnTop("IN", "en-IN", "IN:en"),                        name: "Google News India",     id: "gn-in-top",  group: "india"  as const },
  // Global — diverse regions, no US-only bias
  { url: gnTop("GB", "en-GB", "GB:en"),                        name: "Google News UK",        id: "gn-gb-top",  group: "global" as const },
  { url: gnTop("SG", "en-SG", "SG:en"),                        name: "Google News Singapore", id: "gn-sg-top",  group: "global" as const },
  { url: gnTop("AU", "en-AU", "AU:en"),                        name: "Google News Australia", id: "gn-au-top",  group: "global" as const },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml",        name: "BBC World",             id: "bbc-world",  group: "global" as const },
  { url: "https://www.aljazeera.com/xml/rss/all.xml",          name: "Al Jazeera",            id: "aljazeera",  group: "global" as const },
];

// ── Section configs ────────────────────────────────────────────────────────

export const SECTIONS: SectionConfig[] = [
  // ── India ──────────────────────────────────────────────────────────────
  {
    category:    "india-national",
    label:       "Politics & Policy",
    labelHi:     "राजनीति और नीति",
    emoji:       "🏛️",
    group:       "india",
    required:    true,
    description: "Indian politics, government policy, parliament, courts, elections, governance, law & order, defence.",
    storyCount:  5,
    wordTarget:  350,
  },
  {
    category:    "india-business",
    label:       "Business & Economy",
    labelHi:     "व्यापार और अर्थव्यवस्था",
    emoji:       "💰",
    group:       "india",
    required:    true,
    description: "Indian economy, markets (BSE/NSE), startups, corporate news, RBI, SEBI, trade, employment, budget.",
    storyCount:  4,
    wordTarget:  280,
  },
  {
    category:    "india-sports",
    label:       "Sports",
    labelHi:     "खेल",
    emoji:       "🏏",
    group:       "india",
    required:    false,
    description: "Indian sports: cricket (IPL, Tests, ODI), football, badminton, kabaddi, athletes, tournaments, Olympics.",
    storyCount:  4,
    wordTarget:  280,
  },
  {
    category:    "india-tech",
    label:       "Tech & Science",
    labelHi:     "तकनीक और विज्ञान",
    emoji:       "💻",
    group:       "india",
    required:    false,
    description: "Indian technology companies, startups, ISRO, space, AI/ML in India, digital India, science research.",
    storyCount:  3,
    wordTarget:  220,
  },
  {
    category:    "india-entertainment",
    label:       "Entertainment",
    labelHi:     "मनोरंजन",
    emoji:       "🎬",
    group:       "india",
    required:    false,
    description: "Bollywood, OTT (Netflix/Prime/Hotstar India), Tollywood, Indian music, celebrity news, awards, box office.",
    storyCount:  3,
    wordTarget:  200,
  },
  {
    category:    "india-health",
    label:       "Health",
    labelHi:     "स्वास्थ्य",
    emoji:       "🏥",
    group:       "india",
    required:    false,
    description: "Indian public health, AIIMS, ICMR, pharma (Sun/Cipla/Dr Reddy's), disease outbreaks, medical policy, mental health.",
    storyCount:  3,
    wordTarget:  200,
  },
  // ── Global ─────────────────────────────────────────────────────────────
  {
    category:    "global-world",
    label:       "World Affairs",
    labelHi:     "विश्व समाचार",
    emoji:       "🌍",
    group:       "global",
    required:    true,
    description: "International news, geopolitics, wars, diplomacy, elections abroad, UN, global crises — non-India focus.",
    storyCount:  5,
    wordTarget:  350,
  },
  {
    category:    "global-business",
    label:       "Business & Economy",
    labelHi:     "व्यापार और अर्थव्यवस्था",
    emoji:       "📈",
    group:       "global",
    required:    false,
    description: "Global markets (NYSE/NASDAQ/FTSE), Fed/ECB/central banks, multinational companies, trade, crypto, commodities.",
    storyCount:  4,
    wordTarget:  280,
  },
  {
    category:    "global-sports",
    label:       "Sports",
    labelHi:     "खेल",
    emoji:       "🏆",
    group:       "global",
    required:    false,
    description: "International sports: football (Premier League, Champions League, FIFA), NBA, NFL, tennis, F1, Olympics.",
    storyCount:  3,
    wordTarget:  220,
  },
  {
    category:    "global-tech",
    label:       "Tech & Science",
    labelHi:     "तकनीक और विज्ञान",
    emoji:       "🔬",
    group:       "global",
    required:    false,
    description: "Global tech: AI, Big Tech (Apple/Google/Meta/OpenAI), semiconductors, space (NASA/SpaceX), science breakthroughs.",
    storyCount:  4,
    wordTarget:  280,
  },
  {
    category:    "global-entertainment",
    label:       "Entertainment",
    labelHi:     "मनोरंजन",
    emoji:       "🎬",
    group:       "global",
    required:    false,
    description: "International entertainment: Hollywood, Netflix/Disney+/HBO, global music (Grammy, Billboard), awards, box office.",
    storyCount:  3,
    wordTarget:  200,
  },
  {
    category:    "global-health",
    label:       "Health",
    labelHi:     "स्वास्थ्य",
    emoji:       "🏥",
    group:       "global",
    required:    false,
    description: "Global health: WHO, pandemics, medical research, drug approvals (FDA/EMA), mental health, public health policy.",
    storyCount:  3,
    wordTarget:  220,
  },
];

export const SECTION_MAP      = new Map(SECTIONS.map((s) => [s.category, s]));
export const DEFAULT_SECTIONS: SectionCategory[] = SECTIONS.map((s) => s.category);
export const REQUIRED_SECTIONS: SectionCategory[] = SECTIONS.filter((s) => s.required).map((s) => s.category);

// ── Legacy helpers ─────────────────────────────────────────────────────────

export const SUPPORTED_COUNTRIES = [
  { code: "in"     as CountryCode, label: "India",  flag: "🇮🇳" },
  { code: "us"     as CountryCode, label: "USA",    flag: "🇺🇸" },
  { code: "uk"     as CountryCode, label: "UK",     flag: "🇬🇧" },
  { code: "global" as CountryCode, label: "Global", flag: "🌐" },
];

export const ALL_CATEGORIES = ["business", "sports", "tech", "entertainment", "science", "health"];

export function countryLabel(code: string): string {
  return SUPPORTED_COUNTRIES.find((c) => c.code === code)?.label ?? "India";
}
