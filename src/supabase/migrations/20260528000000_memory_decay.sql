-- Memory decay: track access patterns for Ebbinghaus-style relevance scoring.
-- last_accessed updates on search hit; access_count tracks total retrievals.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS last_accessed timestamptz DEFAULT now();
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0;

-- Backfill: set last_accessed = created_at for existing rows
UPDATE thoughts SET last_accessed = created_at WHERE last_accessed IS NULL;

CREATE INDEX IF NOT EXISTS idx_thoughts_last_accessed ON thoughts (last_accessed);

-- RPC to atomically increment access_count for a batch of thought IDs
CREATE OR REPLACE FUNCTION increment_access_count(thought_ids uuid[])
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE thoughts
  SET access_count = access_count + 1
  WHERE id = ANY(thought_ids);
END;
$$;
