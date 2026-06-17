# The real bug: enriched context never reaches the agent

You are right. The data fetch and enrichment are working — but the agent is answering from stale/empty context because **the contextual update is being rejected at the transport layer**.

From the live console:

```
[voice] connected
Failed to send message via WebRTC:
TypeError: Message too large (can send a maximum of 65535 bytes)
    at e.send (...)
    at sendMessage (...)
```

ElevenLabs' WebRTC data channel has a hard 65,535-byte per-message cap. In `useVoiceAgent.ts` we build one giant string (system prompt + compact index + the full enriched `buildBriefingContext` JSON with `deepBrief`, `background`, `keyFacts`, `qa`, and `articleExcerpts` for every non-quick-hit topic) and push it through a single `conversation.sendContextualUpdate(...)`. With 8 home + 6 world enriched topics it blows past 64 KB on the first send, the channel throws, and **none of the enrichment lands**. The agent then runs on whatever it can scrape from its own first-message opener + system prompt — i.e. yesterday-ish, generic, "I don't know" territory.

The kickoff `sendUserMessage` that follows ("Please begin the briefing now…") is small enough to go through, which is why the agent talks at all but sounds uninformed.

## Fix

Chunk the kickoff context into multiple sub-64 KB `sendContextualUpdate` calls, sent sequentially before the opener user message. Trim a few obvious fat points at the same time so the chunk count stays small.

### Changes to `src/hooks/useVoiceAgent.ts`

1. **New helper `splitForContextChannel(text, maxBytes = 60000)`** — splits a string on topic/section boundaries (the `},{` between topics in the JSON, or `\n--` separators in the compact index) into UTF-8-safe chunks ≤ ~60 KB (leaves headroom for the WebRTC framing overhead).

2. **Replace the single-message kickoff** in the `onConnect` handler. Instead of one `sendContextualUpdate(kickoff.context)`, iterate:
   ```
   for (const [i, part] of parts.entries()) {
     conversation.sendContextualUpdate(
       `BRIEFING CONTEXT PART ${i + 1}/${parts.length}:\n${part}`
     );
   }
   conversation.sendUserMessage(kickoff.opener);
   ```
   Wrap each `send` in try/catch so a single failed chunk does not abort the rest, and `console.warn` the index that failed.

3. **`pendingKickoffRef`** changes shape from `{ context, opener }` to `{ parts: string[], opener }`. `start()` builds the parts via `splitForContextChannel` after constructing the full context string.

4. **Trim the enrichment payload modestly** in `buildBriefingContext` to reduce chunk count (typically from ~4 chunks down to ~2):
   - `articleExcerpts`: cap to **2 per topic** (was unlimited), each excerpt sliced to **400 chars** (was 600).
   - `deepBrief`: cap to 1200 chars.
   - `background`: cap to 600 chars.
   - `keyFacts`: cap to first 8.
   - `qa`: cap to first 4 pairs.

   These caps lose nothing meaningful — the agent never reads excerpts verbatim, it summarises — but they make the channel reliable.

5. **Add an explicit log line** when chunks are sent: `console.log("[voice] sent context", parts.length, "chunks,", totalBytes, "bytes")` so we can confirm in the next session that the full pack landed.

### Verification

After the fix:
- Refresh the briefing (no schema/regen needed — this is a transport fix only).
- Start a session. Console should show `[voice] sent context N chunks, … bytes` and **no** `Message too large` error.
- Ask "go deeper on story 2" — agent should now quote facts/dates from `keyFacts` and the enriched `deepBrief` instead of hedging.

### Out of scope (intentionally)

- No backend / enrichment changes. The pack itself is already good; it just was not arriving.
- No reintroduction of the live-search tool. The chunked pack is the source of truth.
- No `index.ts` / ElevenLabs dashboard changes.

### Files touched

- `src/hooks/useVoiceAgent.ts` — chunking helper, kickoff loop, ref shape, payload caps in `buildBriefingContext`, one diagnostic log.
