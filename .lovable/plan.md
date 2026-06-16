## What we're changing

Three connected problems: no Indian coverage, briefing too long/dense, and a vague open instead of a geographically anchored intro. Plan addresses all three.

## 1. India sources + country-aware RSS registry

Restructure `src/lib/news/sources.ts` so every source is tagged with a `country` field (`"in"`, `"us"`, `"uk"`, `"global"`).

Add India feeds:
- The Hindu (national, world, business), Times of India (top, India, world, business), Hindustan Times (top, India)
- Indian Express (front, India), LiveMint (markets), Moneycontrol (business)
- NDTV (top, India), Scroll, The Wire
- Google News India: top + per-category (world, tech, markets, science, sports, culture) using `hl=en-IN&gl=IN&ceid=IN:en`

Existing US/UK/global feeds stay, tagged accordingly.

## 2. Country picker in Settings

Schema change: add `home_country text not null default 'in'` to `preferences`. (Migration step.)

Settings page (`src/routes/_authenticated/settings.tsx`): add a "Home" section above Interests with a small grid of supported countries (India, US, UK, Global — start with these four; easy to extend). Save via `savePreferences`.

Update `getPreferences`/`savePreferences` server fns and `loadPreferredCategories` to also read/write `home_country`.

## 3. Tiered briefing pipeline (caps the ~15 min budget)

Rework `fetchBriefing` in `src/lib/news/briefing.functions.ts` to produce three tiers instead of one flat list:

```text
tier        target count   per-story length        ~spoken time
─────────   ────────────   ──────────────────────  ─────────────
home        8 deep-dives   hook + 40-60w explain   ~7 min
world       6 stories      hook + 25-35w explain   ~4 min
quick_hits  6 bullets      headline + 1-line hook  ~3 min
                                                   ≈14 min total
```

Pipeline:
1. Fetch RSS partitioned by country: home-country sources → home pool; everything else → world pool.
2. Cluster each pool separately (existing `clusterChunk` logic, unchanged).
3. Pass A unchanged. Pass B (`mergeAndWrite`) gets a new prompt that explicitly asks for the three tiers with hard counts and per-tier word budgets, returns `{ home: [...], world: [...], quickHits: [...] }`.
4. Persist as `topics_tiered jsonb` on `briefings` (keep legacy `topics` for back-compat — flatten home+world+quickHits into it so nothing else breaks).

Types: extend `BriefingTopic` with `tier: "home" | "world" | "quick_hit"` and make `explanation`/`whyItMatters`/`followUps` optional (quick-hits skip them).

## 4. Layered story cards

`src/components/BriefingList.tsx`:
- Group rendering by tier with section headers ("From India", "Around the world", "Quick hits").
- Each card shows headline + hook by default. Explanation, why-it-matters, follow-ups, sources collapse behind a "More" disclosure (existing data, just hidden).
- Quick-hits render as a compact bulleted list, no expansion.

## 5. Voice agent opener anchored to geography

`src/hooks/useVoiceAgent.ts` — update the compact index + contextual update to:
- Lead with a one-sentence "Good morning. Today from India:" then the home headlines numbered 1-8.
- Then "Around the world:" with world headlines 9-14.
- Then "And in brief:" with quick-hits 15-20.
- Kickoff message becomes `"Start the briefing. Begin with the India stories, then world, then quick hits. Keep total runtime around 15 minutes."`

No SDK / overrides changes — same `sendContextualUpdate` + `sendUserMessage` flow we landed last turn.

## Technical notes

- **Migration**: `ALTER TABLE preferences ADD COLUMN home_country text NOT NULL DEFAULT 'in';` plus `ALTER TABLE briefings ADD COLUMN topics_tiered jsonb;`. RLS/grants unchanged.
- **Caching**: today's-briefing reuse logic stays; we just read the new column.
- **Failure modes**: if India pool is empty (RSS outage), fall back to world tier filling all 14 slots — never blank.
- **No backend keys or new secrets needed.**

## Files touched

- `supabase` migration (new columns)
- `src/lib/news/sources.ts` — add country field + India feeds
- `src/lib/news/briefing.functions.ts` — tiered pipeline, new prompts, persist tiered topics
- `src/lib/voice/messages.functions.ts` — read/write `home_country`
- `src/routes/_authenticated/settings.tsx` — country picker section
- `src/components/BriefingList.tsx` — tier sections + collapsible details
- `src/hooks/useVoiceAgent.ts` — geography-anchored opener
