-- Phase 10: batch-rewrite thoughts.metadata.linked_people in a single statement
-- instead of the per-thought UPDATE loop in handleMergePerson (open-brain-mcp).
--
-- Replaces every occurrence of p_source with p_target inside the linked_people
-- array (de-duplicating, so if p_target was already present the merged row keeps
-- a single entry), across all thoughts that reference p_source. Returns the
-- number of rows updated — the handler surfaces it as `thoughts_updated`.
--
-- security definer: callable by the service-role MCP function; search_path pinned.

create or replace function merge_linked_people(p_source uuid, p_target uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with updated as (
    update thoughts t
    set metadata = jsonb_set(
      t.metadata,
      '{linked_people}',
      (
        select coalesce(jsonb_agg(distinct e), '[]'::jsonb)
        from (
          select case
                   when elem = to_jsonb(p_source::text) then to_jsonb(p_target::text)
                   else elem
                 end as e
          from jsonb_array_elements(t.metadata->'linked_people') as elem
        ) s
      )
    )
    where t.metadata->'linked_people' @> to_jsonb(array[p_source::text])
    returning 1
  )
  select count(*) from updated into v_count;
  return v_count;
end;
$$;
