# Khabar AI

A daily AI-powered news briefing app that delivers spoken news in a warm, conversational voice — like a smart friend catching you up on what happened today. Built as a personal tool for iPhone use.

Pulls from ~20 curated RSS feeds, clusters related stories using Gemini, writes bilingual (English + Hindi) monologue scripts, and converts them to natural-sounding speech via ElevenLabs.

---

## What It Does

Every day at 7 AM IST, Khabar AI automatically:

1. Fetches headlines from ~20 curated RSS feeds (Indian and global)
2. Groups related stories together using Gemini Flash — so 5 articles on the same event become one story
3. Writes a warm, conversational bilingual script for each story (English + Hindi)
4. Converts each script to speech using ElevenLabs Flash v2.5 with Indian English and Hindi voices
5. Stores audio and briefing JSON in Supabase Storage

Open the app, tap a section, and listen. Tap any story card to see all the source articles it was assembled from.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start v1 (SSR, file-based routing) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Supabase (Google OAuth) |
| LLM | Google Gemini 2.5 Flash |
| TTS | ElevenLabs Flash v2.5 (`eleven_flash_v2_5`) |
| Storage | Supabase Storage |
| Deployment | Render |
| Cron | cron-job.org (external trigger) |

---

## Project Structure

```
src/
├── routes/
│   ├── __root.tsx              # Root layout
│   ├── index.tsx               # Home screen (briefing player)
│   ├── auth.tsx                # Google OAuth login
│   └── _authenticated/
│       ├── browse.tsx          # Browse by section
│       ├── history.tsx         # Past briefings
│       └── settings.tsx        # User settings
├── lib/
│   ├── news/
│   │   ├── generator.ts        # Main orchestrator: fetch → club → script → TTS → save
│   │   ├── sources.ts          # RSS feed list + section definitions
│   │   ├── rss.ts              # RSS fetcher/parser
│   │   └── briefing.functions.ts  # Server fn: serve today's briefing to client
│   ├── tts/
│   │   └── elevenlabs.ts       # ElevenLabs TTS: text → MP3 → Supabase Storage
│   ├── supabase-storage.ts     # Server-side Supabase Storage client
│   └── api/
│       └── handlers.ts         # /api/admin/* endpoints
├── components/
│   ├── VoiceOrb.tsx            # Animated orb (idle/playing/loading states)
│   ├── StoryCard.tsx           # News item card with play button
│   └── StoryDetailSheet.tsx    # Story detail with all source articles
├── hooks/
│   └── useMonologue.ts         # Audio playback state machine
└── integrations/
    └── supabase/               # Supabase client, auth middleware, types
```

---

## How the Briefing is Generated

```
cron-job.org (1:30 AM UTC = 7 AM IST)
    │
    ▼
POST /api/admin/generate  (x-admin-key header)
    │
    ▼
fetchAllFeeds()           -- pulls all RSS feeds in parallel
    │
    ▼
for each section (Headlines, Business, Sports, …):
    clubAndScriptSection()
        ├── splits stories into chunks of 25
        ├── Gemini call per chunk: groups related stories + writes EN+HI scripts
        └── returns clubbed stories with scripts and source article lists
    │
    for each clubbed story:
        elevenLabsTTS(scriptEn)   -- EN MP3 → Supabase Storage
        elevenLabsTTS(scriptHi)   -- HI MP3 → Supabase Storage
        saveBriefing()            -- checkpoint: saves progress after each story
```

**Club-first architecture:** raw articles are grouped before any TTS is generated. 80 articles on a slow news day might become 25 clubbed stories. Each story card in the app links back to all the source articles it was assembled from.

---

## Voice Design

Two voices, both Indian accents via ElevenLabs:

- **English** — voice `nwj0s2LU9bDWRKND5yzA` (natural Indian English cadence)
- **Hindi** — voice `WuePGPKIAIKI8COZpzce` (native Hindi speaker)

Model: `eleven_flash_v2_5` — the cheapest ElevenLabs model at $0.05/1K chars, with full multilingual support. Language is steered via `language_code: "hi"` for Hindi; English omits the parameter (ElevenLabs does not support `en-IN` as a code).

Scripts are written to sound like a well-informed friend, not a news anchor — warm, curious, and conversational. Each script is 60–80 words, one story at a time.

---

## Local Development

### Prerequisites

- Node.js 20+
- A Supabase project (or use `LOCAL_MODE=true` to skip auth entirely)
- A Gemini API key — free at [aistudio.google.com](https://aistudio.google.com)
- An ElevenLabs API key — [elevenlabs.io](https://elevenlabs.io)

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
SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
SUPABASE_SERVICE_ROLE_KEY="eyJ..."
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."

# Gemini (LLM for categorisation + scripting)
GEMINI_API_KEY="AIza..."

# ElevenLabs (TTS)
ELEVENLABS_API_KEY="sk_..."
ELEVENLABS_VOICE_ID="nwj0s2LU9bDWRKND5yzA"       # English voice
ELEVENLABS_VOICE_ID_HI="WuePGPKIAIKI8COZpzce"    # Hindi voice

# App
ADMIN_KEY="your-secret-key"
LOCAL_MODE=true        # skips Supabase auth; uses local files
VITE_LOCAL_MODE=true
BRIEFING_HOME=in       # "in" for India-focused feeds
```

```bash
npm run dev
```

### Generate a briefing locally

```bash
curl -X POST http://localhost:5173/api/admin/generate \
  -H "x-admin-key: your-secret-key"
```

Takes 5–10 minutes to process all sections. Generated MP3s go to `public/audio/` and the briefing JSON to `.local-data/briefings.json`.

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
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role JWT |
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_PROJECT_ID` | Your project ref ID |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Same as `SUPABASE_PUBLISHABLE_KEY` |
| `GEMINI_API_KEY` | Your Gemini API key |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | English voice ID |
| `ELEVENLABS_VOICE_ID_HI` | Hindi voice ID |
| `ADMIN_KEY` | A secret string protecting the generate endpoint |
| `LOCAL_MODE` | `false` |
| `VITE_LOCAL_MODE` | `false` |
| `BRIEFING_HOME` | `in` |

### 3. Google OAuth

In Google Cloud Console:
- Add your Render URL to Authorized JavaScript Origins
- Add `https://your-project.supabase.co/auth/v1/callback` to Authorized Redirect URIs

In Supabase → Authentication → URL Configuration:
- Set Site URL to your Render URL
- Add your Render URL to Redirect URLs

### 4. Daily cron

At [cron-job.org](https://cron-job.org), create a job:
- URL: `https://your-app.onrender.com/api/admin/generate`
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
