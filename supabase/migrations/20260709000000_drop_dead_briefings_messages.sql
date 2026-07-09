-- Drops the `briefings`/`messages` table pair from the original
-- 20260616164527 migration. Confirmed dead (2026-07-09 audit): the app's
-- ACTUAL daily-briefing storage has always been Supabase Storage JSON
-- (bucket "khabar", briefings/YYYY-MM-DD.json — see src/lib/supabase-storage.ts),
-- never this table pair. Grepped the whole src/ tree for any `.from("briefings")`
-- or `.from("messages")` call — zero references anywhere. Pure leftover
-- scaffold from an early chat-style app design that was never wired up.
--
-- Safe to run even if these tables were already removed by hand — IF EXISTS
-- guards make this idempotent.

drop table if exists public.messages cascade;
drop table if exists public.briefings cascade;
