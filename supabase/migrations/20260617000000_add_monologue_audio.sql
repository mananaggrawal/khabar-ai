ALTER TABLE public.briefings
  ADD COLUMN IF NOT EXISTS monologue_script TEXT,
  ADD COLUMN IF NOT EXISTS audio_url TEXT;
