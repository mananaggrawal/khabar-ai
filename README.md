# Khabar AI

A daily AI-powered news briefing app that delivers spoken news in a warm, conversational voice — like a smart friend catching you up on what happened today. Built as a personal tool for iPhone use.

Pulls from Google News RSS across 5 focused feeds, merges articles about the same event with a single LLM call, writes very quick factual English scripts with GPT-4o, and converts them to speech with Edge TTS (free) by default.

---

## What It Does

Khabar AI generates a daily briefing on demand (or via cron):

1. Fetches Google News RSS feeds in parallel across 8 sections — Headlines, India, World, Business, Technology, Sports, Science, Health. (The former city-scoped "Local" section was removed 2026-07-09 — nothing in settings/onboarding/home references it anymore; legacy `local`/`politics`/`techlife`/`entertainment` story tags from older briefings are remapped to a current section via `resolveSection()` in `src/lib/news/sources.ts`, the single source of truth for that mapping.)
2. Deduplicates by URL hash + title prefix; articles on Google's homepage feed are flagged (★) as a stronger editorial signal
3. Clusters articles about the same event and selects as many distinct events as fit in one `gpt-4o-mini` call, ordered by importance and balanced across sections (count derives from `TARGET_MINUTES`, default 25 → ~63 stories)
4. Writes a very quick ~45–65 word factual English script per event with `gpt-4o` — headline + key facts, no interpretation — using the live-fetched body text of the top sources
5. Converts each script to speech and stores per-story audio (Supabase Storage, or local files in `LOCAL_MODE`); each story's narrating voice (A/B alternation) is decided once at this step and persisted as `Story.voiceIndex` — nothing downstream re-derives or guesses it
6. Fetches OG images from source articles (in parallel with clustering) for visual cards

Open the app, tap a section pill, and listen. Tap any story card to see its summary and source articles. **Quick 15** is a pinned pill alongside the real sections — a client-curated, cross-section, importance-and-voice-balanced 15-story batch (`src/lib/news/quickQueue.ts`) that refreshes in place (only already-heard slots get swapped) without disturbing whatever's currently playing.

Playback lives in a single app-wide `PlayerProvider` (`src/context/player.tsx`) so audio survives navigating between Home/Saved/Settings. There is no full-screen player screen (removed 2026-07-09) — the mini player itself carries a scrub bar and prev/-10s/play-pause/+10s/next, stays visible at all times, and tapping it opens a summary popup for whatever's currently playing (live-follows as playback advances).

> **Scope note (v5):** the pipeline generates **English only**. Hindi/Tamil/Marathi voices exist in the TTS layer and the data model reserves fields for them, but scripting and audio are English in this version. Requesting other languages is ignored (and logged).

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start v1 (SSR, file-based routing) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Supabase (Google OAuth) |
| Scripting LLM | OpenAI `gpt-4o` (scripts) + `gpt-4o-mini` (clustering) — default |
| Scripting fallback | Google Gemini 2.5 Flash (set `SCRIPT_PROVIDER=gemini`) |
| TTS (default) | Microsoft Edge TTS via `msedge-tts` (free, no API key) |
| TTS (options) | OpenAI TTS, Google Gemini TTS, ElevenLabs, Kokoro (local) |
| Storage | Supabase Storage (or local files in `LOCAL_MODE`) |
| Deployment | Render |
| Cron | cron-job.org (external trigger) |

---

## Provider Routing

- **Clustering + scripting** go through `aiJson`, which routes by `SCRIPT_PROVIDER` (`openai` default, or `gemini`). Both calls have a 90s timeout and exponential-backoff retry on 429/5xx.
- **TTS** is selected per request via the `provider` option: `edge` (default, free), `openai`, `google`, `elevenlabs`, `kokoro`.
- Edge TTS splits between two Indian-English voices (`en-IN-PrabhatNeural` / `en-IN-NeerjaExpressiveNeural`) deterministically by story ID, enabling A/B comparison within one briefing. It reads ~12% faster than default for a snappier pace — tune with `EDGE_TTS_RATE` (e.g. `+20%`).

---

## Project Structure

