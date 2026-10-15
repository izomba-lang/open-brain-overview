# Миграции

Схема, которую ждут опубликованные функции. Таблицы `thoughts`, `people`, `projects`
и `skills` создаются руками по SETUP-GUIDE (шаги 2.2–2.5); эти файлы накатываются
поверх них, по порядку имён:

```bash
supabase db push
```

или вставкой каждого файла по очереди в SQL Editor.

| Что | Файлы |
|---|---|
| Дедлайны и затухание памяти | `add_due_date`, `memory_decay` |
| Гибридный поиск (BM25 + вектор) | `hybrid_search` → RPC `hybrid_match_thoughts` |
| Люди: алиасы и нечёткий поиск | `canonical_name_map` (`person_aliases`), `normalized_person_name`, `find_similar_person_word_boundary`, `find_orphan_people`, `merge_linked_people_rpc` |
| Вики-компилятор | `wiki_compiler_tables` (`wiki_entities`, `entity_aliases`, `wiki_compile_runs`), `artifacts_table`, `wiki_entity_backoff`, `wiki_contradictions_cache` |
| Транскрипты встреч | `raw_transcripts` → RPC `search_transcripts` |
| Аудит фоновых задач | `job_runs` |
| Голосовые звонки (Vapi) | `voice_agent` (`call_tasks`, `call_messages`, `call_events`) |

Сюда намеренно не попали seed-миграции (алиасы и сущности вики автора) и
cron-миграции: расписание pg_cron каждый настраивает сам, а ключ доступа к
функциям в нём должен браться из Supabase Vault, не из текста миграции.

Таблиц здоровья (`health_metrics_daily`, `health_workouts`) здесь нет: их схема в боевом репо не зафиксирована миграцией, поэтому тулы здоровья без них вернут ошибку.
