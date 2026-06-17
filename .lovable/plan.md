## Plan

1. **Use the right monologue model**
   - Treat ElevenLabs Conversational AI as turn-based: it can speak a first message automatically, but after that it normally waits for user input.
   - For a true news monologue, the app must provide one complete briefing as the agent's opening turn, or deliberately send a silent kickoff/user-turn after connect.
   - Do not rely on a watchdog restart as the primary solution; restarting can replay the intro and create WebRTC reconnect errors.

2. **Recommended implementation**
   - Generate/assemble the full spoken briefing text from the app's existing briefing data.
   - Start the ElevenLabs session with a dynamic `firstMessage` override containing the full monologue.
   - Keep the app from sending hidden control prompts during playback.
   - Keep the transcript UI showing only agent speech.

3. **Fallback if dynamic first-message override is unavailable**
   - Start the session normally, then send exactly one concise kickoff message after connect, such as “Read today’s full briefing now as a continuous monologue.”
   - Hide that kickoff from the UI and never send repeated control messages.
   - Disable the current restart watchdog or limit it to connection failure recovery only.

4. **ElevenLabs configuration required**
   - Enable conversation overrides for the agent if using dynamic `firstMessage` from the app.
   - Set the agent prompt to behave as a proactive newsreader: read the complete briefing continuously, do not ask a question after the intro, and only pause for real user interruptions.
   - Keep the dashboard first message short or generic if the app supplies the full dynamic first message.

5. **Verification**
   - Start a briefing and confirm the agent begins speaking without user speech.
   - Confirm it continues past the intro into the briefing body.
   - Confirm no hidden repeated prompts, no replay loop, and no unnecessary session restart while the agent is simply listening.