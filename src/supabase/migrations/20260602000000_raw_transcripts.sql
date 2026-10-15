-- raw_transcripts: full diarized transcripts kept OUT of the embedded `thoughts`
-- table so they don't pollute semantic search, lists, or wiki compilation.
-- Open Brain thought keeps only title + summary; the verbatim transcript lives
-- here, retrievable by plaud_id and full-text searchable (RU + EN).

create table if not exists raw_transcripts (
  id            uuid primary key default gen_random_uuid(),
  plaud_id      text unique,
  thought_id    uuid references thoughts(id) on delete set null,
  title         text,
  transcript    text not null,
  language      text,
  duration_ms   bigint,
  source        text default 'plaud',
  created_at    timestamptz default now(),
  search_vector tsvector
);

create index if not exists idx_raw_transcripts_plaud_id on raw_transcripts(plaud_id);
create index if not exists idx_raw_transcripts_thought_id on raw_transcripts(thought_id);
create index if not exists idx_raw_transcripts_search on raw_transcripts using gin(search_vector);

-- Maintain the search vector on write: title (RU) weighted high, body in RU + EN.
create or replace function raw_transcripts_search_trigger() returns trigger as $$
begin
  new.search_vector :=
    setweight(to_tsvector('russian', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(new.transcript, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.transcript, '')), 'C');
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_raw_transcripts_search on raw_transcripts;
create trigger trg_raw_transcripts_search
  before insert or update on raw_transcripts
  for each row execute function raw_transcripts_search_trigger();

-- Full-text search across raw transcripts (RU + EN), returns ranked snippets.
create or replace function search_transcripts(q text, match_count int default 5)
returns table (
  id uuid, plaud_id text, thought_id uuid, title text,
  snippet text, created_at timestamptz, rank real
)
language sql stable as $$
  select
    t.id, t.plaud_id, t.thought_id, t.title,
    ts_headline('russian', t.transcript,
      websearch_to_tsquery('russian', q) || websearch_to_tsquery('english', q),
      'MaxFragments=3, MinWords=5, MaxWords=25, StartSel=<<, StopSel=>>') as snippet,
    t.created_at,
    ts_rank(t.search_vector,
      websearch_to_tsquery('russian', q) || websearch_to_tsquery('english', q)) as rank
  from raw_transcripts t
  where t.search_vector @@
    (websearch_to_tsquery('russian', q) || websearch_to_tsquery('english', q))
  order by rank desc
  limit match_count;
$$;
