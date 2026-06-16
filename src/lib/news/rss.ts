// Minimal RSS parser — no external deps. Runs in the Worker server runtime.
export type RssItem = {
  title: string;
  link: string;
  pubDate?: string;
  source: string;
  sourceId: string;
  description?: string;
};

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

export function parseRss(xml: string, sourceName: string, sourceId: string): RssItem[] {
  const items: RssItem[] = [];
  // Match both <item>…</item> (RSS) and <entry>…</entry> (Atom)
  const regex = /<(item|entry)[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    const block = m[0];
    const title = tag(block, "title");
    let link = tag(block, "link");
    if (!link) {
      const hrefMatch = block.match(/<link[^>]*href="([^"]+)"/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    if (!title || !link) continue;
    items.push({
      title,
      link,
      pubDate: tag(block, "pubDate") || tag(block, "published") || tag(block, "updated"),
      description: tag(block, "description") || tag(block, "summary"),
      source: sourceName,
      sourceId,
    });
  }
  return items;
}

export async function fetchRss(
  url: string,
  sourceName: string,
  sourceId: string,
  timeoutMs = 15000,
): Promise<RssItem[]> {
  const attempt = async (ms: number): Promise<RssItem[]> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; KhabarAIBot/1.0; +https://lovable.dev)",
          accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRss(xml, sourceName, sourceId);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await attempt(timeoutMs);
  if (first.length > 0) return first;
  // One quick retry on empty/failed result — many news CDNs cold-start slowly.
  return attempt(Math.min(timeoutMs, 8000));
}

