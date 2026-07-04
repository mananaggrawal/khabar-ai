-- Web Push subscriptions — one row per device/browser a user has enabled
-- notifications on (a user can have several: phone + desktop, etc.). The
-- endpoint URL is unique per subscription and doubles as the natural key.
create table if not exists public.push_subscriptions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  endpoint     text        not null unique,
  p256dh       text        not null,
  auth_key     text        not null,
  user_agent   text,
  created_at   timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

-- Users can only see and modify their own subscriptions. Sending pushes is
-- done server-side with the service role key, which bypasses RLS.
drop policy if exists "push_subscriptions own rows" on public.push_subscriptions;
create policy "push_subscriptions own rows" on public.push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);
