import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ElevenLabsTokenResponse =
  | { ok: true; token: string; agentId: string }
  | { ok: false; reason: "missing_api_key" | "missing_agent_id" | "upstream_error"; detail?: string };

/**
 * Mints a short-lived WebRTC conversation token for the configured agent.
 * Returns a typed failure when ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID are not set,
 * so the UI can show a friendly "voice not configured" state.
 */
export const getElevenLabsToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ElevenLabsTokenResponse> => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey) return { ok: false, reason: "missing_api_key" };
    if (!agentId) return { ok: false, reason: "missing_agent_id" };

    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey } },
      );
      if (!res.ok) {
        const text = await res.text();
        console.error("ElevenLabs token error", res.status, text);
        return { ok: false, reason: "upstream_error", detail: `HTTP ${res.status}` };
      }
      const json = await res.json();
      if (!json.token) {
        return { ok: false, reason: "upstream_error", detail: "no token in response" };
      }
      return { ok: true, token: json.token as string, agentId };
    } catch (e) {
      console.error("ElevenLabs token exception", e);
      return { ok: false, reason: "upstream_error", detail: String(e) };
    }
  });
