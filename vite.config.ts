import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Workaround for @tanstack/start-plugin-core@1.171 vs @tanstack/router-plugin@1.168 mismatch.
 *
 * start-plugin-core@1.171 expects router-plugin to call plugin.onRouteTreeChanged()
 * and plugin.init() lifecycle hooks, which router-plugin@1.168 does not implement.
 * As a result, globalThis.TSS_ROUTES_MANIFEST is never populated, causing:
 *   TypeError: Cannot convert undefined or null to object
 *   at Object.entries() in buildRouteManifestRoutes
 *
 * Fix: pre-populate TSS_ROUTES_MANIFEST from the committed routeTree.gen.ts
 * before the SSR manifest plugin reads it.
 */
function fixRoutesManifest(): Plugin {
  return {
    name: "fix-tss-routes-manifest",
    enforce: "pre",
    buildStart() {
      if ((globalThis as any).TSS_ROUTES_MANIFEST) return; // already set
      const src = "src/routes";
      (globalThis as any).TSS_ROUTES_MANIFEST = {
        "__root__": {
          filePath: `${src}/__root.tsx`,
          children: ["/", "/_authenticated", "/auth"],
        },
        "/": { filePath: `${src}/index.tsx`, children: undefined },
        "/_authenticated": {
          filePath: `${src}/_authenticated/route.tsx`,
          children: ["/_authenticated/history", "/_authenticated/settings"],
        },
        "/auth": { filePath: `${src}/auth.tsx`, children: undefined },
        "/_authenticated/history": {
          filePath: `${src}/_authenticated/history.tsx`,
          children: undefined,
        },
        "/_authenticated/settings": {
          filePath: `${src}/_authenticated/settings.tsx`,
          children: undefined,
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [
    fixRoutesManifest(),
    tanstackStart({
      router: {
        generatedRouteTree: "./src/routeTree.gen.ts",
        routesDirectory: "./src/routes",
      },
    }),
    viteReact(),
    tsconfigPaths(),
    tailwindcss(),
  ],
});
