-- Ensure pgvector is available
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Add due_date column to thoughts
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS due_date timestamptz;

-- Partial index: only rows with a deadline
CREATE INDEX IF NOT EXISTS idx_thoughts_due_date ON thoughts (due_date) WHERE due_date IS NOT NULL;

-- Update match_thoughts to return due_date (must drop first — return type changed)
SET search_path TO public, extensions;
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int);
CREATE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  due_date timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::float AS similarity,
    t.due_date
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
