-- Per-account "listened" marks: which stories a user has heard to the end,
-- scoped to a briefing date so a new day starts fresh. Synced across devices.
create table if not exists public.listened_stories (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  briefing_date text        not null,
  story_id      text        not null,
  completed_at  timestamptz not null default now(),
  primary key (user_id, briefing_date, story_id)
);

alter table public.listened_stories enable row level security;

-- Users can only see and modify their own rows.
drop policy if exists "listened_stories own rows" on public.listened_stories;
create policy "listened_stories own rows" on public.listened_stories
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists listened_stories_user_date_idx
  on public.listened_stories (user_id, briefing_date);
