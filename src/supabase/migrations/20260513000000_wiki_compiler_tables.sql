-- Wiki Compiler tables: entity_aliases (non-person), wiki_entities, wiki_compile_runs
-- Person aliases already handled by person_aliases table (FK → people.id)
-- This table covers countries, companies, topics — no FK since there are no dedicated tables for these

-- 1. entity_aliases — canonical name resolution for non-person entities
create table if not exists entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('country', 'company', 'topic')),
  canonical text not null,
  alias text not null,
  alias_normalized text not null,
  created_at timestamptz default now(),
  unique (entity_type, alias_normalized)
);

create index idx_entity_aliases_canonical on entity_aliases (entity_type, canonical);
create index idx_entity_aliases_lookup on entity_aliases (alias_normalized);

-- 2. wiki_entities — tracks each compiled wiki page
create table if not exists wiki_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('person', 'country', 'company', 'topic')),
  canonical text not null,
  slug text not null,
  file_path text not null,
  last_compiled_at timestamptz,
  last_thought_seen_at timestamptz,
  last_sha text,
  thoughts_count int default 0,
  status text default 'pending' check (status in ('pending', 'active', 'stale', 'error')),
  last_error text,
  created_at timestamptz default now(),
  unique (entity_type, canonical)
);

create unique index idx_wiki_entities_slug on wiki_entities (slug);

-- 3. wiki_compile_runs — audit log for each compilation
create table if not exists wiki_compile_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text check (status in ('running', 'success', 'partial', 'failed')),
  mode text default 'incremental' check (mode in ('incremental', 'full', 'single', 'dry-run')),
  entities_touched int default 0,
  thoughts_processed int default 0,
  tokens_in int default 0,
  tokens_out int default 0,
  cost_usd numeric(10,4) default 0,
  error_log jsonb default '[]'::jsonb,
  details jsonb default '{}'::jsonb
);

-- RLS: service-role only (Edge Function uses service key)
alter table entity_aliases enable row level security;
alter table wiki_entities enable row level security;
alter table wiki_compile_runs enable row level security;
