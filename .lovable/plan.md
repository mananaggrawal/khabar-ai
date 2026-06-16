# Fix flicker + slower/casual voice

## 1. Subtitle flicker (the "two sections" swapping)

**Cause:** In `src/routes/index.tsx`, the line under the orb recomputes every render based on `voice.orbState`:

- when `orbState === "speaking"` → "NewsPilot is speaking"
- otherwise (connected) → "Listening — say 'next', 'skip', or 'go deeper'"

`isSpeaking` from `useConversation` flips on/off many times per second during natural pauses between sentences, so the subtitle (and the headline above it, which also branches on `connected`) visibly flickers while the agent talks.

**Fix:** stop branching the subtitle on `isSpeaking`. While connected, show one stable line — e.g. "NewsPilot is on. Say 'next', 'skip', or 'go deeper'." The orb itself already animates speaking vs listening, so we don't need the text to mirror that. (Optional polish: debounce orbState transitions by ~400 ms before using it for any text, but removing the text branch is enough to kill the flicker.)

Only `src/routes/index.tsx` changes — one `subtitle` ternary simplified, no logic in the voice hook touched.

## 2. Voice changes not reflecting

Today the app does **not** send any `overrides.tts` or `overrides.agent` when starting the session (see `useVoiceAgent.ts` → `conversation.startSession({ conversationToken, connectionType: "webrtc" })`). That means whatever you set on the ElevenLabs agent (voice, stability, speed, style) **should** apply — there are no client overrides fighting it.

If your dashboard edits aren't showing up, it's almost always one of:

- the agent wasn't **saved/published** after editing — ElevenLabs requires an explicit save on the agent page;
- you edited a **different agent** than the one bound to `ELEVENLABS_AGENT_ID`;
- the browser kept an old WebRTC session — fully end the call (X button) and start a new one;
- you changed the **voice's default settings in the Voice Library** but the agent has its own voice settings override that's still winning — change it on the agent itself.

So: you can keep doing it from ElevenLabs, no code change required for that to take effect. Just save the agent and start a fresh session.

### If you'd rather control "slower + more casual" from code

I can add `overrides` to the `startSession` call so the app always asks for:

- `tts.stability`: ~0.45 (more expressive, less robotic)
- `tts.speed`: ~0.92 (a touch slower than default 1.0)
- `agent.prompt.prompt`: prepend a "speak casually, conversational, light wit, no anchor cadence" instruction to the existing system prompt

**Caveat:** for overrides to apply, the agent in the ElevenLabs dashboard must have **Security → Overrides** enabled for `tts.stability`, `tts.speed`, and `agent.prompt`. Otherwise ElevenLabs silently ignores them.

## Files touched
- `src/routes/index.tsx` — collapse the flickering subtitle/headline branch
- `src/hooks/useVoiceAgent.ts` — *only if you want code-side overrides for speed/casualness*

## Question for you
Do you want me to:
- **(a)** just fix the flicker and leave voice tuning to the ElevenLabs dashboard, or
- **(b)** fix the flicker **and** add code-side overrides (slower speed + casual tone) — and you'll enable overrides on the agent?
