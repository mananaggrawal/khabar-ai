-- Analytics events: append-only product-analytics log.
-- Written ONLY by the server (service role) via /api/track, so clients can't
-- forge data. Powers the admin analytics dashboards. PostHog is the parallel
-- sink for funnels/retention; this table is the authoritative first-party copy.

CREATE TABLE public.analytics_events (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event       TEXT        NOT NULL,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  platform    TEXT,                      -- 'web' | 'ios' | 'android'
  language    TEXT,
  app_version TEXT,
  props       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common query patterns: by time, by event, by user.
CREATE INDEX analytics_events_occurred_at_idx ON public.analytics_events (occurred_at DESC);
CREATE INDEX analytics_events_event_idx       ON public.analytics_events (event, occurred_at DESC);
CREATE INDEX analytics_events_user_idx        ON public.analytics_events (user_id, occurred_at DESC);

-- RLS on, with NO client policies: only the service role (server) can read/write.
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.analytics_events TO service_role;
