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
 *     first-in-line or excluded — always taking the next MOST IMPORTANT
 *     not-yet-consumed story within a section before moving to that
 *     section's next pick. `stories` is assumed already importance-ordered
 *     within each section — true here because it comes straight from the
 *     generation pipeline's own importance-ordered list (see generator.ts
 *     clusterAndSelect's single-LLM ordering pass); filtering by section
 *     preserves that relative order.
 *
 * VOICE ALTERNATION (2026-07-06 fix): each story's narrating voice (A/B) is
 * decided once, at TTS-generation time, based on its position among same-
 * section stories — see generator.ts's sectionCounters / edge.ts's
 * pickVoiceByIndex. That's baked into the audio file itself; nothing client-
 * side can change WHICH voice a given clip uses. But Quick 15 pulls one story
 * per section per round, and each section's A/B assignment is an independent
 * coin flip from every other section's — so two adjacent picks from
 * different sections landing on the same voice back-to-back was pure chance,
 * and reported as "stories coming in a single voice" after a refresh. Fixed
 * by inferring each candidate's baked-in voice (inferVoiceIndex, replicating
 * generator.ts's exact algorithm) and, at each fill step, preferring
 * whichever available section's next candidate differs in voice from the
 * last placed story — without ever skipping ahead within a section (so
 * importance order is never violated to chase alternation).
 *
 * This gives cross-section diversity, alternating voices, and a bit of
 * day-to-day variety while never picking a low-importance story over a
 * high-importance one within the same section, and — because it excludes
 * consumed ids entirely — repeated calls naturally work through the whole
 * day's briefing without repeats until it's exhausted.
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

// Replicates generator.ts's voice assignment exactly: a running counter per
// section, incremented in array order, voice = counter % 2. Requires
// `stories` to be in the same relative per-section order the generation
// pipeline used (true for briefing.stories — see the comment above) to
// actually match the real audio file's voice; this is inference, not a
// stored fact (the pipeline doesn't persist which voice a story got), so
// treat it as a strong heuristic rather than a guarantee.
function inferVoiceIndices(stories: Story[]): Map<string, 0 | 1> {
  const counters = new Map<string, number>();
  const voices = new Map<string, 0 | 1>();
  for (const s of stories) {
    const n = counters.get(s.section) ?? 0;
    voices.set(s.id, (n % 2) as 0 | 1);
    counters.set(s.section, n + 1);
  }
  return voices;
}

export function buildQuickQueue(
  stories: Story[],
  consumedIds: Set<string>,
  count: number = QUICK_BATCH_SIZE,
): Story[] {
  const voiceOf = inferVoiceIndices(stories);

  const bySection = new Map<string, Story[]>();
  for (const s of stories) {
    if (consumedIds.has(s.id)) continue;
    if (!bySection.has(s.section)) bySection.set(s.section, []);
    bySection.get(s.section)!.push(s);
  }

  const result: Story[] = [];
  let lastVoice: 0 | 1 | null = null;
  const place = (s: Story) => {
    result.push(s);
    lastVoice = voiceOf.get(s.id) ?? null;
  };

  // Headlines lead-in — voice-alternation-aware among just the headlines
  // pool itself, still capped and still in importance order otherwise.
  const headlinesCap = Math.max(HEADLINES_LEAD_MIN, Math.round(count * HEADLINES_LEAD_SHARE));
  const headlines = bySection.get("headlines") ?? [];
  const headlinesPool = headlines.slice(0, headlinesCap);
  const headlinesRest = headlines.slice(headlinesCap);
  const usedHeadlineIdx = new Set<number>();
  for (let picked = 0; picked < headlinesPool.length && result.length < count; picked++) {
    // Prefer the earliest (most important) remaining headline whose voice
    // differs from the last placed story; fall back to the earliest overall.
    let choice = headlinesPool.findIndex((s, i) => !usedHeadlineIdx.has(i) && (lastVoice === null || voiceOf.get(s.id) !== lastVoice));
    if (choice === -1) choice = headlinesPool.findIndex((_s, i) => !usedHeadlineIdx.has(i));
    if (choice === -1) break;
    usedHeadlineIdx.add(choice);
    place(headlinesPool[choice]);
  }
  // Leftover headlines (past the cap) go back into the pool as just another
  // section, so they compete fairly for the remaining slots instead of being
  // fully excluded.
  if (headlinesRest.length > 0) bySection.set("headlines", headlinesRest);
  else bySection.delete("headlines");

  const sectionIds = shuffle([...bySection.keys()]);
  const cursors = new Map(sectionIds.map((id) => [id, 0]));

  const nextAvailable = () => sectionIds.filter((id) => cursors.get(id)! < bySection.get(id)!.length);

  while (result.length < count) {
    const available = nextAvailable();
    if (available.length === 0) break;
    // Prefer a section whose next (most important remaining) candidate has a
    // different voice than the last placed story; never skips ahead within
    // a section to chase this — only WHICH section goes next changes.
    let id = available.find((sid) => {
      const s = bySection.get(sid)![cursors.get(sid)!];
      return lastVoice === null || voiceOf.get(s.id) !== lastVoice;
    });
    if (!id) id = available[0]; // everything left shares the same voice — take it anyway
    const idx = cursors.get(id)!;
    place(bySection.get(id)![idx]);
    cursors.set(id, idx + 1);
  }

  return result;
}

