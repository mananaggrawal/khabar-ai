/**
 * Compiles src/api-entry.ts into dist/server/api-entry.js using Vite's
 * programmatic build API. Runs after the main vite build.
 */
import { build } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  configFile: false,
  plugins: [tsconfigPaths()],
  build: {
    // SSR entry mode: bundles app code, externalises node_modules
    ssr: resolve(__dirname, "src/api-entry.ts"),
    outDir: resolve(__dirname, "dist/server"),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        format: "esm",
        entryFileNames: "api-entry.js",
      },
    },
  },
  logLevel: "warn",
});

console.log("[build-api] dist/server/api-entry.js ready");
