## Goal

Give the user **every distinct story breaking today**, with nothing dropped. The home surface becomes a complete browsable index of clustered topics, and the voice can read all of them (not just 5–7) in a longer, structured briefing.

## What changes

### 1. Wider source list (`src/lib/news/sources.ts`)
Add ~20 majors so we don't depend on Google News alone:
- World: Reuters World (existing), BBC World (existing), AP Top (existing), Al Jazeera, Guardian World, NYT World, NPR World, France 24, Deutsche Welle
- US/Politics: NYT HomePage, WaPo Politics, Politico, NPR Top
- Markets: WSJ Markets, FT (Reuters Business fallback), Bloomberg (via Google News query), CNBC Top
- Tech: HN (existing), TechCrunch, The Verge, Ars Technica, Google News Tech
- Science: Nature News, Science Daily, Google News Science
- Sports / Culture: Google News + ESPN, Pitchfork/Variety
- Google News categorized queries kept as broad-net catchers

Each source already has a `category` field; no schema change.

### 2. "Today" = since local midnight (`briefing.functions.ts`)
- Replace the 18-hour cutoff with a midnight boundary in the user's timezone.
- Read timezone from `preferences` (add a `timezone` column, default `UTC`) or fall back to a request-header-derived TZ. Store on the preferences row going forward.
- Items without a parseable `pubDate` are kept (RSS reality).

### 3. Don't pre-cap headlines fed to the model
- Remove the hard `slice(0, 60)`. Instead, send the full deduped set (could be 300–800 items) but in **chunks of ~120** per LLM call, then merge.
- Dedupe before chunking using a stronger key: normalized title + first source domain + token-shingle similarity (cheap Jaccard on 3-grams). Drops near-duplicates ("Trump signs X" vs "President Trump signs X bill").

### 4. Two-pass LLM summarization
- **Pass A — cluster**: each chunk → list of candidate clusters with member indices. Cheap model, JSON-only.
- **Pass B — merge & write**: feed all clusters back, ask the LLM to (a) merge clusters that are the same story across chunks, (b) write the full `BriefingTopic` (headline, hook, 60–90w explanation, why it matters, follow-ups) for **every distinct cluster — no fixed count**.
- Each topic carries **all** source URLs in its cluster (not capped at 4). UI shows "12 sources" with expand.
- Topics ordered by cluster size × source diversity × recency.

### 5. Briefing storage (`briefings` table)
- Keep current columns; topics array just gets longer.
- Add `total_topics`, `total_clusters_raw`, `coverage_window_start` for transparency ("47 stories from 28 sources since midnight").

### 6. UI changes (`src/routes/index.tsx`, new `BriefingList` component)
- Below the orb, render the full clustered list (scrollable). Each row: headline, hook, source-count chip, expand for explanation + sources.
- Voice button still plays the full briefing; topics in voice are read in the same order as the list.
- Add a "Jump to story" affordance — tapping a row tells the voice agent to skip to that topic (overrides via the existing agent context with the current topic index).
- "Read 47 stories aloud (~22 min)" instead of "5 stories · 5 min".

### 7. Voice agent prompt (`useVoiceAgent.ts`)
- System prompt: tell the agent it has N topics, deliver them all unless interrupted, keep each topic to ~30s spoken, and accept "next" / "skip" / "go deeper" interruptions.
- `firstMessage` mentions the real count and offers to skim headlines first.

### 8. Cost / latency guardrails
- Cache briefing window from 90 min → keep it but key it on `(user_id, date)` so the same calendar day reuses results unless `force`.
- LLM calls run in parallel per chunk; aggregate with `Promise.all`.
- Hard ceiling at 1000 raw items / 8 chunks per generation to avoid runaway cost; log when hit.

## Open items I'd handle inline (no further questions)
- Use Gemini Flash for clustering (cheap), Gemini Pro / GPT-4o-mini for the merge+write pass.
- For sources that block server-side fetch (rare with RSS), silently drop and log.

## Technical details

**Files touched**
- `src/lib/news/sources.ts` — expand registry to ~30 feeds
- `src/lib/news/rss.ts` — no change (already tolerant)
- `src/lib/news/briefing.functions.ts` — rewrite the pipeline: midnight cutoff, stronger dedupe, two-pass LLM, uncapped topics
- `src/lib/news/cluster.ts` *(new)* — Jaccard-shingle helper for dedupe/cluster scoring
- `src/components/BriefingList.tsx` *(new)* — expandable topic list
- `src/routes/index.tsx` — render list under the orb, update subtitle/CTA copy
- `src/hooks/useVoiceAgent.ts` — updated system prompt + first message
- Migration: add `timezone TEXT DEFAULT 'UTC'` to `preferences`; add `total_topics INT`, `coverage_window_start TIMESTAMPTZ` to `briefings`

**Out of scope (call out if you want them)**
- Per-region / per-language editions
- Push notifications when major news breaks mid-day
- User-tunable density slider ("show me 10 vs 50 stories")