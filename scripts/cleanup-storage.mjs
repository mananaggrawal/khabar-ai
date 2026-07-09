#!/usr/bin/env node
/**
 * Deletes old briefing data from Supabase Storage (bucket "khabar") to free
 * up quota — briefings/YYYY-MM-DD.json, logs/YYYY-MM-DD.log, and
 * audio/YYYY-MM-DD-<storyId>-<lang>.mp3, for every date older than a cutoff.
 *
 * Why a script instead of SQL: the actual briefing/audio data lives in
 * Supabase STORAGE (an object store), not a Postgres table — deleting rows
 * from the internal storage.objects table via raw SQL does not reliably
 * free the underlying storage on hosted Supabase, so this uses the real
 * Storage API instead (same client the app itself uses to upload).
 *
 * Usage (from repo root):
 *   node scripts/cleanup-storage.mjs           # keep last 3 days (default)
 *   node scripts/cleanup-storage.mjs --keep=7  # keep last 7 days
 *   node scripts/cleanup-storage.mjs --dry-run # list what WOULD be deleted, delete nothing
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — reads from .env if present,
 * same as scripts/generate.mjs.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

try {
  const env = readFileSync(join(root, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch {
  console.warn("[cleanup-storage] Warning: could not read .env file");
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keepArg = args.find((a) => a.startsWith("--keep="));
const KEEP_DAYS = keepArg ? Number(keepArg.split("=")[1]) : 3;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const BUCKET = "khabar";

// Cutoff: keep the last KEEP_DAYS calendar days (today counts as day 0), so
// with the default of 3, today/yesterday/day-before survive.
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - (KEEP_DAYS - 1));
const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

console.log(`[cleanup-storage] Keeping ${KEEP_DAYS} day(s) — deleting anything dated before ${cutoffStr}${dryRun ? " (DRY RUN)" : ""}`);

// Pulls every object under a prefix, paginating past Storage's 100-per-call
// default limit (bucket has grown well past that if we're here to prune it).
async function listAll(prefix) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list(${prefix}) failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// briefings/YYYY-MM-DD.json and logs/YYYY-MM-DD.log — the date is the whole
// filename (minus extension), so a plain string prefix compare works.
async function pruneDatedFolder(folder) {
  const files = await listAll(folder);
  const toDelete = files
    .filter((f) => f.name < `${cutoffStr}`) // "2026-07-05.json" < "2026-07-06" sorts correctly as plain strings
    .map((f) => `${folder}/${f.name}`);
  console.log(`[cleanup-storage] ${folder}/: ${files.length} total, ${toDelete.length} older than cutoff`);
  if (toDelete.length && !dryRun) {
    // Storage remove() also caps out per call — batch defensively.
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) throw new Error(`remove() failed on ${folder}: ${error.message}`);
    }
  }
  return toDelete;
}

// audio/YYYY-MM-DD-<storyId>-<lang>.mp3 — date is only the FIRST 10 chars of
// the filename, not the whole thing, so it needs its own prefix check.
// Extracts a YYYY-MM-DD date from a filename regardless of naming scheme —
// current per-story files embed it at the start; older, no-longer-produced
// combined-per-section .wav leftovers instead embed it after a "briefing-"
// prefix. Matching both prevents a stale, differently-named file from
// escaping pruning just because it predates the current filename format.
function extractDate(name) {
  const m = name.match(/^(?:briefing-)?(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function pruneAudio() {
  const files = await listAll("audio");
  const toDelete = files
    .filter((f) => {
      const d = extractDate(f.name);
      return d !== null && d < cutoffStr;
    })
    .map((f) => `audio/${f.name}`);
  console.log(`[cleanup-storage] audio/: ${files.length} total, ${toDelete.length} older than cutoff`);
  if (toDelete.length && !dryRun) {
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) throw new Error(`remove() failed on audio: ${error.message}`);
    }
  }
  return toDelete;
}

const briefingsDeleted = await pruneDatedFolder("briefings");
const logsDeleted      = await pruneDatedFolder("logs");
const audioDeleted     = await pruneAudio();

console.log("=".repeat(60));
console.log(`${dryRun ? "Would delete" : "Deleted"}: ${briefingsDeleted.length} briefing(s), ${logsDeleted.length} log(s), ${audioDeleted.length} audio file(s)`);