```
src/
├── routes/
│   ├── __root.tsx              # Root layout + PWA manifest
│   ├── index.tsx               # Home screen (section pills incl. Quick 15, story list)
│   ├── auth.tsx                # Google OAuth login
│   └── _authenticated/
│       ├── history.tsx         # Saved stories (own useMonologue instance/mini player)
│       ├── settings.tsx        # Language + notifications + account
│       └── browse.tsx          # Dead stub, unused — do not build on this
├── context/
│   └── player.tsx              # App-wide PlayerProvider: briefing fetch, Quick 15
│                                  batch build/refresh, global mini player + the
│                                  "now playing" summary popup that replaces the old
│                                  full-screen player
├── components/
│   ├── AppHeader.tsx            # Shared logo/tagline/share header — same on every page
│   ├── BottomNav.tsx
│   ├── StoryCard.tsx
│   ├── StoryDetailSheet.tsx     # Summary/sources popup — used both for card previews
│   │                               and (via player.tsx) as the "now playing" sheet
│   ├── InstallNudge.tsx         # PWA install nudge (Home banner + Settings row).
│   │                               Real "Install" button when `beforeinstallprompt`
│   │                               is available; otherwise generic manual steps
│   │                               (Android: browser menu → Add to Home screen; iOS:
│   │                               Share → Add to Home Screen). Renders nothing once
│   │                               already installed (standalone display mode).
│   └── NotificationNudge.tsx
├── lib/
│   ├── news/
│   │   ├── generator.ts        # Main pipeline: fetch → dedup → OG images → script → TTS → save
│   │   ├── quickQueue.ts       # Quick 15 batch build/refresh (client-side curation)
│   │   ├── sources.ts          # Section configs, resolveSection() legacy remap, fallback URLs
│   │   ├── rss.ts              # RSS fetcher/parser (no external deps)
│   │   └── briefing.functions.ts  # Server fn: serve latest briefing to client
│   ├── tts/
│   │   ├── edge.ts             # Edge TTS: 4 languages, A/B voice split
│   │   ├── google.ts           # Gemini TTS: EN+HI, model rotation
│   │   ├── elevenlabs.ts       # ElevenLabs TTS: EN+HI
│   │   └── kokoro.ts           # Kokoro local TTS: EN only
│   ├── abort.ts                # Shared abort flag for in-progress generation
│   ├── platform.ts             # Shared UA/display-mode checks: isIOS, isAndroid,
│   │                               isMobileDevice, isStandalone
│   └── supabase-storage.ts     # Server-side Supabase Storage client
├── hooks/
│   ├── useMonologue.ts         # Audio playback state machine — story-id-based resume,
│   │                              not raw index (see Known Issues history in git log)
│   └── useInstallPrompt.ts     # Captures beforeinstallprompt (Android/Chrome) +
│                                   tracks standalone/installed state for InstallNudge
└── integrations/
    └── supabase/               # Supabase client, auth middleware, types
```

---

## Generation Pipeline

```
POST /api/admin/generate?provider=edge&languages=en&city=Mumbai   (x-admin-key: <ADMIN_KEY>)
    │
    ├── fetchAllFeeds()         -- 5 Google News RSS feeds in parallel (incl. city-scoped Local)
    │                              (falls back to search URL if topic ID expired)
    ├── buildRawStories()       -- dedup by URL hash + title prefix; flag ★ homepage stories
    │
    ├── [parallel]
    │   ├── fetchAllOgImages()  -- iPhone Safari UA, 8s timeout, 40KB read cap, 10 concurrent
    │   └── clusterAndSelect()  -- one gpt-4o-mini call: group same-event articles,
    │                              cover as many distinct events as fit, balance sections
    │
    ├── saveBriefing()          -- early checkpoint (events, no scripts yet)
    │
    ├── scriptAllEvents()       -- up to 10 events end-to-end at once (gated by scriptLimit)
    │   └── per event:
    │       ├── fetch top-3 source article bodies (6s timeout each)
    │       ├── gpt-4o: write a very quick 45–65 word factual script (no interpretation)
    │       ├── validate (>=40 words, no Devanagari/Tamil) + 1 retry
    │       └── fallback to title+description if both attempts fail
    │
    ├── saveBriefing()          -- scripts checkpoint before TTS
    │
    └── generateAllTTS()        -- per story, English; 5 concurrent
        └── edgeTTS() / openaiTTS() / googleTTS() / elevenLabsTTS() / kokoroTTS()
            └── saveBriefing()  -- serialized checkpoint after every story
```

Both the cluster call and each script call have a 90s timeout and exponential-backoff retry (2→4→8s) on 429/500/502/503/504. A `Stop` (abort) is honored after fetch, after clustering, and at the start of each event's scripting.

---

## Admin Panel

Available at `/admin.html` (served by `server.mjs`):

- **Generate**: trigger a full briefing run with language + city + TTS provider selection
- **Patch TTS**: add audio for stories that are missing it (e.g. after a quota failure)
- **Add Sections**: fetch + script new stories not yet in today's briefing
- **Stop**: interrupt any in-progress run
- Live log stream via SSE

---

## Local Development

### Prerequisites

- Node.js 20+
- A Supabase project (or use `LOCAL_MODE=true` to skip auth)
- An OpenAI API key — required for scripting and clustering
- Edge TTS requires no API key (uses `msedge-tts` npm package)
- A Gemini key is optional — only needed for `SCRIPT_PROVIDER=gemini` or the `google` TTS provider

### Setup

```bash
git clone https://github.com/mananaggrawal/khabar-ai
cd khabar-ai
npm install
```

