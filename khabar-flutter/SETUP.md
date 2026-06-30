# Khabar Flutter — Setup & Run Guide

## 1. Install Flutter

```bash
# Install via Homebrew (easiest on Mac)
brew install --cask flutter

# Verify
flutter doctor
```

You'll need Xcode installed from the App Store. After installing Xcode, run:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

Accept the license:
```bash
sudo xcodebuild -license accept
```

Install CocoaPods (required for iOS):
```bash
sudo gem install cocoapods
```

Run `flutter doctor` again — everything under iOS should show ✓.

---

## 2. Fill in your config

Open `lib/config.dart` and fill in:

```dart
static const backendUrl = 'https://khabar-ai.onrender.com'; // your Render URL
static const supabaseUrl = 'YOUR_SUPABASE_URL';             // VITE_SUPABASE_URL from Render
static const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY';    // VITE_SUPABASE_PUBLISHABLE_KEY
```

---

## 3. Set up Google OAuth deep link in Supabase

In your Supabase dashboard → Authentication → URL Configuration, add:

```
io.khabar.app://login-callback
```

to the **Redirect URLs** list.

---

## 4. Install dependencies & run on iOS Simulator

```bash
cd khabar-flutter

# Get packages
flutter pub get

# Install iOS pods
cd ios && pod install && cd ..

# Open simulator
open -a Simulator

# Run
flutter run
```

To run on your **physical iPhone**:
1. Connect iPhone via USB
2. Trust the Mac on the device
3. In Xcode → Signing & Capabilities → set your Apple ID as the team
4. `flutter run --release` (release avoids provisioning issues in debug)

---

## 5. Deploy the backend change

The `/api/briefing` endpoint was added to the existing Node server. Deploy it:

```bash
cd khabar-ai
git add src/lib/api/handlers.ts src/start.ts
git commit -m "feat: add GET /api/briefing REST endpoint for Flutter app"
git push origin main
```

Render auto-deploys on push. The Flutter app won't work until this is live.

---

## 6. Project structure

```
khabar-flutter/
  lib/
    config.dart              ← backend URL + Supabase keys (fill these in)
    main.dart                ← app entry + provider setup
    models/briefing.dart     ← Story / DailyBriefing Dart models
    services/
      auth_service.dart      ← Supabase Google OAuth
      briefing_service.dart  ← GET /api/briefing
      audio_handler.dart     ← audio_service background audio handler
    providers/
      briefing_provider.dart ← fetch + section state
      player_provider.dart   ← play/pause/skip + current story
    screens/
      auth_screen.dart       ← Google sign-in
      home_screen.dart       ← section pills + story list
      player_screen.dart     ← full-screen player with progress
    widgets/
      story_card.dart        ← story row with image + play icon
      section_pills.dart     ← horizontal section tabs
      mini_player.dart       ← persistent mini player bar
    utils/
      section_meta.dart      ← section colors + icons (matches PWA)
  ios/Runner/Info.plist      ← background audio mode + URL scheme
  pubspec.yaml               ← dependencies
```

## Key packages

| Package | Purpose |
|---|---|
| `supabase_flutter` | Auth (Google OAuth) |
| `audio_service` | Background audio + lock screen controls |
| `just_audio` | Audio engine |
| `provider` | State management |
| `cached_network_image` | Story images |
| `http` | API calls to backend |
