/**
 * Compiles src/api-entry.ts into dist/server/api-entry.js using esbuild.
 * Run after the main Vite build so the output lands in the same dist/server/ dir.
 * Resolves @/ path alias (tsconfig "paths": { "@/*": ["./src/*"] }).
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, "src/api-entry.ts")],
  bundle: true,
  format: "esm",
  outfile: resolve(__dirname, "dist/server/api-entry.js"),
  platform: "node",
  target: "node20",
  // Treat built-in Node modules as external
  packages: "external",
  // Resolve @/ → src/
  alias: {
    "@": resolve(__dirname, "src"),
  },
});

console.log("[build-api] dist/server/api-entry.js ready");
