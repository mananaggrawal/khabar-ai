-- Saved stories: persists bookmarked stories per user account.
-- story_data stores the full Story JSON so stories remain playable
-- even after the daily briefing is refreshed.

CREATE TABLE public.saved_stories (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id   TEXT        NOT NULL,
  story_data JSONB       NOT NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, story_id)
);

ALTER TABLE public.saved_stories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own saved_stories"
  ON public.saved_stories
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, DELETE ON public.saved_stories TO authenticated;
GRANT ALL                     ON public.saved_stories TO service_role;
