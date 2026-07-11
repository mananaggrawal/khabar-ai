/**
 * IST (India Standard Time, UTC+5:30) date helpers.
 *
 * BUG FIX (2026-07-11): the whole product reasons in IST — the audience,
 * the news cycle, "today" as a user means it — but every date-keyed piece
 * of the pipeline (briefing storage keys, generation logs, storage pruning,
 * push-send logs) used to compute `new Date().toISOString().slice(0, 10)`
 * directly, which is UTC. Since IST is UTC+5:30, anything running before
 * 5:30 AM IST computed YESTERDAY's UTC date — so the early-morning cron
 * (scheduled ~4:30 AM IST) filed its log and its saved briefing under the
 * previous calendar day. Checking "today's" log/briefing under the actual
 * IST date found nothing, looking exactly like a failed/missing run when
 * the run had actually succeeded — it was just one day-key to the left.
 *
 * This is the one place that IST conversion happens, so every caller agrees
 * on what day it is.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Current instant, shifted so UTC getters on it read as IST wall-clock time. */
export function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/** YYYY-MM-DD for the given instant (default: now), in IST. */
export function istDateKey(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD for `daysAgo` days before today, in IST (0 = today). */
export function istDateKeyDaysAgo(daysAgo: number): string {
  return istDateKey(new Date(Date.now() - daysAgo * 86_400_000));
}

/** The UTC epoch ms corresponding to the most recent IST midnight. */
export function istMidnightUtcMs(): number {
  const nowIST = istNow();
  return Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET_MS;
}
