-- Canonical name map: many-to-one alias → person mapping.
-- Solves recurring duplicates from short forms ("Иванов"), Russian morphology
-- ("Петром", "Петру", "Петра"), and transliteration variants ("Alexey" / "Aleksey")
-- that pg_trgm with min_similarity=0.4 cannot bridge.

CREATE TABLE IF NOT EXISTS person_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  alias_raw text NOT NULL,
  alias_normalized text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_normalized)
);

CREATE INDEX IF NOT EXISTS idx_person_aliases_normalized ON person_aliases(alias_normalized);
CREATE INDEX IF NOT EXISTS idx_person_aliases_person_id ON person_aliases(person_id);

ALTER TABLE person_aliases ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow service role all on person_aliases') THEN
    CREATE POLICY "Allow service role all on person_aliases" ON person_aliases FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
