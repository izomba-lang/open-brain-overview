-- Phase 11 (Backlog): cache each entity's "Противоречия" section in the DB.
--
-- regenerateContradictionsPage() used to GET every active wiki page from GitHub
-- on every run to extract its contradictions section. The nightly compile runs
-- in pick_one mode every ~10 minutes, and that meta-page regen fires each tick →
-- N GitHub GETs every 10 minutes. We now cache the extracted section here and
-- refresh it whenever an entity is compiled.
--
--   NULL  = never cached (cold)  → regen falls back to one GitHub GET + backfill
--   ''    = cached, no meaningful contradictions section
--   text  = cached contradictions body (without the "## ⚠️ Противоречия" header)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

alter table wiki_entities
  add column if not exists contradictions_md text;
