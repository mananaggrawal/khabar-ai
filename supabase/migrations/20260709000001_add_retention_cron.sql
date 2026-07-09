-- Retention for the two tables confirmed to grow unbounded with zero prior
-- cleanup mechanism (2026-07-09 audit): analytics_events and
-- listened_stories. Mirrors the same problem we just found and fixed in
-- Supabase Storage (312MB+ of never-pruned audio/briefing files) — these are
-- rows in Postgres instead of Storage objects, but the same "nothing ever
-- deletes old data" gap applies.
--
-- Uses pg_cron (bundled with every Supabase project) to run daily at 03:00
-- UTC. Deliberately NOT touching saved_stories (user-curated bookmarks —
-- pruning that would delete data the user explicitly chose to keep, not
-- just cache) or push_subscriptions (self-limiting, one row per device).
--
-- Retention windows are generous defaults (90 days) since these are small
-- rows, not the large audio blobs Storage cleanup handles — adjust the
-- interval below if you want them shorter.
--
-- If pg_cron isn't available on your plan/region, this migration will fail
-- at the `create extension` line — in that case, prune manually via the SQL
-- below on whatever schedule you like, or trigger it from the
-- cleanup-storage Edge Function alongside the Storage pruning.

create extension if not exists pg_cron;

-- Unschedule first (idempotent — safe to rerun this migration).
select cron.unschedule('prune-analytics-events') where exists (
  select 1 from cron.job where jobname = 'prune-analytics-events'
);
select cron.unschedule('prune-listened-stories') where exists (
  select 1 from cron.job where jobname = 'prune-listened-stories'
);

select cron.schedule(
  'prune-analytics-events',
  '0 3 * * *',
  $$ delete from public.analytics_events where occurred_at < now() - interval '90 days' $$
);

select cron.schedule(
  'prune-listened-stories',
  '0 3 * * *',
  $$ delete from public.listened_stories where briefing_date < to_char(now() - interval '90 days', 'YYYY-MM-DD') $$
);
