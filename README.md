# Khabar AI

A daily AI-powered news briefing app that delivers spoken news in a warm, conversational voice — like a smart friend catching you up on what happened today. Built as a personal tool for iPhone use.

Pulls from Google News RSS feeds across 10 topic sections, merges related stories using Gemini, writes scripts in up to 4 Indian languages, and converts them to speech using Edge TTS (free) or Google Gemini TTS.

---

## What It Does

Khabar AI generates a daily briefing on demand (or via cron):

1. Fetches headlines from Google News RSS across 10 sections (headlines, India, world, business, technology, entertainment, sports, science, health, local)
2. Deduplicates stories across feeds, then groups related ones using Gemini Flash — so 5 articles on the same event become one richer story
3. Writes conversational 70–100 word scripts per story in up to 4 languages: English, Hindi, Tamil, Marathi
4. Validates each non-English script for correct unicode script (Devanagari / Tamil) and runs a fix-up pass for any that came back in the wrong language
5. Converts scripts to speech — per-story per-language audio files stored in Supabase Storage
6. Fetches OG images from source articles (in parallel with scripting) for visual cards

Open the app, tap a section, and listen. Language is switchable on the fly from Settings. Tap any story card to see all the source articles it was assembled from.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start v1 (SSR, file-based routing) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Supabase (Google OAuth) |
| LLM | Google Gemini 2.5 Flash (scripting) |
| TTS (default) | Microsoft Edge TTS via `msedge-tts` (free, 4 Indian language voices) |
| TTS (quality) | Google Gemini 2.5 Flash TTS (paid, EN+HI only) |
| TTS (legacy) | ElevenLabs Flash v2.5 (paid, EN+HI only) |
| TTS (local) | Kokoro 82M ONNX (offline, EN only, delegates HI to Edge) |
| Storage | Supabase Storage |
| Deployment | Render |
| Cron | cron-job.org (external trigger) |

---

## Languages & Voices

Four languages supported, all using Edge TTS by default:

| Language | Voice A | Voice B |
|---|---|---|
| English | `en-IN-PrabhatNeural` | `en-IN-NeerjaExpressiveNeural` |
| Hindi | `hi-IN-MadhurNeural` | `hi-IN-SwaraNeural` |
| Tamil | `ta-IN-ValluvarNeural` | `ta-IN-PallaviNeural` |
| Marathi | `mr-IN-ManoharNeural` | `mr-IN-AarohiNeural` |

Voice A/B is split 50/50 per story, deterministically by story ID (first hex digit 0–7 → A, 8–f → B). This enables A/B quality comparison across a single briefing.

---

## Project Structure

```
src/
├── routes/
│   ├── __root.tsx              # Root layout + PWA manifest
│   ├── index.tsx               # Home screen (briefing player + section nav)
│   ├── auth.tsx                # Google OAuth login
│   └── _authenticated/
│       ├── browse.tsx          # Browse by section
│       ├── history.tsx         # Saved stories
│       └── settings.tsx        # Language + city + account
├── lib/
│   ├── news/
│   │   ├── generator.ts        # Main pipeline: fetch → dedup → OG images → script → TTS → save
│   │   ├── sources.ts          # RSS feed configs + fallback search URLs
│   │   ├── rss.ts              # RSS fetcher/parser (no external deps)
│   │   └── briefing.functions.ts  # Server fn: serve latest briefing to client
│   ├── tts/
│   │   ├── edge.ts             # Edge TTS: 4 languages, A/B voice split
│   │   ├── google.ts           # Gemini TTS: EN+HI, model rotation
│   │   ├── elevenlabs.ts       # ElevenLabs TTS: EN+HI
│   │   └── kokoro.ts           # Kokoro local TTS: EN only
│   ├── abort.ts                # Shared abort flag for in-progress generation
│   └── supabase-storage.ts     # Server-side Supabase Storage client
├── hooks/
│   └── useMonologue.ts         # Audio playback state machine (4 languages)
└── integrations/
    └── supabase/               # Supabase client, auth middleware, types
```

