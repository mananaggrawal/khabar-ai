#!/usr/bin/env node
/**
 * Daily briefing generator — CLI entry point.
 *
 * Usage (from khabar-ai/):
 *   node scripts/generate.mjs
 *
 * Or via curl when the dev server is running:
 *   curl -X POST http://localhost:3000/api/admin/generate \
 *        -H "x-admin-key: $(grep ADMIN_KEY .env | cut -d= -f2)"
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// Load .env manually (no dotenv dependency needed)
try {
  const env = readFileSync(join(root, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch {
  console.warn("[generate] Warning: could not read .env file");
}

// Dynamic import after env is loaded
const { generateDailyBriefing } = await import("../src/lib/news/generator.ts").catch(() =>
  import("../src/lib/news/generator.js"),
);

console.log("=".repeat(60));
console.log("Khabar AI — Daily Briefing Generator");
console.log("=".repeat(60));

try {
  const briefing = await generateDailyBriefing();
  console.log("\n✓ Done!");
  console.log(`  Date:    ${briefing.date}`);
  console.log(`  Topics:  ${briefing.topics.length}`);
  console.log(`  Audio:   ${briefing.audioUrl ?? "(none)"}`);
  console.log(`  Script:  ${briefing.monologueScript.length} chars`);
} catch (err) {
  console.error("\n✗ Generation failed:", err?.message ?? err);
  process.exit(1);
}
