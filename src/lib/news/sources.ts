// RSS source registry. Used by the briefing pipeline.
export type CountryCode = "in" | "us" | "uk" | "global";

export type RssSource = {
  id: string;
  name: string;
  url: string;
  category: "world" | "tech" | "markets" | "science" | "sports" | "culture" | "top";
  country: CountryCode;
};

const googleNews = (q: string, locale: "US" | "IN" | "GB" = "US") => {
  const hl = locale === "IN" ? "en-IN" : locale === "GB" ? "en-GB" : "en-US";
  const gl = locale;
  const ceid = `${locale}:${locale === "GB" ? "en" : "en"}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=${hl}&gl=${gl}&ceid=${ceid}`;
};

const googleNewsTop = (locale: "US" | "IN" | "GB" = "US") => {
  const hl = locale === "IN" ? "en-IN" : locale === "GB" ? "en-GB" : "en-US";
  return `https://news.google.com/rss?hl=${hl}&gl=${locale}&ceid=${locale}:en`;
};

export const RSS_SOURCES: RssSource[] = [
  // ─────────────── GLOBAL / wire ───────────────
  { id: "reuters-world", name: "Reuters World", category: "world", country: "global", url: "https://feeds.reuters.com/Reuters/worldNews" },
  { id: "aljazeera", name: "Al Jazeera", category: "world", country: "global", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "dw-world", name: "Deutsche Welle", category: "world", country: "global", url: "https://rss.dw.com/rdf/rss-en-world" },
  { id: "france24", name: "France 24", category: "world", country: "global", url: "https://www.france24.com/en/rss" },

  // ─────────────── INDIA ───────────────
  // National dailies
  { id: "hindu-national", name: "The Hindu — National", category: "top", country: "in", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
  { id: "hindu-world", name: "The Hindu — World", category: "world", country: "in", url: "https://www.thehindu.com/news/international/feeder/default.rss" },
  { id: "hindu-business", name: "The Hindu — Business", category: "markets", country: "in", url: "https://www.thehindu.com/business/feeder/default.rss" },
  { id: "toi-top", name: "Times of India — Top", category: "top", country: "in", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms" },
  { id: "toi-india", name: "Times of India — India", category: "top", country: "in", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms" },
  { id: "toi-world", name: "Times of India — World", category: "world", country: "in", url: "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms" },
  { id: "toi-business", name: "Times of India — Business", category: "markets", country: "in", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms" },
  { id: "ht-top", name: "Hindustan Times — Top", category: "top", country: "in", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml" },
  { id: "ht-world", name: "Hindustan Times — World", category: "world", country: "in", url: "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml" },

  // Policy / business / independent
  { id: "ie-front", name: "Indian Express — Front", category: "top", country: "in", url: "https://indianexpress.com/section/india/feed/" },
  { id: "ie-world", name: "Indian Express — World", category: "world", country: "in", url: "https://indianexpress.com/section/world/feed/" },
  { id: "livemint", name: "LiveMint — Markets", category: "markets", country: "in", url: "https://www.livemint.com/rss/markets" },
  { id: "moneycontrol", name: "Moneycontrol — Business", category: "markets", country: "in", url: "https://www.moneycontrol.com/rss/business.xml" },
  { id: "ndtv-top", name: "NDTV — Top", category: "top", country: "in", url: "https://feeds.feedburner.com/ndtvnews-top-stories" },
  { id: "ndtv-india", name: "NDTV — India", category: "top", country: "in", url: "https://feeds.feedburner.com/ndtvnews-india-news" },
  { id: "scroll", name: "Scroll.in", category: "top", country: "in", url: "https://scroll.in/feed.rss" },
  { id: "thewire", name: "The Wire", category: "top", country: "in", url: "https://thewire.in/rss" },

  // Google News India aggregator
  { id: "gn-in-top", name: "Google News India — Top", category: "top", country: "in", url: googleNewsTop("IN") },
  { id: "gn-in-world", name: "Google News India — World", category: "world", country: "in", url: googleNews("world news", "IN") },
  { id: "gn-in-tech", name: "Google News India — Tech", category: "tech", country: "in", url: googleNews("technology india", "IN") },
  { id: "gn-in-markets", name: "Google News India — Markets", category: "markets", country: "in", url: googleNews("markets economy india", "IN") },
  { id: "gn-in-science", name: "Google News India — Science", category: "science", country: "in", url: googleNews("science research india", "IN") },
  { id: "gn-in-sports", name: "Google News India — Sports", category: "sports", country: "in", url: googleNews("sports india cricket", "IN") },
  { id: "gn-in-culture", name: "Google News India — Culture", category: "culture", country: "in", url: googleNews("culture arts india", "IN") },

  // ─────────────── US ───────────────
  { id: "gn-us-top", name: "Google News US — Top", category: "top", country: "us", url: googleNewsTop("US") },
  { id: "ap-top", name: "AP Top News", category: "top", country: "us", url: "https://feeds.apnews.com/rss/apf-topnews" },
  { id: "npr-top", name: "NPR Top", category: "top", country: "us", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "nyt-home", name: "NYT Home", category: "top", country: "us", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
  { id: "wapo-top", name: "Washington Post", category: "top", country: "us", url: "https://feeds.washingtonpost.com/rss/national" },
  { id: "politico", name: "Politico", category: "top", country: "us", url: "https://www.politico.com/rss/politicopicks.xml" },
  { id: "nyt-world", name: "NYT World", category: "world", country: "us", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { id: "wsj-markets", name: "WSJ Markets", category: "markets", country: "us", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { id: "cnbc-top", name: "CNBC", category: "markets", country: "us", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  { id: "hn", name: "Hacker News", category: "tech", country: "us", url: "https://hnrss.org/frontpage" },
  { id: "techcrunch", name: "TechCrunch", category: "tech", country: "us", url: "https://techcrunch.com/feed/" },
  { id: "verge", name: "The Verge", category: "tech", country: "us", url: "https://www.theverge.com/rss/index.xml" },
  { id: "ars", name: "Ars Technica", category: "tech", country: "us", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { id: "sciencedaily", name: "ScienceDaily", category: "science", country: "us", url: "https://www.sciencedaily.com/rss/all.xml" },
  { id: "espn", name: "ESPN", category: "sports", country: "us", url: "https://www.espn.com/espn/rss/news" },
  { id: "variety", name: "Variety", category: "culture", country: "us", url: "https://variety.com/feed/" },

  // ─────────────── UK ───────────────
  { id: "gn-uk-top", name: "Google News UK — Top", category: "top", country: "uk", url: googleNewsTop("GB") },
  { id: "bbc-world", name: "BBC World", category: "world", country: "uk", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "guardian-world", name: "Guardian World", category: "world", country: "uk", url: "https://www.theguardian.com/world/rss" },
  { id: "ft-companies", name: "FT Companies", category: "markets", country: "uk", url: "https://www.ft.com/companies?format=rss" },
  { id: "nature", name: "Nature News", category: "science", country: "uk", url: "https://www.nature.com/nature.rss" },
];

export const ALL_CATEGORIES = [
  "world", "tech", "markets", "science", "sports", "culture",
] as const;
export type Category = (typeof ALL_CATEGORIES)[number];

export const SUPPORTED_COUNTRIES: { code: CountryCode; label: string; flag: string }[] = [
  { code: "in", label: "India", flag: "🇮🇳" },
  { code: "us", label: "United States", flag: "🇺🇸" },
  { code: "uk", label: "United Kingdom", flag: "🇬🇧" },
  { code: "global", label: "Global only", flag: "🌍" },
];

export function countryLabel(c: CountryCode): string {
  return SUPPORTED_COUNTRIES.find((x) => x.code === c)?.label ?? "Global";
}
