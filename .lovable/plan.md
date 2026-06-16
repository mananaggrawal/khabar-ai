
# NewsPilot — AI-native voice news agent

A voice-first news companion. Open the app, hit the orb, and a real-time agent gives you today's ~5-7 global stories in an intellectual-but-amusing tone. Interrupt anytime with your voice to go deeper. Built on ElevenLabs Conversational Agents (WebRTC, barge-in) for sub-second latency.

## Home screen — ElevenLabs "agent speaking" aesthetic

The home page mirrors ElevenLabs' conversational-agent UI: dark, near-empty canvas with one large audio-reactive orb in the center. The orb is the entire interface.

```text
┌──────────────────────────────────────┐
│                                       │
│     NewsPilot                ⚙  ↩    │
│                                       │
│                                       │
│                                       │
│              ╭─────────╮              │
│             ╱           ╲             │   ← animated blob/orb
│            │   ●  ● ●    │            │     soft gradient, audio-reactive
│             ╲           ╱             │     hue shifts: idle → listening → speaking
│              ╰─────────╯              │
│                                       │
│         Tap to start briefing         │
│                                       │
│         "Today, 7 stories • 5 min"    │
│                                       │
│                                       │
│         ───────  transcript  ───────  │   ← live captions while agent speaks
│                                       │
│         ◐  Mute     ✕  End            │
└──────────────────────────────────────┘
```

Behavior:
- **Idle**: orb breathes slowly, subtle gradient (deep ink → muted accent).
- **Listening (user speaking)**: orb expands & cool-shifts; ring pulses with input mic amplitude.
- **Speaking (agent)**: orb deforms with audio-reactive blobs driven by `getOutputByteFrequencyData()`; warm accent glow.
- **Thinking**: smooth shimmer ring around the orb.
- **Interruptible**: tap the orb or just talk — barge-in is native to the ElevenLabs agent.
- Live transcript fades in line-by-line beneath the orb (user lines dim, agent lines bright).
- Minimal chrome: top-right gear + history; bottom mute/end. No nav, no cards, no clutter on the home surface.

Build details:
- Orb = `<canvas>` with WebGL/2D shader-style metaballs OR a layered SVG/CSS implementation using `radial-gradient` + Motion for React for the breathing/scale, with frequency data mapped to blob radii. Start with the CSS+canvas approach (no Three.js) — keeps it light and matches the design-direction envelope.
- Hue/scale curves driven from `useConversation()` (`isSpeaking`, `getInputVolume`, `getOutputByteFrequencyData`).
- Typography: distinctive serif display ("NewsPilot", topic titles) + clean grotesk for transcript. Color: deep ink background, off-white text, single warm accent.

## Rest of the app (unchanged from prior plan)

- **Auth** (`/auth`): email + Google sign-in via Lovable Cloud.
- **Onboarding**: pick interest categories (World, Tech, Markets, Science, Sports, Culture). Optional — skippable.
- **/_authenticated/history**: list past briefings; tap to open transcript + replay key points.
- **/_authenticated/settings**: interests, voice picker, sign-out.

## Architecture

```text
Browser (TanStack Start + React)
  │  WebRTC audio  ─────────────►  ElevenLabs Conversational Agent
  │                                   │  (STT + LLM + TTS + barge-in)
  │  client tools (function calls) ◄──┘
  │
  └─► TanStack server fns
        ├─ getElevenLabsToken()      → mints WebRTC token (ELEVENLABS_API_KEY server-side)
        ├─ fetchBriefing()           → RSS pull + cluster + summarize, returns Briefing
        ├─ deepDive(topic, question) → targeted re-search, called as agent client tool
        └─ Supabase (briefings, messages, preferences, profiles)
```

### News pipeline
- **Sources**: Google News RSS (top + per-topic), Reuters, AP, BBC, Hacker News. Agent can request more via `deep_dive`.
- **`fetchBriefing`** server fn:
  1. Parallel RSS fetch (last ~12h).
  2. Dedupe by title similarity, cluster into 5-7 topics.
  3. Single batched call to Lovable AI (`google/gemini-3-flash-preview`) → for each cluster: hook, 60-90 word plain-English explanation, "why it matters", sources, suggested follow-ups.
  4. Persist as `Briefing` row.

### Voice layer
- One ElevenLabs Conversational Agent configured with:
  - **System prompt**: intellectual-but-amusing news anchor; plain English; cite sources by name; never invent; ask clarifying questions when ambiguous; offer to resume the brief after a deep dive.
  - **First message** overridden per session with today's briefing JSON injected as context.
  - **Client tools**: `deep_dive(topic, question)`, `skip_to_topic(index)`, `end_briefing()`.
  - VAD + interruption enabled.
- WebRTC token minted server-side; client uses `@elevenlabs/react` `useConversation`.
- Transcript streamed into Supabase `messages` per briefing.

### Data model (Lovable Cloud)
- `profiles` (id → auth.users, display_name)
- `preferences` (user_id, categories text[], voice_id)
- `briefings` (id, user_id, generated_at, topics jsonb, sources jsonb)
- `messages` (id, briefing_id, user_id, role, content, created_at)
- RLS per-user on all four.

### Latency targets
- Briefing generation: < 6s (parallel RSS + one batched LLM call).
- Voice round-trip: < 800ms (WebRTC + ElevenLabs Turbo).
- Mid-conversation `deep_dive`: < 3s.

## Stack
TanStack Start • Lovable Cloud (Supabase auth + Postgres) • Lovable AI Gateway (Gemini 3 Flash) • ElevenLabs Conversational Agent + `@elevenlabs/react` • Motion for React.

## Build order
1. Enable Lovable Cloud; schema + RLS; auth (email + Google).
2. Connect ElevenLabs; I'll provide the exact agent config (system prompt + client-tool JSON) for you to paste into the ElevenLabs dashboard, then save the agent ID as a secret.
3. Server fns: news pipeline + briefing storage + token minting.
4. Home screen: audio-reactive orb + transcript + `useConversation` wiring.
5. History + settings + onboarding.
6. Polish pass.

## What I'll need from you mid-build
- A moment to create the agent in your ElevenLabs account (config provided, ~2 min).
- Pick a default voice — suggested **Brian** (`nPczCjzI2devNBz1zQrb`), warm and anchor-like.
