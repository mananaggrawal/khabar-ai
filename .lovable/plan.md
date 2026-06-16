## Goal

Make the agent feel like it "knows everything" about each story in the briefing. Right now each topic only carries a 40-60 word explanation and a one-line "why it matters", so any follow-up beyond that surface forces the agent to admit ignorance. We'll fix this in three layers — pre-build enrichment, fetched article bodies, and a live-search fallback — so the agent essentially never has to say "I don't know".

## How it'll work (plain English)

1. **When the briefing is built**, for each main story we'll also pull the actual article text from the top sources and have the AI write a much richer briefing pack: a ~300-word deep summary, a "background / context" paragraph, key facts (numbers, names, dates, quotes), and pre-answered likely follow-up questions. This pack lives on the topic but is NOT spoken by default — it's the agent's reference material.

2. **At conversation start**, the agent gets this rich pack as part of its context (in addition to the spoken brief). So when you ask "who said that?" or "how much money is involved?" or "what's the history here?", it answers instantly from the pack instead of guessing.

3. **If you ask something the pack still doesn't cover**, the agent calls a `searchTopic` tool that runs a live web search scoped to the story's keywords + your question, fetches the top result, and feeds the answer back into the conversation. This is the "no-dead-end" guarantee.

Briefing build time will go from ~10s to ~45-90s (configurable), but it only runs once per day per user.

## Implementation

### Phase 1 — Connect Firecrawl
Link the Firecrawl connector (gateway-backed) so the server has `FIRECRAWL_API_KEY` available. Used for: fetching article bodies (`/scrape`) and live search (`/search`).

### Phase 2 — Schema additions
Extend `BriefingTopic` (TS type + stored JSON in `briefings.topics` / `topics_tiered`) with:
- `deepBrief: string` (~300 words narrative)
- `background: string` (history / context paragraph)
- `keyFacts: string[]` (numbers, names, dates, exact quotes pulled from articles)
- `qa: { q: string; a: string }[]` (3-5 anticipated follow-up Q&A pairs)
- `articleExcerpts?: { source: string; url: string; excerpt: string }[]` (first ~800 chars of each scraped article, agent-readable, not user-facing)

No DB migration needed — `topics` is already `jsonb`. Old briefings without these fields still render fine; the agent code falls back gracefully.

### Phase 3 — Enrichment pipeline (`src/lib/news/briefing.functions.ts`)
After `writeTiered()` returns, add an `enrichTopics(topics)` step that runs in parallel (concurrency-limited, e.g. 4 at a time):

For each `home` and `world` topic:
1. Take its top 2-3 source URLs.
2. Call Firecrawl `scrape` (markdown, `onlyMainContent: true`) on each. Time-box per URL (~10s); skip failures silently.
3. Feed the combined article markdown + RSS metadata into one Lovable AI call (`google/gemini-2.5-flash`) that returns strict JSON with `deepBrief`, `background`, `keyFacts`, `qa`, and per-source `excerpt`.
4. Merge into the topic.

Quick-hit topics are NOT enriched (they're throwaways, and enrichment cost scales with cap).

Cost/time guardrails:
- New env-controlled toggle `BRIEFING_ENRICH` (default on); off = current behavior.
- `ENRICH_CONCURRENCY = 4`, `ENRICH_PER_TOPIC_TIMEOUT_MS = 25000`, `ENRICH_SOURCES_PER_TOPIC = 3`.
- All failures degrade gracefully — a topic with no enrichment data just behaves like today.

### Phase 4 — Wire enrichment into the agent context (`src/hooks/useVoiceAgent.ts`)
`buildBriefingContext()` already serializes topics into the session context. Add the new fields so the agent sees, per topic:
```
deepBrief, background, keyFacts[], qa[], excerpts[]
```
Update `AGENT_SYSTEM_PROMPT` to instruct:
- For the spoken briefing, keep using `explanation` / `whyItMatters` (unchanged pace).
- For follow-up questions, draw from `deepBrief`, `background`, `keyFacts`, `qa`, and `excerpts` FIRST.
- Only fall back to the `searchTopic` tool when none of those cover the question.
- Never say "I don't have that information" — instead, either answer from the pack, or call `searchTopic`, or honestly say "let me look that up" and call the tool.

### Phase 5 — Live search fallback tool
Two pieces:

**(a) Server function** `searchTopicLive` in `src/lib/news/search.functions.ts`:
- Input: `{ topicId, headline, query }`
- Calls Firecrawl `/search` with query `"<headline> <user question>"`, `limit: 3`, `tbs: 'qdr:w'` (last week), `scrapeOptions: { formats: ['markdown'] }`.
- Pipes the top result(s) through Lovable AI with a tight "answer the user's question in 2-3 sentences citing the source name" prompt.
- Returns `{ answer, sourceName, sourceUrl }`.

**(b) ElevenLabs client tool** registered in `useConversation({ clientTools: { searchTopic: async ({ topicId, query }) => { ... } } })`:
- Calls the server fn, returns the `answer` string back to the agent.
- Adds a small "🔎 looked up" line to the on-screen transcript so the user sees a search happened.

The user must also add `searchTopic` as a tool on the ElevenLabs agent dashboard (one-time setup) with params `topicId: string`, `query: string`. I'll surface this as a one-time instruction after deployment.

### Phase 6 — Cache + retry behavior
- The existing same-day cache in `fetchBriefing` already prevents re-enrichment. Add a guard: if cached briefing's first home topic is missing `deepBrief`, regenerate (so today's briefing upgrades on next refresh).
- `Refresh briefing` button continues to work and triggers re-enrichment.

## What the user will see
- Briefing generation takes longer (one-time per day; loading state already shows "Gathering today's briefing…").
- Spoken pace and structure unchanged.
- Follow-ups (`tell me more`, `who said X`, `how much was it`, `what happened before this`) get real, grounded answers.
- For anything still uncovered, a brief "let me look that up" pause + answer with a source citation.

## Open question (call out, don't block)
Firecrawl credits are consumed per scrape + per search. With ~14 enriched topics × ~3 scrapes/day = ~42 scrapes per user per day, plus on-demand searches. If the user has the free Firecrawl tier this may run out quickly — I'll flag clearly after first run.
