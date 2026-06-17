## Fix double "Welcome" + improve intro + Indian accent

### 1. Double "Welcome" — root cause
Two places both say "Welcome to Khabar AI":
- `AGENT_SYSTEM_PROMPT` instructs: *Open EXACTLY with "Welcome to Khabar AI…"*
- `buildFirstMessage()` returns a string starting with "Welcome to Khabar AI…", which is then sent as `Please begin the briefing now. Start with: "<opener>"`.

The agent obeys both → says Welcome, then the opener (which also starts with Welcome).

**Fix:** make the opener the single source of truth. In `AGENT_SYSTEM_PROMPT`, replace the "Open EXACTLY with…" rule with: *"Your opening line is provided in the kickoff message — read it naturally, then continue. Do NOT prepend your own greeting."* Keep `buildFirstMessage()` as the one that produces the welcome.

### 2. Improve the intro
Rewrite `buildFirstMessage()` to be warmer, more conversational, India-flavoured, and clearer about controls. New shape (still one short paragraph):

> "Namaste, and welcome to Khabar AI — your daily catch-up on what's happening and why it matters. Today we've got {N from India}, {M from around the world}, and {K quick hits} — about fifteen minutes in all. Jump in anytime: say 'next' to skip, 'go deeper' for more, or name a story to jump to. Let's get into it."

- Uses "Namaste" only when `homeCountry === "in"`; otherwise a neutral "Hey, welcome to Khabar AI…".
- Keeps the dynamic counts.
- Mentions runtime + the three voice commands explicitly (matches what the system prompt already promises).
- Empty-briefing branch stays.

### 3. Indian accent
The accent is determined by the **ElevenLabs voice**, not the prompt. Two ways to set it:

**A. Agent dashboard (recommended, zero code):** in the ElevenLabs agent settings, change the voice to an Indian-English voice (e.g. "Monika Sogam – Indian English", "Niraj – Hindi-English", or any Indian voice from the Voice Library). This is the cleanest fix and sticks across sessions.

**B. Per-session override in code:** pass `overrides.tts.voiceId` to `useConversation`. Requires "Voice ID" override to be enabled in the agent dashboard, and we need the specific voice ID to hardcode.

I'll proceed with **A** by default (no code change for the voice) and additionally add a light prompt nudge: *"Speak in natural Indian English — warm, unhurried, with Indian pronunciations of names and places."* This won't change the accent of the synthesised voice but helps with name pronunciation and pacing.

If you'd rather I wire option B, give me the voice ID and I'll set it via `overrides.tts.voiceId`.

### Files touched
- `src/hooks/useVoiceAgent.ts` — edit `AGENT_SYSTEM_PROMPT` (remove "Open EXACTLY with", add "Speak in natural Indian English"); rewrite `buildFirstMessage()`.

### Verification
- Start a fresh session → agent says "Namaste, and welcome to Khabar AI…" exactly once, no second "Welcome".
- Console still shows `[voice] sent context N chunks, … bytes`.
- If you switch the dashboard voice to an Indian one, the accent updates on the next session.
