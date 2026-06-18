import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
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
