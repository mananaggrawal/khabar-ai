import { createStart, createMiddleware } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { handleGenerate, handlePatchMissing, handleAsk, handleTrack, handleAnalytics, handleBriefing } from "@/lib/api/handlers";

// ── API route middleware ───────────────────────────────────────────────────
// TanStack Start only picks up new route files after a dev-server restart.
// Handling admin + Q&A here avoids that limitation entirely.
const apiMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);

  // Serve generated audio files from disk (needed in production where
  // Nitro only serves .output/public/ but audio is written to public/audio/)
  if (url.pathname.startsWith("/audio/") && request.method === "GET") {
    const filename = url.pathname.slice(7);
    if (filename && !filename.includes("..")) {
      try {
        const file = await readFile(join(process.cwd(), "public", "audio", filename));
        return new Response(file, {
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch {
        return new Response("Audio not found", { status: 404 });
      }
    }
  }

  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/admin/generate" && request.method === "POST") {
    return handleGenerate(request);
  }
  if (url.pathname === "/api/admin/patch-missing" && request.method === "POST") {
    return handlePatchMissing(request);
  }
  if (url.pathname === "/api/ask" && request.method === "POST") {
    return handleAsk(request);
  }
  if (url.pathname === "/api/track" && request.method === "POST") {
    return handleTrack(request);
  }
  if (url.pathname === "/api/admin/analytics" && request.method === "GET") {
    return handleAnalytics(request);
  }
  if (url.pathname === "/api/briefing" && request.method === "GET") {
    return handleBriefing(request);
  }
  return next();
});

// ── Error middleware ───────────────────────────────────────────────────────
const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [apiMiddleware, errorMiddleware],
}));
