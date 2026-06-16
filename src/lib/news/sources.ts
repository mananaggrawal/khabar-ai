// RSS source registry. Used by the briefing pipeline.
export type RssSource = {
  id: string;
  name: string;
  url: string;
  category: "world" | "tech" | "markets" | "science" | "sports" | "culture" | "top";
};

const googleNews = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`;

export const RSS_SOURCES: RssSource[] = [
  // Top / broad
  { id: "gn-top", name: "Google News — Top", category: "top",
    url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" },
  { id: "ap-top", name: "AP Top News", category: "top", url: "https://feeds.apnews.com/rss/apf-topnews" },
  { id: "npr-top", name: "NPR Top", category: "top", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "nyt-home", name: "NYT Home", category: "top", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
  { id: "wapo-top", name: "Washington Post", category: "top", url: "https://feeds.washingtonpost.com/rss/national" },
  { id: "politico", name: "Politico", category: "top", url: "https://www.politico.com/rss/politicopicks.xml" },

  // World
  { id: "reuters-world", name: "Reuters World", category: "world", url: "https://feeds.reuters.com/Reuters/worldNews" },
  { id: "bbc-world", name: "BBC World", category: "world", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "aljazeera", name: "Al Jazeera", category: "world", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "guardian-world", name: "Guardian World", category: "world", url: "https://www.theguardian.com/world/rss" },
  { id: "nyt-world", name: "NYT World", category: "world", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { id: "dw-world", name: "Deutsche Welle", category: "world", url: "https://rss.dw.com/rdf/rss-en-world" },
  { id: "france24", name: "France 24", category: "world", url: "https://www.france24.com/en/rss" },
  { id: "gn-world", name: "Google News — World", category: "world", url: googleNews("world news") },

  // Markets
  { id: "wsj-markets", name: "WSJ Markets", category: "markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { id: "cnbc-top", name: "CNBC", category: "markets", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  { id: "ft-companies", name: "FT Companies", category: "markets", url: "https://www.ft.com/companies?format=rss" },
  { id: "gn-markets", name: "Google News — Markets", category: "markets", url: googleNews("markets finance economy") },
  { id: "gn-bloomberg", name: "Bloomberg via GN", category: "markets", url: googleNews("bloomberg") },

  // Tech
  { id: "hn", name: "Hacker News", category: "tech", url: "https://hnrss.org/frontpage" },
  { id: "techcrunch", name: "TechCrunch", category: "tech", url: "https://techcrunch.com/feed/" },
  { id: "verge", name: "The Verge", category: "tech", url: "https://www.theverge.com/rss/index.xml" },
  { id: "ars", name: "Ars Technica", category: "tech", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { id: "gn-tech", name: "Google News — Tech", category: "tech", url: googleNews("technology") },

  // Science
  { id: "sciencedaily", name: "ScienceDaily", category: "science", url: "https://www.sciencedaily.com/rss/all.xml" },
  { id: "nature", name: "Nature News", category: "science", url: "https://www.nature.com/nature.rss" },
  { id: "gn-science", name: "Google News — Science", category: "science", url: googleNews("science research") },

  // Sports
  { id: "espn", name: "ESPN", category: "sports", url: "https://www.espn.com/espn/rss/news" },
  { id: "gn-sports", name: "Google News — Sports", category: "sports", url: googleNews("sports") },

  // Culture
  { id: "variety", name: "Variety", category: "culture", url: "https://variety.com/feed/" },
  { id: "gn-culture", name: "Google News — Culture", category: "culture", url: googleNews("culture arts") },
];

export const ALL_CATEGORIES = [
  "world", "tech", "markets", "science", "sports", "culture",
] as const;
export type Category = (typeof ALL_CATEGORIES)[number];
