# Khabar AI

A daily AI-powered news briefing app that delivers spoken news in a warm, conversational voice — like a smart friend catching you up on what happened today.

Built as a personal tool for iPhone use. Pulls from top RSS feeds, categorises stories using Gemini, writes a natural monologue script, and converts it to speech.

---

## What It Does

Every day at 7 AM IST, Khabar AI automatically:

1. Fetches headlines from ~20 curated RSS feeds (Indian and global)
2. Sends them to Gemini Flash to categorise into 10 sections (Politics, Business, Sports, Tech, etc.)
3. Writes a warm, conversational monologue script for each section
4. Converts each script to speech using Gemini TTS (voice: Algieba, Indian English)
5. Stores audio files and briefing JSON in Supabase Storage

You open the app, tap a section, and listen.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start v1 (SSR, file-based routing) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Supabase (Google OAuth) |
| LLM | Google Gemini 2.5 Flash |
| TTS | Gemini 3.1 Flash TTS |
| Storage | Supabase Storage (`khabar` bucket) |
| Deployment | Render (free tier) |
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
│       ├── history.tsx         # Past briefings
│       └── settings.tsx        # User settings
├── lib/
│   ├── news/
│   │   ├── generator.ts        # Main orchestrator: fetch → categorise → TTS → save
│   │   ├── sources.ts          # RSS feed list + section definitions
│   │   ├── rss.ts              # RSS fetcher/parser
│   │   └── briefing.functions.ts  # Server fn: serve today's briefing to client
│   ├── tts/
│   │   └── google.ts           # Gemini TTS: text → WAV → Supabase Storage
│   ├── supabase-storage.ts     # Server-side Supabase Storage client
│   └── api/
│       └── handlers.ts         # /api/admin/generate + /api/ask handlers
├── components/
│   ├── VoiceOrb.tsx            # Animated orb (idle/playing/loading states)
│   └── BriefingList.tsx        # News items list with source logos
├── hooks/
│   └── useMonologue.ts         # Audio playback state machine
├── start.ts                    # Server entry: middleware, API routes, auth
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
geminiCategorise()        -- one Gemini call: assigns each headline to a section
    │
    ▼
for each section:
    generateMonologue()   -- Gemini writes conversational script
    googleTTS()           -- Gemini TTS converts to WAV
    uploadAudio()         -- uploads WAV to Supabase Storage
    │
    ▼
saveBriefing()            -- saves briefing JSON to Supabase Storage
```

Single-pull architecture: one batch of RSS feeds → one categorisation call → parallel section generation. No repeated feed fetching.

---

## Voice Design

Voice: **Algieba** (Gemini TTS) — smooth Indian English.

The TTS prompt instructs the model to speak like a smart, well-informed friend sharing things they learned today. Not a broadcaster, not an AI assistant. Warm, curious, relaxed.

Style cues embedded in the prompt:
- Slow down for important developments
- Vary tone by content type (curious for surprises, thoughtful for politics, energetic for sports)
- Natural pauses between stories
- Never sound robotic or like a presenter

---

## Local Development

### Prerequisites

- Node.js 20+
- A Supabase project
- A Gemini API key (get one free at [aistudio.google.com](https://aistudio.google.com))

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
SUPABASE_SERVICE_ROLE_KEY="eyJ..."   # for server-side storage access
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."

# Gemini
GEMINI_API_KEY="AIza..."

# App
ADMIN_KEY="your-secret-key"          # protects /api/admin/generate
LOCAL_MODE=true                       # use local files instead of Supabase Storage
VITE_LOCAL_MODE=true
BRIEFING_HOME=in                      # "in" for India focus
```

```bash
npm run dev
```

### Generate a briefing locally

```bash
curl -X POST http://localhost:5173/api/admin/generate \
  -H "x-admin-key: your-secret-key"
```

This takes 3–5 minutes (TTS for each section). Generated audio goes to `public/audio/` and briefing JSON to `.local-data/briefings.json`.

---

## Production Deployment (Render)

### 1. Supabase setup

- Create a new project at [supabase.com](https://supabase.com)
- Enable Google OAuth: Authentication → Providers → Google
- Create a storage bucket named `khabar` (set to Public)
- Run the DB migrations (profiles table + RLS policies)

### 2. Deploy to Render

Connect your GitHub repo at [render.com](https://render.com). The `render.yaml` configures the service automatically.

Add these environment variables in the Render dashboard:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role JWT (from Supabase settings) |
| `VITE_SUPABASE_URL` | Same as SUPABASE_URL |
| `VITE_SUPABASE_PROJECT_ID` | Your project ref ID |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key from Supabase |
| `GEMINI_API_KEY` | Your Gemini API key |
| `ADMIN_KEY` | A secret string to protect the generate endpoint |
| `LOCAL_MODE` | `false` |
| `VITE_LOCAL_MODE` | `false` |
| `NODE_ENV` | `production` |
| `BRIEFING_HOME` | `in` |

### 3. Configure Google OAuth

In Google Cloud Console:
- Add your Render URL to Authorized JavaScript Origins
- Add `https://your-project.supabase.co/auth/v1/callback` to Authorized Redirect URIs

In Supabase → Authentication → URL Configuration:
- Set Site URL to your Render URL
- Add your Render URL to Redirect URLs

### 4. Set up the daily cron

At [cron-job.org](https://cron-job.org), create a job:
- URL: `https://khabar-ai.onrender.com/api/admin/generate`
- Method: POST
- Header: `x-admin-key: your-admin-key`
- Schedule: `30 1 * * *` (1:30 AM UTC = 7 AM IST)

---

## Known Issues & Workarounds

**TanStack Start + Vite 8 build bug:** `@tanstack/start-plugin-core@1.171` uses `onRouteTreeChanged` and `init` plugin lifecycle hooks that `@tanstack/router-plugin@1.168` doesn't implement, leaving `globalThis.TSS_ROUTES_MANIFEST` as null and crashing the SSR build.

Fix: `patches/@tanstack+start-plugin-core+1.171.18.patch` makes `buildRouteManifestRoutes` handle null gracefully (`?? {}`). Applied automatically via `postinstall: patch-package`.

---

## License

Personal project. Not open for contributions.
