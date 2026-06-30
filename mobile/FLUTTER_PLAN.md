# Khabar AI — Flutter App Plan (iOS first, Android to follow)

_Status: plan / not yet built. Lives at `mobile/` in the existing repo (monorepo)._

## 1. Goal & principle

A native iOS + Android app for Khabar AI, sharing the **exact same backend** as the web PWA. The phone app is **only a new client** — no server rewrite. Same Supabase, same daily briefing JSON, same `/api/track` analytics, same event names — so the existing admin dashboard covers web *and* mobile with no extra work.

The single biggest reason to go native: **audio**. Flutter's `audio_service` gives a real OS-managed background playlist with lock-screen / Control-Centre controls. Every iOS background-autoplay workaround we fought in the PWA simply goes away — the OS owns playback.

## 2. What's reused vs rebuilt

| Reused as-is (no change) | Rebuilt in Dart |
|---|---|
| Generation pipeline (Render) | ~5 screens: home, player, detail sheet, settings, sign-in |
| Supabase auth + Storage | Playback (audio_service playlist) |
| Briefing JSON in Storage | Local state + data layer |
| `/api/track` + analytics taxonomy | Analytics client (same events) |
| PostHog | — |

## 3. Data access (decided: read Storage directly)

The `khabar` Supabase bucket is **public**, and each day's briefing is at:

```
{SUPABASE_URL}/storage/v1/object/public/khabar/briefings/YYYY-MM-DD.json
```

The app finds the latest briefing exactly like the web `getLatestBriefing()`: try today's date (IST), then walk back up to 7 days until one loads. No backend change, no auth needed just to read the briefing. (If we later want a cleaner contract we can add `/api/briefing`, but it's not needed to ship.)

Audio + image URLs inside each story are already absolute public URLs, so the player just plays them.

### Data model (mirror of the web types — `lib/models/`)

```dart
class Briefing { String date; DateTime generatedAt; List<Story> stories;
                 List<String> generatedLanguages; BriefingMeta? meta; }

class Story {
  String id, title, source, link, section;
  String? imageUrl, description;
  Map<String,String?> titleByLang;   // en/hi/ta/mr
  Map<String,String?> scriptByLang;
  Map<String,String?> audioByLang;   // audioUrlEn/Hi/Ta/Mr
  List<SourceRef> sources;           // {title, source, link}
  int? publisherCount; List<String>? publishers;
}
```

Sections (current taxonomy): `headlines` (Top Stories = homepage-unique), `india`, `world`, `business`, `technology`, `sports`, `science`, `health`, `local`. Display order, colors, and icons mirror the web app. Section ordering for playback is applied client-side (same as the PWA).

## 4. Tech stack (packages)

- **State:** `flutter_riverpod` — minimal boilerplate, testable.
- **Backend:** `supabase_flutter` — auth + (optionally) storage. Briefing fetched over plain `http`/`dio` from the public URL.
- **Audio:** `just_audio` + `audio_service` + `audio_session` — background playlist, lock-screen controls, gapless/auto-advance handled by the OS.
- **Auth:** `supabase_flutter` Google OAuth **+ `sign_in_with_apple`** (Apple mandates Sign in with Apple on iOS if Google is offered) → `supabase.auth.signInWithIdToken`.
- **Analytics:** thin `track()` posting to `/api/track` (same `app_open` / `story_start` / `heartbeat`), optionally `posthog_flutter`.
- **UI niceties:** `cached_network_image` (thumbnails), `google_fonts` (serif headers), `shared_preferences` (language/city).

## 5. Audio architecture (the important part)

- One `AudioHandler` (audio_service) holds a **`ConcatenatingAudioSource`** built from the section-ordered stories' audio URLs for the selected language.
- The OS provides background playback, lock-screen art/title (per story via `MediaItem`), and next/prev/seek — so auto-advance, background play, and the iOS quirks we hand-rolled in the PWA are free.
- Language switch rebuilds the queue from the chosen language's audio URLs.
- Heartbeat analytics ticks off the handler's playing state.

