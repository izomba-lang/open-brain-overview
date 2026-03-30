-- Skills table: registry of capabilities that can be routed to
create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null,
  trigger_patterns text[] not null default '{}',
  client text not null default 'any',  -- claude-code, cursor, claude-desktop, any
  skill_prompt text,                    -- system prompt for the skill
  tools_required text[] not null default '{}',
  category text not null default 'general',  -- management, development, communication, analysis
  embedding extensions.vector(1536),   -- for semantic matching
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- HNSW index for fast semantic search on skills
create index if not exists skills_embedding_idx on skills
  using hnsw (embedding extensions.vector_cosine_ops);

-- Index on category for filtering
create index if not exists skills_category_idx on skills (category);

-- RPC for semantic skill matching (set search_path to include extensions for vector ops)
create or replace function match_skills(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.5,
  match_count int default 5
)
returns table (
  id uuid,
  name text,
  description text,
  client text,
  skill_prompt text,
  tools_required text[],
  category text,
  trigger_patterns text[],
  similarity float
)
language plpgsql stable
set search_path = public, extensions
as $$
begin
  return query
  select
    s.id,
    s.name,
    s.description,
    s.client,
    s.skill_prompt,
    s.tools_required,
    s.category,
    s.trigger_patterns,
    (1 - (s.embedding <=> query_embedding))::float as similarity
  from skills s
  where s.is_active = true
    and 1 - (s.embedding <=> query_embedding) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;
