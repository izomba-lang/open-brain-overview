-- Find people cards that have zero linked thoughts (orphans).
-- Used by nightly cleanup and MCP list_people(orphans_only=true).

-- people из SETUP-GUIDE не имеет created_at — функция ниже его читает.
alter table people add column if not exists created_at timestamptz default now();

create or replace function find_orphan_people()
returns table (
  id uuid,
  name text,
  area text,
  role text,
  organization text,
  created_at timestamptz
)
language sql stable
as $$
  select p.id, p.name, p.area, p.role, p.organization, p.created_at
  from people p
  where not exists (
    select 1 from thoughts t
    where t.metadata->'linked_people' ? p.id::text
  )
  order by p.created_at desc;
$$;
