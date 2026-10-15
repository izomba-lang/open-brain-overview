-- Фаза 8: backoff для error-сущностей wiki.
-- error_count растёт при каждой неудачной компиляции, next_retry_at откладывает ретрай.
-- Сущности с next_retry_at > now() пропускаются в getTouchedEntities; при успехе оба поля сбрасываются.

alter table wiki_entities add column if not exists error_count int not null default 0;
alter table wiki_entities add column if not exists next_retry_at timestamptz;

-- Частичный индекс: отбор сущностей, готовых к ретраю, не сканирует всю таблицу.
create index if not exists idx_wiki_entities_next_retry
  on wiki_entities (next_retry_at)
  where next_retry_at is not null;
