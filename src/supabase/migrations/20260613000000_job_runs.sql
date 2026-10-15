-- Phase 4: ops alerting + job_runs audit table.
--
-- Nightly jobs (compile-wiki, speaker-review, daily-brief, reprocess-pending) and
-- the local index_rebuild.mjs used to fail silently — errors lived only in Edge
-- Function logs that nobody reads. job_runs gives every job a start/finish row so
-- /today can show liveness and sendOpsAlert (see _shared/alert.ts) can ping on error.
--
-- Idempotent: IF NOT EXISTS everywhere. RLS on, no policies (service_role bypasses).

create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  status text not null,                       -- success | partial | error
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  details jsonb
);

alter table job_runs enable row level security;

-- /today reads "last run per job in the last 24h" — index the access pattern.
create index if not exists idx_job_runs_job_started
  on job_runs (job, started_at desc);
