// Lightweight text similarity + clustering helpers. No deps.

const STOP = new Set([
  "the","a","an","and","or","but","of","in","on","for","to","at","by","with",
  "is","are","was","were","be","been","being","as","it","its","this","that",
  "from","into","over","after","before","says","say","said","new","report",
  "reports","amid","near","against","than","more","most","up","down","off",
  "us","u.s.","u.s","uk","eu",
]);

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return normalizeTitle(s).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
}

export function shingles(toks: string[], n = 2): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= toks.length - n; i++) out.add(toks.slice(i, i + n).join(" "));
  if (out.size === 0) toks.forEach((t) => out.add(t));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export type WithTitle = { title: string };

/** Greedy near-duplicate dedupe across the same news cycle. */
export function dedupeByTitle<T extends WithTitle>(items: T[], threshold = 0.55): T[] {
  const kept: { item: T; sh: Set<string> }[] = [];
  for (const it of items) {
    const sh = shingles(tokens(it.title), 2);
    let dup = false;
    for (const k of kept) {
      if (jaccard(sh, k.sh) >= threshold) { dup = true; break; }
    }
    if (!dup) kept.push({ item: it, sh });
  }
  return kept.map((k) => k.item);
}
