import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const SEARCH_TIMEOUT_MS = 15000;

type SearchResult = {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
};

async function firecrawlSearch(
  query: string,
  firecrawlKey: string,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${firecrawlKey}`,
      },
      body: JSON.stringify({
        query,
        limit: 3,
        tbs: "qdr:w",
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error("[search] firecrawl search failed", res.status);
      return [];
    }
    const json: any = await res.json();
    const raw: any[] =
      json?.data?.web ?? json?.data ?? json?.web ?? [];
    return raw
      .map((r: any) => ({
        url: String(r?.url ?? ""),
        title: r?.title ? String(r.title) : undefined,
        description: r?.description ? String(r.description) : undefined,
        markdown: r?.markdown ? String(r.markdown).slice(0, 4000) : undefined,
      }))
      .filter((r) => r.url);
  } catch (e) {
    console.error("[search] firecrawl error", e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export const searchTopicLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      headline: z.string().min(1).max(400),
      query: z.string().min(1).max(400),
    }),
  )
  .handler(async ({ data }) => {
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    const lovableKey = process.env.LOVABLE_API_KEY;
    if (!firecrawlKey || !lovableKey) {
      return {
        ok: false as const,
        answer:
          "I can't reach a live source right now — the search tool isn't fully configured.",
        sourceName: "",
        sourceUrl: "",
      };
    }

    const composed = `${data.headline} ${data.query}`.slice(0, 380);
    const results = await firecrawlSearch(composed, firecrawlKey);
    if (results.length === 0) {
      return {
        ok: false as const,
        answer:
          "I looked but couldn't pull anything fresh on that just now. Want me to try a different angle?",
        sourceName: "",
        sourceUrl: "",
      };
    }

    const block = results
      .slice(0, 3)
      .map(
        (r, i) =>
          `=== RESULT ${i + 1} — ${r.title ?? r.url} (${r.url}) ===\n${
            r.markdown ?? r.description ?? ""
          }`,
      )
      .join("\n\n");

    const system = `You answer a single follow-up question for a voice news agent. Be concise (2-3 sentences), conversational, and grounded ONLY in the provided search results. Cite the source publication by name in-line, e.g. "according to Reuters…". If the results don't actually answer the question, say so plainly.`;
    const user = `STORY CONTEXT: ${data.headline}
USER QUESTION: ${data.query}

LIVE SEARCH RESULTS:
${block}

Return JSON: { "answer": "...", "sourceName": "publication name of the primary source you used", "sourceUrl": "URL of that source" }`;

    try {
      const res = await fetch(
        "https://ai.gateway.lovable.dev/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lovableKey}`,
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
          }),
        },
      );
      if (!res.ok) {
        return {
          ok: false as const,
          answer: "I found sources but couldn't summarize them just now.",
          sourceName: results[0].title ?? "source",
          sourceUrl: results[0].url,
        };
      }
      const json = await res.json();
      const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
      return {
        ok: true as const,
        answer: String(parsed.answer ?? ""),
        sourceName: String(parsed.sourceName ?? results[0].title ?? ""),
        sourceUrl: String(parsed.sourceUrl ?? results[0].url ?? ""),
      };
    } catch (e) {
      console.error("[search] LLM error", e);
      return {
        ok: false as const,
        answer: "I hit a snag pulling that together. Try asking again?",
        sourceName: "",
        sourceUrl: "",
      };
    }
  });
