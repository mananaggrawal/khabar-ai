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
  { id: "gn-top", name: "Google News — Top Stories", category: "top",
    url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" },
  { id: "gn-world", name: "Google News — World", category: "world", url: googleNews("world news") },
  { id: "gn-tech", name: "Google News — Tech", category: "tech", url: googleNews("technology") },
  { id: "gn-markets", name: "Google News — Markets", category: "markets", url: googleNews("markets finance") },
  { id: "gn-science", name: "Google News — Science", category: "science", url: googleNews("science research") },
  { id: "gn-sports", name: "Google News — Sports", category: "sports", url: googleNews("sports") },
  { id: "gn-culture", name: "Google News — Culture", category: "culture", url: googleNews("culture arts") },
  { id: "reuters-world", name: "Reuters World", category: "world", url: "https://feeds.reuters.com/Reuters/worldNews" },
  { id: "bbc-world", name: "BBC World", category: "world", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "ap-top", name: "AP Top News", category: "top", url: "https://feeds.apnews.com/rss/apf-topnews" },
  { id: "hn", name: "Hacker News", category: "tech", url: "https://hnrss.org/frontpage" },
];

export const ALL_CATEGORIES = [
  "world", "tech", "markets", "science", "sports", "culture",
] as const;
export type Category = (typeof ALL_CATEGORIES)[number];
