-- Enable RLS on the two remaining public tables that were left open.
-- Supabase security advisor (rls_disabled_in_public, alert 2026-06-08) flagged
-- `artifacts` and `raw_transcripts` as publicly readable/writable.
-- All access goes through Edge Functions using SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS, so locking these down (no policies, like every other table here)
-- breaks nothing and closes anon/PostgREST access.
alter table if exists public.artifacts       enable row level security;
alter table if exists public.raw_transcripts enable row level security;
