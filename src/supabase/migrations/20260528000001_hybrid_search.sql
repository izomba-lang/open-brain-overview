-- Hybrid search: BM25 (tsvector) + vector (pgvector) with Reciprocal Rank Fusion.

-- 1. Add tsvector column for full-text search (simple + russian tokenization)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. Trigger to auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION thoughts_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple',  coalesce(NEW.content, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_search_vector_trigger ON thoughts;
CREATE TRIGGER thoughts_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION thoughts_search_vector_update();

-- 3. Backfill existing rows
UPDATE thoughts SET search_vector =
  setweight(to_tsvector('simple',  coalesce(content, '')), 'A') ||
  setweight(to_tsvector('russian', coalesce(content, '')), 'B');

-- 4. GIN index for fast text search
CREATE INDEX IF NOT EXISTS idx_thoughts_search_vector ON thoughts USING gin(search_vector);

-- 5. Hybrid match function: BM25 + vector + RRF + decay
SET search_path TO public, extensions;

CREATE OR REPLACE FUNCTION hybrid_match_thoughts(
  query_embedding vector(1536),
  query_text text,
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 20,
  rrf_k int DEFAULT 60,
  decay_half_life_days int DEFAULT 90
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  text_rank float,
  combined_score float,
  due_date timestamptz
)
LANGUAGE plpgsql AS $$
DECLARE
  fetch_limit int := match_count * 3;
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      t.id AS vid,
      (1 - (t.embedding <=> query_embedding))::float AS vsim,
      ROW_NUMBER() OVER (ORDER BY t.embedding <=> query_embedding) AS vrank
    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    ORDER BY t.embedding <=> query_embedding
    LIMIT fetch_limit
  ),
  text_query AS (
    SELECT plainto_tsquery('simple', query_text) || plainto_tsquery('russian', query_text) AS q
  ),
  text_results AS (
    SELECT
      t.id AS tid,
      ts_rank_cd(t.search_vector, tq.q, 32)::float AS trank,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(t.search_vector, tq.q, 32) DESC) AS frank
    FROM thoughts t, text_query tq
    WHERE t.search_vector @@ tq.q
    LIMIT fetch_limit
  ),
  all_ids AS (
    SELECT vid AS aid FROM vector_results
    UNION
    SELECT tid AS aid FROM text_results
  ),
  scored AS (
    SELECT
      a.aid,
      COALESCE(v.vsim, 0)::float AS sim,
      COALESCE(tr.trank, 0)::float AS trnk,
      (
        COALESCE(1.0 / (rrf_k + v.vrank), 0) +
        COALESCE(1.0 / (rrf_k + tr.frank), 0)
      )::float AS rrf_score
    FROM all_ids a
    LEFT JOIN vector_results v ON v.vid = a.aid
    LEFT JOIN text_results tr ON tr.tid = a.aid
  )
  SELECT
    t.id,
    t.content,
    t.metadata,
    s.sim AS similarity,
    s.trnk AS text_rank,
    -- Apply Ebbinghaus decay: score * 1/(1 + age/half_life)
    (s.rrf_score * (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - COALESCE(t.last_accessed, t.created_at))) / (86400.0 * decay_half_life_days))))::float AS combined_score,
    t.due_date
  FROM scored s
  JOIN thoughts t ON t.id = s.aid
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
