
ALTER TABLE public.preferences
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE public.briefings
  ADD COLUMN IF NOT EXISTS total_topics INTEGER,
  ADD COLUMN IF NOT EXISTS total_clusters_raw INTEGER,
  ADD COLUMN IF NOT EXISTS coverage_window_start TIMESTAMPTZ;
