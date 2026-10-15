-- Normalised person name + improved find_similar_person.
-- Layered on top of v1.2.2 (person_aliases): when the explicit alias map misses,
-- the fuzzy fallback now matches on lowercase + ё→е + collapsed-vowel form.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION normalize_person_name(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result text;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  result := lower(btrim(input));
  result := translate(result, 'ёЁ', 'ее');
  -- Collapse runs of the same vowel: aaron→aron, оо→о
  result := regexp_replace(result, '([aeiouаеиоуыэюяй])\1+', '\1', 'g');
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION normalize_person_name(text) TO service_role, anon, authenticated;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS normalized_name text
  GENERATED ALWAYS AS (normalize_person_name(name)) STORED;

CREATE INDEX IF NOT EXISTS idx_people_normalized_name_eq
  ON people (normalized_name);

CREATE INDEX IF NOT EXISTS idx_people_normalized_name_trgm
  ON people USING GIN (normalized_name gin_trgm_ops);

-- Replace find_similar_person to operate on normalized_name with an exact-match
-- short-circuit. Signature unchanged — callers in findOrCreatePerson keep working.
CREATE OR REPLACE FUNCTION find_similar_person(
  search_name text,
  min_similarity float DEFAULT 0.4
)
RETURNS TABLE(id uuid, name text, sim float)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ns AS (SELECT normalize_person_name(search_name) AS norm)
  SELECT p.id, p.name,
         CASE WHEN p.normalized_name = ns.norm THEN 1.0
              ELSE similarity(p.normalized_name, ns.norm)
         END AS sim
  FROM people p, ns
  WHERE
    p.normalized_name = ns.norm
    OR similarity(p.normalized_name, ns.norm) > min_similarity
    OR p.normalized_name ILIKE '%' || ns.norm || '%'
    OR ns.norm ILIKE '%' || p.normalized_name || '%'
  ORDER BY sim DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION find_similar_person(text, float) TO service_role;
