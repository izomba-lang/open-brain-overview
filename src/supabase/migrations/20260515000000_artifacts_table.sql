-- Artifacts: links to important documents, spreadsheets, presentations, etc.
-- Attached to wiki entities and shown as a dedicated section on wiki pages.
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references wiki_entities(id) on delete cascade,
  title text not null,
  url text not null,
  artifact_type text not null default 'document'
    check (artifact_type in ('document', 'spreadsheet', 'presentation', 'pdf', 'email', 'link', 'other')),
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index artifacts_entity_idx on artifacts(entity_id);