/**
 * Refreshes a Quick 15 batch IN PLACE — only slots whose story is already
 * consumed get replaced; everything else (including whatever's currently
 * playing) keeps its exact array position (see PlayerProvider.refreshQuickBatch
 * for why that matters for playback continuity).
 *
 * Unlike naively calling buildQuickQueue() for just the replacement count and
 * splicing the results in, this walks the FINAL array left to right and
 * picks each replacement against its actual final left neighbor (which may
 * itself be a story just placed by this same walk) — otherwise a freshly
 * inserted story could still clash with whatever ends up next to it, since
 * an isolated buildQuickQueue() call has no idea what it's being spliced
 * next to. This is what actually fixes "voices coming in a single voice
 * after refreshing" (2026-07-06).
 */
export function refreshQuickQueue(
  currentBatch: Story[],
  pool: Story[],
  consumedIds: Set<string>,
): Story[] {
  const replaceCount = currentBatch.filter((s) => consumedIds.has(s.id)).length;
  if (replaceCount === 0) return currentBatch;

  const voiceOf = inferVoiceIndices(pool);
  const stillActiveIds = new Set(currentBatch.filter((s) => !consumedIds.has(s.id)).map((s) => s.id));
  const excludeIds = new Set([...consumedIds, ...stillActiveIds]);

  const bySection = new Map<string, Story[]>();
  for (const s of pool) {
    if (excludeIds.has(s.id)) continue;
    if (!bySection.has(s.section)) bySection.set(s.section, []);
    bySection.get(s.section)!.push(s);
  }
  const sectionIds = shuffle([...bySection.keys()]);
  const cursors = new Map(sectionIds.map((id) => [id, 0]));
  const nextAvailable = () => sectionIds.filter((id) => cursors.get(id)! < bySection.get(id)!.length);

  const newBatch = [...currentBatch];
  for (let i = 0; i < newBatch.length; i++) {
    if (!consumedIds.has(newBatch[i].id)) continue; // untouched slot — leave exactly as is

    const lastVoice = i > 0 ? voiceOf.get(newBatch[i - 1].id) ?? null : null;
    const available = nextAvailable();
    if (available.length === 0) break; // pool exhausted — leave the old (consumed) story here rather than a gap

    let id = available.find((sid) => {
      const s = bySection.get(sid)![cursors.get(sid)!];
      return lastVoice === null || voiceOf.get(s.id) !== lastVoice;
    });
    if (!id) id = available[0]; // everything left shares the same voice — take it anyway

    const idx = cursors.get(id)!;
    newBatch[i] = bySection.get(id)![idx];
    cursors.set(id, idx + 1);
  }

  return newBatch;
}
