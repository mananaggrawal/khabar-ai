/**
 * Analytics event taxonomy — shared across the PWA and (later) the Flutter app.
 * Keep names and property shapes stable; both clients and the admin dashboards
 * depend on them. Add new events here rather than inline strings.
 */

// Deliberately small. We only measure: who uses the app (app_open), what they
// play (story_start), and how long they actually listen (heartbeat). Everything
// else (minutes, time-per-story, completion) is derived from these.
export const EVENTS = {
  APP_OPEN:       "app_open",       // a visit → daily/active users
  STORY_START:    "story_start",    // a story began → stories played
  HEARTBEAT:      "heartbeat",      // fires every HEARTBEAT_SEC while playing → minutes listened
  GENERATION_RUN: "generation_run", // server-side, for generation health
  REFERRAL_VISIT: "referral_visit", // someone opened a /?ref= link → word-of-mouth reach
  REFERRAL_SIGNUP:"referral_signup",// a (new) user logged in carrying a referral code
  INVITE_SHARED:  "invite_shared",  // user tapped the share/invite action
} as const;

// Seconds of listening each heartbeat represents.
export const HEARTBEAT_SEC = 20;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export type EventProps = Record<string, string | number | boolean | null | undefined>;