## 6. Screens (`lib/features/`)

1. **Sign-in** — Sign in with Apple + Google; Supabase session.
2. **Home** — section pills (one section at a time, like the PWA), story list with cards (section color/icon, thumbnail), tap card → detail sheet, tap play → start playlist from there.
3. **Player** — full-screen: artwork/orb, title, seek bar, prev/skip-back-10/play/skip-fwd-10/next, "Summary, sources & more" → detail sheet (follows the playing story).
4. **Detail sheet** — summary (script in current language), sources list, "Explore on Google/Perplexity/ChatGPT".
5. **Settings** — language (en/hi/ta/mr, gated by `generatedLanguages`), city (for Local), account / sign-out, analytics opt-out, privacy link.

## 7. Project structure

```
mobile/
  pubspec.yaml
  lib/
    main.dart                 // bootstrap: Supabase.init, audio_service, runApp
    app.dart                  // MaterialApp, theme, routing
    core/                     // env, theme, section config (colors/icons/order)
    models/                   // story.dart, briefing.dart
    data/
      briefing_repository.dart // fetch latest briefing from Storage
      auth_repository.dart     // Supabase + Apple/Google sign-in
    services/
      audio_handler.dart       // audio_service playlist handler
      analytics.dart           // track() + heartbeat
    state/                     // Riverpod providers
    features/auth|home|player|detail|settings/
  ios/  android/               // generated by `flutter create`
```

## 8. iOS specifics (no Apple account yet)

- **Now (free):** run on the iOS **Simulator** (no account) and on **your physical iPhone** via Xcode with a free personal team (7-day provisioning, re-sign weekly). Enough to build and test the whole app.
- **Before TestFlight / App Store:** enrol in the **Apple Developer Program** ($99/yr, ~1–2 days). Then TestFlight for real on-device testing, then submission.
- **Config:** `UIBackgroundModes: [audio]` in Info.plist; audio_session category `playback`; URL scheme for the Supabase OAuth deep link; Sign in with Apple capability.
- **Review prep:** Sign in with Apple present; privacy nutrition labels (we have `PRIVACY.md`); news-source attribution (the detail sheet already lists sources).

## 9. Build/run loop (important)

I write the Dart/Flutter code in `mobile/`. **iOS compilation/run happens on your Mac** (the Linux build sandbox can't build for iOS). The loop:

```bash
cd mobile
flutter pub get
flutter run            # pick the iOS simulator or your connected iPhone
```

Android later: `flutter run` on an emulator/device; `flutter build apk` works without a Mac.

## 10. Milestones

- **M0 — Scaffold:** `flutter create`, packages, env, theme, Supabase init, app icon/splash. Runnable empty shell.
- **M1 — Auth:** Sign in with Apple + Google → Supabase session; gate the app.
- **M2 — Data:** models + `briefing_repository` (latest briefing from Storage); home list renders real stories.
- **M3 — Player:** audio_service playlist, background + lock screen, mini-player, full player, detail sheet.
- **M4 — Settings + analytics:** language/city, opt-out; `app_open`/`story_start`/`heartbeat` → `/api/track`.
- **M5 — Ship:** enrol in Apple Developer, TestFlight, polish, App Store submit. Android pass after.

## 11. Open items / decisions for later

- Apple Developer enrolment (needed before TestFlight) — start when ready.
- Push notifications ("your briefing is ready") — nice-to-have, post-launch.
- Offline/download a briefing for the commute — post-launch.
- Whether to keep the PWA long-term (current plan: keep both; shared backend makes it cheap).

## 12. Honest risks

- iOS build/sign friction on the free tier (7-day re-sign) until the paid account is set up.
- Sign in with Apple + Supabase wiring is the fiddliest auth bit; budget time there.
- Audio URL playback over cellular — fine, but we should confirm Supabase Storage bandwidth/latency is acceptable for ~100 short clips.
