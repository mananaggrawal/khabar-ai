## Plan

1. **Stop app-side prompt/control injection completely**
   - Remove the remaining unused prompt builders and auto-start/control helpers from `src/hooks/useVoiceAgent.ts`.
   - Keep `startSession()` minimal so ElevenLabs dashboard configuration owns the first message and speaking flow.

2. **Fix the “Agent rejected the session” signal**
   - The screenshot shows `e.error_event.error_type` and says the agent is returning an invalid error packet before audio starts.
   - Update voice error handling so malformed ElevenLabs SDK error events do not crash the UI or show noisy internal text.
   - Keep a short user-facing error only when the session truly fails.

3. **Prevent the app from making the agent wait after intro**
   - Remove all remaining client logic that implies resume/jump control or hidden system messages.
   - Ensure the app does not send text messages or contextual updates after connect; the agent should continue from its ElevenLabs first-message/system prompt.

4. **Keep UI transcript clean**
   - Continue hiding user responses in the on-screen transcript.
   - Hide only the app display noise, not agent speech/audio.

5. **Verify behavior**
   - Use the live preview to start a briefing and check that the app no longer shows the invalid SDK packet error and no app-side control messages are sent.