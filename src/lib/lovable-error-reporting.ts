// Stub — Lovable error reporting removed. Errors go to console only.
export function reportLovableError(error: unknown, context: Record<string, unknown> = {}) {
  console.error("[error]", error, context);
}
