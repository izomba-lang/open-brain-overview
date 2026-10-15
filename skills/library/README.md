# Библиотека скиллов

15 скиллов из таблицы `skills` боевого инстанса Open Brain, обезличенные. Каждый файл — одна запись: frontmatter с полями таблицы (`name`, `description`, `category`, `client`, `trigger_patterns`, `tools_required`) и раздел `skill_prompt` с самим промптом.

Claude находит нужный скилл сам через `route_task`, если скиллы лежат в твоей базе.

## Как импортировать

**Через AI-клиент с подключённым MCP** (проще всего): попроси

> Импортируй скилл из https://raw.githubusercontent.com/izomba-lang/open-brain-overview/main/skills/library/meeting-brief.md

Тул `import_skill` скачает файл, LLM разберёт поля и сохранит запись с эмбеддингом.

**Через `manage_skill`** — если хочешь контролировать поля точно: передай `name`, `description`, `category`, `trigger_patterns`, `tools_required` и `skill_prompt` из файла как есть.

## Что учесть

- **Скиллы для текста** (`draft-email`, `email-writer`, `text-quality-pipeline`, `ru-deck-editor`, `follow-up`, `delegate-task`) опираются на `get_style_profile`. Без заполненного профиля стиля они работают на дефолтных правилах из промпта. Профиль стоит написать под себя, с явными лимитами частоты («тире не больше двух на абзац»): модели переусиливают любое упомянутое правило.
- **Скиллы из внешних наборов** (`code-reviewer`, `executive-summary-generator`, `product-manager`, `office-hours`, `plan-ceo-review`, `weekly-engineering-retrospective`) импортированы автоматически через `import_skill`, поэтому их `skill_prompt` — короткая инструкция по тулам Open Brain, а не полный оригинальный промпт. Хочешь больше пользы — замени промпт на развёрнутый.
- `email_writer` переименован в `email-writer` для единообразия. По смыслу он пересекается с `draft-email`; оставь один, если `route_task` путается между ними.
- Не экспортирован один скилл, целиком завязанный на личные данные автора (отчёт о расходах по конкретной корпоративной карте).
