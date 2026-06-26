/**
 * Analytics event taxonomy — shared across the PWA and (later) the Flutter app.
 * Keep names and property shapes stable; both clients and the admin dashboards
 * depend on them. Add new events here rather than inline strings.
 */

export const EVENTS = {
  APP_OPEN:        "app_open",
  AUTH_LOGIN:      "auth_login",
  AUTH_LOGOUT:     "auth_logout",
  BRIEFING_LOADED: "briefing_loaded",
  SECTION_VIEW:    "section_view",
  PLAY:            "play",
  PAUSE:           "pause",
  STORY_START:     "story_start",
  STORY_COMPLETE:  "story_complete",
  NEXT:            "next",
  PREV:            "prev",
  SEEK:            "seek",
  DETAIL_OPEN:     "detail_open",
  SOURCE_CLICK:    "source_click",
  EXPLORE_CLICK:   "explore_click",
  LANGUAGE_CHANGE: "language_change",
  SAVE_STORY:      "save_story",
  UNSAVE_STORY:    "unsave_story",
  PLAYER_OPEN:     "player_open",
  PLAYER_CLOSE:    "player_close",
  GENERATION_RUN:  "generation_run", // server-side
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export type EventProps = Record<string, string | number | boolean | null | undefined>;
