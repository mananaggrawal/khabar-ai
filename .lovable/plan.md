## Two fixes in `src/hooks/useVoiceAgent.ts`

### 1. Never show "YOU · …" in the transcript
Right now `shouldHideTranscriptLine` only hides specific user phrases (the auto-start prompt). The user wants **all** user lines hidden from the UI.

- Change `shouldHideTranscriptLine` so any `role === "user"` line returns `true` (hidden).
- Keep server-side persistence of user messages (the `persistMessage` call) so history/coverage logic still works — the hide check only gates the on-screen `setTranscript` push.

### 2. Agent must start the briefing on its own
Today the auto-start path:
- Sends `firstMessage: opener` via `startSession`. If the ElevenLabs dashboard override is off, the agent never speaks it.
- 1.8s after connect, fires a single `sendUserMessage(prompt)` — but only if `isSpeaking` is false and the agent hasn't spoken. If the kickoff context (heavy, ~30KB, sent over ~paced 350ms chunks for several seconds) is still streaming, the agent often stays idle waiting and the one-shot prompt arrives before context is fully delivered, so the agent doesn't actually start.

Make the trigger fire **after** the context chunks finish, and retry if the agent stays silent:

- Move the auto-start prompt send to the end of the kickoff-chunks async block (right after the final `sendContextualUpdate` + a short drain delay), instead of a fixed 1.8s timer racing the chunks.
- Add a short retry: if `agentSpokeRef.current` is still false ~2.5s after the first prompt, re-send the auto-start prompt once. Cap at 2 sends total to avoid loops.
- Keep the existing `onModeChange` listening-mode fallback for cases where the agent connects without a kickoff (resume on same briefing).
- The auto-start prompt text already instructs "no greeting, continue as monologue", so the agent will begin the first story immediately.

### Out of scope
No backend, ElevenLabs dashboard, or UI component changes — only the hook's transcript filter and auto-start sequencing.