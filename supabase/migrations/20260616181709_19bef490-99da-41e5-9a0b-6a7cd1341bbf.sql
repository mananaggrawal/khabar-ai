ALTER TABLE public.preferences ADD COLUMN IF NOT EXISTS home_country text NOT NULL DEFAULT 'in';
ALTER TABLE public.briefings ADD COLUMN IF NOT EXISTS topics_tiered jsonb;