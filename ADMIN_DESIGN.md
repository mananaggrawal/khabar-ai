# Khabar AI — Admin Console Design Spec

## Goal
The admin console at `/admin` must feel like a natural extension of the main app —
same visual language, same fonts, same dark violet canvas. It should not look like
a separate internal tool.

---

## Visual Foundation (mirrors main app exactly)

| Token | Value |
|---|---|
| Background | `oklch(0.13 0.035 295)` — deep violet |
| Surface (card bg) | `oklch(0.17 0.04 295)` |
| Foreground | `oklch(0.98 0.005 300)` — near white |
| Primary (accent) | `oklch(0.72 0.19 300)` — vivid violet |
| Muted text | `oklch(0.7 0.03 295)` |
| Border | `oklch(1 0 0 / 8%)` — white 8% |
| Border radius | `0.875rem` (14px) |
| Font headings | Instrument Serif |
| Font body | Geist |
| Background gradient | `radial-gradient(ellipse at 50% 30%, oklch(0.22 0.04 290 / 0.7), transparent 60%), radial-gradient(ellipse at 80% 80%, oklch(0.25 0.08 30 / 0.35), transparent 65%)` |

---

## Layout

```
┌─────────────────────────────────────┐
│  top bar: "Khabar AI" (serif)       │  ← mirrors main app top bar exactly
│                       [user] [sign out]
├─────────────────────────────────────┤
│                                     │
│   [Login screen — Google button]    │  ← centered, same card style
│   OR                                │
│   Admin dashboard (authed)          │
└─────────────────────────────────────┘
```

---

## Screens

### 1. Login screen
- Centred vertically and horizontally on the full canvas
- Title: "Khabar AI" in Instrument Serif, same size/weight as main app
- Subtitle: "Admin" in muted text below
- Single "Sign in with Google" button
  - Style: white background, `#111` text — the Google brand button convention
  - Google logo SVG inline (no text emoji)
  - Rounded-full pill shape (matches main app pill buttons)

### 2. Access denied screen
- Same centred layout as login
- Short muted message, "Sign out" link in muted text

### 3. Admin dashboard (authenticated)
**Top bar** — identical to main app TopBar component:
- Left: "Khabar AI" in Instrument Serif + italic "AI" in primary colour
- Right: user avatar (circle, 28px) + "Sign out" as ghost text link

**Content** — max-width 640px, centred, same padding as main app:

#### Status section (last 7 days)
Each day is a row, NOT a card. Rows sit inside a single grouped card
(same style as SectionGroup in the main app: `bg-white/[0.02]` fill,
`border border-white/[0.08]`, `rounded-2xl`).

Each row shows:
- Date (left, muted)
- "Today" pill if today (matches existing `rounded-full border` pill from main app)
- Status indicator: a small dot + text
  - Generated: violet dot + "Generated" + section/topic counts in muted text
  - Missing: amber dot + "Not generated"
  - Error: red dot + "Error"
- Divider between rows (same `mx-4 h-px bg-white/[0.05]` as SectionRow)

#### Generate section
A second grouped card below status:
- Label: "Generate today's briefing" in regular weight
- Sub-label: muted, "Takes 3–5 minutes"
- Button: full-width, primary violet background, rounded-full — same style as
  primary CTA buttons in app
- While running: spinner + "Generating…" text (same Loader2 style)
- Result: muted success/error text below button

---

## What NOT to include
- No emojis anywhere
- No coloured badge backgrounds (keep status as dot + text only)
- No heavy card outlines or box shadows
- No sidebar or nav
- No tables or grids — rows only
- No admin key input field (auth is Google only now)

---

## Fonts to load (CDN)
```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
```