Create a `.env` file:

```env
# Supabase
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJ..."
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."

# OpenAI — REQUIRED (scripting + clustering, and the `openai` TTS provider)
OPENAI_API_KEY="sk-..."
# OPENAI_SCRIPT_MODEL="gpt-4o"   # optional override
# OPENAI_TTS_MODEL="tts-1"       # optional override (openai TTS)

# Optional: scripting provider + length
# SCRIPT_PROVIDER="openai"       # or "gemini"
# GEMINI_API_KEY="AIza..."       # required only if SCRIPT_PROVIDER=gemini or provider=google
# TARGET_MINUTES="25"            # controls how many events are selected (~33 at 25 min)

# ElevenLabs (optional TTS provider)
# ELEVENLABS_API_KEY="sk_..."
# ELEVENLABS_VOICE_ID="nwj0s2LU9bDWRKND5yzA"

# App
ADMIN_KEY="your-secret-key"
LOCAL_MODE=true        # skips Supabase auth; saves audio + briefing to local files
VITE_LOCAL_MODE=true

# Analytics (optional) — PostHog client key for product analytics.
# Without it, events still log to the Supabase `analytics_events` table via /api/track.
VITE_POSTHOG_KEY="phc_..."
VITE_POSTHOG_HOST="https://us.i.posthog.com"   # or your EU/self-host URL
# VITE_APP_VERSION="web"                        # optional build tag on events
```

> **Analytics setup:** apply `supabase/migrations/20260626000000_add_analytics_events.sql`
> (creates the `analytics_events` table, server-write only). Client events flow
> through `src/lib/analytics/track.ts` → `/api/track` → Supabase, and in parallel
> to PostHog when `VITE_POSTHOG_KEY` is set. Event names live in
> `src/lib/analytics/events.ts` and are shared with the future mobile app. See
> `PRIVACY.md` for the disclosure.

```bash
npm run dev
```

### Generate a briefing locally

Options are passed as **query parameters** (the endpoint does not read a JSON body). Defaults: `provider=edge`, `languages=en`.

```bash
# Default: Edge TTS, English
curl -X POST "http://localhost:5173/api/admin/generate" \
  -H "x-admin-key: your-secret-key"

# With options
curl -X POST "http://localhost:5173/api/admin/generate?provider=openai&scriptProvider=openai&scriptModel=gpt-4o" \
  -H "x-admin-key: your-secret-key"
```

Recognized query params: `provider`, `languages`, `scriptProvider`, `scriptModel`, `ttsModel`, `city` (scopes the Local feed; defaults to Mumbai). Takes ~5–15 minutes. In `LOCAL_MODE`, audio goes to `public/audio/` and the briefing JSON to `.local-data/briefings.json`.

---

## Production Deployment (Render)

### 1. Supabase setup

- Create a project at [supabase.com](https://supabase.com)
- Enable Google OAuth: Authentication → Providers → Google
- Create a storage bucket named `khabar` (set to Public)

### 2. Deploy to Render

Connect your GitHub repo at [render.com](https://render.com). Add these environment variables in the Render dashboard:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role JWT |
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
| `OPENAI_API_KEY` | **Required** — scripting + clustering |
| `ADMIN_KEY` | A secret string protecting the generate endpoint |
| `LOCAL_MODE` | `false` |
| `VITE_LOCAL_MODE` | `false` |

Optional: `GEMINI_API_KEY` (only for `SCRIPT_PROVIDER=gemini` or the `google` TTS provider), `ELEVENLABS_API_KEY`, `TARGET_MINUTES`. Edge TTS works without any API key.

### 3. Google OAuth

In Google Cloud Console:
- Add your Render URL to Authorized JavaScript Origins
- Add `https://your-project.supabase.co/auth/v1/callback` to Authorized Redirect URIs

In Supabase → Authentication → URL Configuration:
- Set Site URL to your Render URL
- Add your Render URL to Redirect URLs

### 4. Daily cron

At [cron-job.org](https://cron-job.org), create a job:
- URL: `https://your-app.onrender.com/api/admin/generate?provider=edge&languages=en`
- Method: POST
- Header: `x-admin-key: your-admin-key`
- Schedule: `30 1 * * *` (1:30 AM UTC = 7 AM IST)

---

## Known Issues

**TanStack Start + Vite build bug:** `@tanstack/start-plugin-core@1.171` uses plugin lifecycle hooks that `@tanstack/router-plugin@1.168` doesn't implement, leaving `globalThis.TSS_ROUTES_MANIFEST` as null and crashing the SSR build.

Fix: `patches/@tanstack+start-plugin-core+1.171.18.patch` makes `buildRouteManifestRoutes` handle null gracefully. Applied automatically via `postinstall: patch-package`.

---

## License

Personal project. Not open for contributions.
