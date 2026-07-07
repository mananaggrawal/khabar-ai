/**
 * Quick 15 — builds one diverse, importance-weighted batch of stories for the
 * "Quick 15" listening mode (2026-07-06). Not a fixed/precomputed server-side
 * chunk — this runs client-side against whatever stories haven't been
 * consumed yet today, so "give me the next 15" is just calling this again
 * with an updated exclude set. No pipeline/backend change needed.
 *
 * Selection:
 *  1. A CAPPED lead-in of the top not-yet-consumed "headlines" stories (about
 *     20% of the batch, minimum 2) — enough to guarantee the day's biggest
 *     cross-cutting stories are covered without letting them swallow the
 *     whole batch. BUG FIX (2026-07-06): this used to take ALL not-yet-
 *     consumed headlines with no cap — on a headlines-heavy day that filled
 *     the entire 15-story batch before the round-robin step ever ran,
 *     producing an all-headlines batch instead of a diverse cross-section
 *     mix, defeating the actual point of Quick 15.
 *  2. The rest fill round-robin across ALL remaining sections — including
 *     any leftover headlines past the cap, which now compete fairly for
 *     slots alongside every other section instead of being either
 *     first-in-line or excluded — in a shuffled visit order each call (so
 *     it's not the same lineup every time), always taking the next MOST
 *     IMPORTANT not-yet-consumed story within a section before moving to
 *     that section's next pick. `stories` is assumed already
 *     importance-ordered within each section — true here because it comes
 *     straight from the generation pipeline's own importance-ordered list
 *     (see generator.ts clusterAndSelect's single-LLM ordering pass);
 *     filtering by section preserves that relative order.
 *
 * This gives cross-section diversity and a bit of day-to-day variety while
 * never picking a low-importance story over a high-importance one within the
 * same section, and — because it excludes consumed ids entirely — repeated
 * calls naturally work through the whole day's briefing without repeats
 * until it's exhausted.
 */
import type { Story } from "@/lib/news/generator";

export const QUICK_BATCH_SIZE = 15;
const HEADLINES_LEAD_SHARE = 0.2; // ~20% of the batch, minimum 2
const HEADLINES_LEAD_MIN = 2;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildQuickQueue(
  stories: Story[],
  consumedIds: Set<string>,
  count: number = QUICK_BATCH_SIZE,
): Story[] {
  const bySection = new Map<string, Story[]>();
  for (const s of stories) {
    if (consumedIds.has(s.id)) continue;
    if (!bySection.has(s.section)) bySection.set(s.section, []);
    bySection.get(s.section)!.push(s);
  }

  const result: Story[] = [];

  const headlinesCap = Math.max(HEADLINES_LEAD_MIN, Math.round(count * HEADLINES_LEAD_SHARE));
  const headlines = bySection.get("headlines") ?? [];
  const headlinesLead = headlines.slice(0, headlinesCap);
  const headlinesRest = headlines.slice(headlinesCap);
  for (const s of headlinesLead) {
    if (result.length >= count) break;
    result.push(s);
  }
  // Leftover headlines go back into the pool as just another section, so they
  // compete fairly for the remaining slots instead of being fully excluded.
  if (headlinesRest.length > 0) bySection.set("headlines", headlinesRest);
  else bySection.delete("headlines");

  const sectionIds = shuffle([...bySection.keys()]);
  const cursors = new Map(sectionIds.map((id) => [id, 0]));
  let progressed = true;
  while (result.length < count && progressed) {
    progressed = false;
    for (const id of sectionIds) {
      if (result.length >= count) break;
      const arr = bySection.get(id)!;
      const idx = cursors.get(id)!;
      if (idx < arr.length) {
        result.push(arr[idx]);
        cursors.set(id, idx + 1);
        progressed = true;
      }
    }
  }

  return result;
}
