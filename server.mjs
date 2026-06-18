/**
 * Production HTTP server entry for TanStack Start on Render.
 * Wraps the Vite SSR bundle (dist/server/server.js) in a Node.js HTTP server
 * using h3-v2's built-in node adapter.
 *
 * Usage: node server.mjs
 */
import { serve } from "h3-v2/node";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverBundle = join(__dirname, "dist", "server", "server.js");

if (!existsSync(serverBundle)) {
  console.error(`[khabar] Server bundle not found at ${serverBundle}`);
  console.error("[khabar] Run 'npm run build' first.");
  process.exit(1);
}

// Import the compiled TanStack Start server
const { default: handler } = await import(serverBundle);

const PORT = parseInt(process.env.PORT || "3000", 10);

// h3-v2/node serve() accepts { fetch } — same Web Fetch API interface
// that TanStack Start's server entry exports.
const server = serve(
  { fetch: handler.fetch.bind(handler) },
  { port: PORT, hostname: "0.0.0.0" }
);

server.then?.(() => {}) ?? void 0;

console.log(`[khabar] Server listening on http://0.0.0.0:${PORT}`);
