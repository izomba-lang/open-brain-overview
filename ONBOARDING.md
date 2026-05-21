# Open Brain — Quick Start

Персональная AI-память на Supabase + pgvector. Кидаешь мысли через Telegram или AI-клиент, система их сохраняет, связывает и отвечает на вопросы по базе знаний.

## Что получишь

- **Telegram-бот** — текст или голосовое -> мысль с авто-категоризацией; команды `/today`, `/tasks`
- **MCP-сервер** — 15+ инструментов для Claude Desktop, Cursor, Claude Code
- **Chrome-расширение** — новая вкладка с топ-3 задачами
- **Система скиллов** — meeting-brief, follow-up, weekly-report и ещё 12 готовых рецептов

## Архитектура

```
Telegram / AI-клиент
      |
Supabase Edge Functions (Deno)
      |
PostgreSQL + pgvector
      |
OpenRouter API (embeddings + LLM)
```

## Настройка: 9 шагов

Подробный гайд: https://github.com/izomba-lang/open-brain-overview/blob/main/SETUP-GUIDE.md

Краткий план:

1. **Supabase** — создать проект на supabase.com
2. **БД** — выполнить SQL: pgvector, таблицы thoughts/people/projects/skills, функции match_thoughts/match_skills
3. **API-ключи** — OpenRouter, Telegram Bot Token, Telegram User ID, Groq (для голосовых), придумать MCP_ACCESS_KEY
4. **Supabase CLI** — `brew install supabase/tap/supabase && supabase login`
5. **Клонировать репо** — `git clone https://github.com/izomba-lang/open-brain-overview.git`
6. **Деплой** — `supabase link`, `supabase secrets set ...`, `supabase functions deploy`
7. **Telegram webhook** — `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" ...`
8. **AI-клиент** — подключить MCP-сервер к Claude Desktop / Cursor / Claude Code
9. **Chrome-расширение** — загрузить unpacked из `src/chrome-extension/`

## Стоимость

- Supabase Free tier (500MB БД, 500K invocations/мес)
- OpenRouter ~$0.001/embedding, ~$0.005/metadata extraction
- Groq Free tier
- Telegram бесплатно

На практике < $1/мес при 50-100 мыслей/день.

## Скиллы (15 штук)

**Коммуникация:** text-quality-pipeline, draft-email, email_writer, follow-up

**Менеджмент:** meeting-brief, weekly-report, delegate-task, decision-log, product-manager, plan-ceo-review, executive-summary-generator, weekly-engineering-retrospective

**Разработка:** code-reviewer, office-hours, expense-report-aed

Можно создавать свои через `manage_skill` или импортировать из GitHub через `import_skill`.

## Brain-wiki (ночная компиляция)

Опциональный слой поверх базы мыслей. Каждую ночь Wiki Compiler:

1. Находит сущности (страны, люди, компании, топики), по которым появились новые мысли
2. Собирает все мысли по сущности, отправляет Claude Sonnet 4
3. Claude генерирует markdown-страницу: TL;DR, открытые вопросы, ключевые решения, противоречия
4. Страница коммитится в приватный GitHub-репо `brain-wiki`

Утром открываешь Obsidian (с Obsidian Git plugin) — свежая wiki с кросс-ссылками и Graph View:
- `countries/turkey.md` — всё по конкретному рынку
- `people/ivanov.md` — история взаимодействия с контактом
- `topics/tax-planning.md` — тематическая сводка
- `_contradictions.md` — где данные конфликтуют между собой

MCP-инструменты для wiki: `compile_wiki`, `manage_wiki_entity`, `manage_artifact`

Стоимость: ~$0.15 за страницу, ~$3 за полный прогон 20 сущностей, ~$0.50/ночь в инкрементальном режиме.

## MCP-инструменты

search_thoughts, list_thoughts, thought_stats, capture_thought, update_thought, delete_thought, manage_person, list_people, manage_project, list_projects, route_task, list_skills, manage_skill, import_skill, get_style_profile, compile_wiki, manage_wiki_entity, manage_artifact

## Полезные команды после настройки

- Через Telegram: просто пиши текст (сохранится как мысль), начни с `?` для вопроса
- Через AI: "Что я знаю про X?", "Подготовь бриф к встрече", "Напиши фоллоуап"
- Wiki: "Добавь Казахстан в wiki", "Прикрепи финмодель к странице Turkey"
