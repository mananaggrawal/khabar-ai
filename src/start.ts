import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { handleGenerate, handleAsk } from "@/lib/api/handlers";

// ── API route middleware ───────────────────────────────────────────────────
// TanStack Start only picks up new route files after a dev-server restart.
// Handling admin + Q&A here avoids that limitation entirely.
const apiMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/generate" && request.method === "POST") {
    return handleGenerate(request);
  }
  if (url.pathname === "/api/ask" && request.method === "POST") {
    return handleAsk(request);
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
