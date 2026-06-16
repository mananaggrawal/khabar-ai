## Diagnosis

Console shows the flow is:
1. `startSession` is called with `overrides.agent.prompt` + `firstMessage`
2. ElevenLabs server sends back an error event (likely "overrides not enabled for this agent")
3. SDK crashes inside `handleErrorEvent` reading `error_type` on an undefined payload → unhandled promise rejection
4. The session then *does* connect briefly, but our `setTimeout(...sendContextualUpdate, 600)` fires after disconnect → "No active conversation"
5. UI shows "Couldn't reach the voice agent"

Root cause: the ElevenLabs agent in the dashboard does not have **Overrides → System prompt / First message** enabled, so the server rejects our override and tears down. We already asked the user to toggle these; rather than depending on a dashboard checkbox, make the client robust without overrides.

## Fix

**1. `src/hooks/useVoiceAgent.ts` — remove overrides, push everything via contextual updates**

- Drop the `overrides` block from `startSession` entirely. The agent's system prompt + voice are configured once in the ElevenLabs dashboard (NewsPilot anchor persona).
- After `onConnect` fires (not via `setTimeout`), call `sendContextualUpdate(...)` with:
  - The NewsPilot operating instructions (what was in `AGENT_SYSTEM_PROMPT`, reframed as "for this session, follow these rules")
  - The compact headline index
  - The full briefing JSON
  - The "user tapped story N" hint when `jumpToIndex` is provided
- Then call `sendUserMessage("Begin the briefing now.")` (or the jump variant) so the agent speaks first without needing a `firstMessage` override.
- Fire the contextual update from the `onConnect` callback so we don't race the WebRTC handshake.

**2. Defensive error handler**

- In `onError`, guard against undefined payloads so the SDK's `error_type` crash surfaces as a clean `configError` instead of an unhandled rejection.
- Set `configError = "upstream_error"` and call `conversation.endSession()` when an error event arrives.

**3. Update the failure-mode UX copy**

- When `configError === "upstream_error"`, hint at "agent rejected the session — check the agent exists and is published in ElevenLabs" instead of the current generic message.

## What the user needs to do in ElevenLabs (one-time, dashboard)

Since we're removing runtime overrides, the agent's permanent config must hold the persona:
- **System prompt**: paste the NewsPilot anchor prompt (I'll include it in the implementation notes so the user can copy it)
- **Voice**: Brian (`nPczCjzI2devNBz1zQrb`) or any preferred voice
- **First message**: leave blank or generic ("Ready when you are.") — we'll trigger the real opener via `sendUserMessage`
- **Client events**: ensure `user_transcript` and `agent_response` are enabled
- **Overrides**: no longer required ✅

## Files touched

- `src/hooks/useVoiceAgent.ts` — remove overrides, move briefing injection into `onConnect`, harden `onError`
- `src/routes/index.tsx` — tweak the `configError` copy (1 line)

No backend / migration changes.