---

## Generation Pipeline

```
POST /api/admin/generate  (x-admin-key: <ADMIN_KEY>)
    │
    ├── fetchAllFeeds()         -- all 10 Google News RSS sections in parallel
    │                              (falls back to search URL if topic ID expired)
    ├── buildStories()          -- dedup by URL hash + title prefix
    │
    ├── [parallel]
    │   ├── fetchAllOgImages()  -- iPhone Safari UA, 8s timeout, 40KB read cap
    │   └── scriptAllStories()  -- one Gemini call per section
    │       └── per section:
    │           ├── Gemini: group related stories + write EN/HI/TA/MR scripts
    │           ├── validate unicode scripts (Devanagari / Tamil block check)
    │           ├── fix-up pass (re-translate wrong-script fields)
    │           └── partial save after each section
    │
    ├── applyTimeGuard()        -- trim secondary sections if > 30 min estimated
    ├── saveBriefing()          -- scripts checkpoint before TTS
    │
    └── generateAllTTS()        -- per story × per language
        └── edgeTTS() / googleTTS() / elevenLabsTTS() / kokoroTTS()
            └── saveBriefing()  -- checkpoint after every story
```

Gemini scripting has exponential backoff retry: up to 4 retries, 5→10→20→40s delays for 429/500/502/503/504.

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
- A Gemini API key — free at [aistudio.google.com](https://aistudio.google.com)
- Edge TTS requires no API key (uses `msedge-tts` npm package)

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
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."

# Gemini (scripting + optional TTS)
GEMINI_API_KEY="AIza..."

# ElevenLabs (optional TTS provider)
ELEVENLABS_API_KEY="sk_..."
ELEVENLABS_VOICE_ID="nwj0s2LU9bDWRKND5yzA"       # English voice
ELEVENLABS_VOICE_ID_HI="WuePGPKIAIKI8COZpzce"    # Hindi voice

# App
ADMIN_KEY="your-secret-key"
LOCAL_MODE=true        # skips Supabase auth; saves audio + briefing to local files
VITE_LOCAL_MODE=true
BRIEFING_HOME=in       # "in" for India-focused feeds
```

```bash
npm run dev
```

### Generate a briefing locally

```bash
# Default: Edge TTS, English + Hindi, Mumbai local news
curl -X POST http://localhost:5173/api/admin/generate \
  -H "x-admin-key: your-secret-key"

# With options
curl -X POST http://localhost:5173/api/admin/generate \
  -H "x-admin-key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"provider":"edge","languages":["en","hi","ta","mr"],"city":"Chennai"}'
```

Takes 5–15 minutes. Generated audio goes to `public/audio/` and briefing JSON to `.local-data/briefings.json`.

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
| `VITE_SUPABASE_PROJECT_ID` | Your project ref ID |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
| `GEMINI_API_KEY` | Your Gemini API key |
| `ADMIN_KEY` | A secret string protecting the generate endpoint |
| `LOCAL_MODE` | `false` |
| `VITE_LOCAL_MODE` | `false` |
| `BRIEFING_HOME` | `in` |

ElevenLabs keys are optional — Edge TTS works without any API key.

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
- Body: `{"provider":"edge","languages":["en","hi"]}`
- Schedule: `30 1 * * *` (1:30 AM UTC = 7 AM IST)

---

## Known Issues

**TanStack Start + Vite build bug:** `@tanstack/start-plugin-core@1.171` uses plugin lifecycle hooks that `@tanstack/router-plugin@1.168` doesn't implement, leaving `globalThis.TSS_ROUTES_MANIFEST` as null and crashing the SSR build.

Fix: `patches/@tanstack+start-plugin-core+1.171.18.patch` makes `buildRouteManifestRoutes` handle null gracefully. Applied automatically via `postinstall: patch-package`.

---

## License

Personal project. Not open for contributions.
