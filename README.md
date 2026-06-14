# Open Brain

Персональная AI-память с автоматической wiki. Кидаешь мысли через Telegram, звонки, почту, чаты — система сохраняет, связывает и каждую ночь компилирует в структурированную wiki, которую читаешь в Obsidian.

## Как это работает

```
                    ВВОД (автоматический)                          ВЫВОД
   ┌──────────────────────────────────────┐
   │  Telegram-бот    (текст, голосовые)  │
   │  Zoom/Meet       (Granola транскрипт)│       ┌─────────────────────────┐
   │  Gmail           (письма, тредки)    │──────>│     Open Brain DB       │
   │  Slack           (сообщения)         │       │  PostgreSQL + pgvector  │
   │  AI-клиент       (Claude, ChatGPT)   │       │  ~1500 мыслей/мес       │
   │  Chrome          (закладки, заметки) │       └───────────┬─────────────┘
   └──────────────────────────────────────┘                   │
                                                              │
                                          ┌───────────────────┼───────────────────┐
                                          │                   │                   │
                                          ▼                   ▼                   ▼
                                    MCP-сервер          Wiki Compiler        Telegram-бот
                                   (30 инструментов)   (ночная сборка)      (/today, /tasks)
                                          │                   │                   │
                                          ▼                   ▼                   ▼
                                   Claude Desktop        Obsidian             Мобильный
                                   Cursor, Claude Code   (brain-wiki)        уведомления
```

## Слои системы

### 1. Захват (автопилот)
Ты работаешь как обычно. Мысли попадают в базу автоматически:
- **Telegram-бот** — кинул текст или голосовое, сохранилось как мысль с авто-категоризацией
- **Granola** — записал звонок, транскрипт ночью попадает в базу
- **Gmail** — письма, ждущие твоего ответа, ежеутренне попадают в базу одной мыслью на письмо
- **Календарь** — встречи на сегодня и завтра автоматически синхронизируются (одна мысль на событие)
- **AI-клиент** — сказал Claude "запомни что..." — `capture_thought` сохранит
- **Chrome-расширение** — новая вкладка с топ-3 задачами на день

### 2. Синтез (ночной робот)
Каждую ночь Wiki Compiler:
1. Проверяет, по каким сущностям (страны, люди, компании, топики) появились новые мысли
2. Собирает все мысли по сущности, отправляет Claude Sonnet 4
3. Claude генерирует markdown-страницу: TL;DR, открытые вопросы, ключевые решения, противоречия
4. Страница коммитится в GitHub-репо `brain-wiki`
5. Стоимость: ~$0.15 за страницу, ~$3 за полный прогон 20 сущностей

### 3. Чтение (Obsidian)
Утром открываешь Obsidian — свежая wiki с кросс-ссылками и Graph View:
- `countries/turkey.md` — всё что знаешь про конкретный рынок
- `people/ivanov.md` — история взаимодействия с контактом
- `topics/tax-planning.md` — тематическая сводка
- `_contradictions.md` — где данные конфликтуют между собой
- Секция **Артефакты** — кликабельные ссылки на документы, расчёты, презентации

### 4. Проактивный советник
Память не только отвечает на запросы, но и сама подсказывает следующий шаг:
- **Утренний бриф** — каждое утро короткая сводка: фокус дня, до 3 советов, предупреждения о просрочках. На каждый совет кнопки «беру / не надо / позже» — реакции копятся и подмешиваются в следующий бриф, так советник учится (feedback loop)
- **Дедлайны** — один дайджест с задачами на ближайшие 48 часов; по понедельникам — блок просроченного с кнопкой «закрыть пачкой»
- **Обязательства из встреч** — после звонка система вытаскивает из транскрипта твои обязательства и заводит их задачами
- **Принцип precision > recall** — лучше промолчать, чем дать слабый совет; жёсткий лимит, чтобы не превратиться в спам

## MCP-сервер (30 инструментов)

Подключается к любому AI-клиенту (Claude Desktop, Cursor, Claude Code, ChatGPT):

| Категория | Инструменты |
|---|---|
| Поиск и чтение | `search_thoughts`, `list_thoughts`, `thought_stats` |
| Запись | `capture_thought`, `update_thought`, `delete_thought` |
| Люди | `manage_person`, `list_people`, `delete_person`, `merge_person`, `manage_alias` |
| Проекты | `manage_project`, `list_projects`, `delete_project` |
| Скиллы | `route_task`, `list_skills`, `manage_skill`, `import_skill` |
| Wiki | `compile_wiki`, `manage_wiki_entity`, `manage_artifact` |
| Здоровье | `get_health_summary`, `get_health_trend`, `correlate_health_thoughts` |
| Другое | `get_style_profile`, `voice_call` |

## Скиллы (15+)

Готовые "рецепты" для задач. Claude автоматически находит подходящий через `route_task`:

- **Коммуникация:** draft-email, follow-up, text-quality-pipeline
- **Менеджмент:** meeting-brief, weekly-report, delegate-task, decision-log
- **Продукт:** product-manager, plan-ceo-review, executive-summary-generator
- **Разработка:** code-reviewer, office-hours

Можно создавать свои (`manage_skill`) или импортировать из GitHub (`import_skill`).

## Стек

| Компонент | Технология |
|---|---|
| Runtime | Deno (Supabase Edge Functions) |
| База данных | PostgreSQL + pgvector (1536-dim embeddings) |
| Embeddings | `text-embedding-3-small` через OpenRouter |
| Wiki Compiler | Claude Sonnet 4 (Anthropic API) |
| Wiki хранилище | GitHub (private repo) |
| Wiki читалка | Obsidian + Obsidian Git plugin |
| Протокол | MCP (JSON-RPC 2.0 over HTTP) |
| Голосовые | Groq Whisper (STT) |
| Звонки | Vapi (voice agent) |

## Стоимость

| Компонент | Стоимость |
|---|---|
| Supabase | Free tier (500MB, 500K invocations/мес) |
| OpenRouter (embeddings) | ~$0.001/мысль |
| Wiki Compiler (Anthropic) | ~$3/полный прогон, ~$0.50/ночь incremental |
| Groq (голосовые) | Free tier |
| Telegram | Бесплатно |
| **Итого** | **~$15-20/мес при активном использовании** |

## Быстрый старт

Подробный гайд: **[SETUP-GUIDE.md](SETUP-GUIDE.md)**

Краткий план:
1. Создать проект в Supabase
2. Выполнить SQL-миграции (pgvector, таблицы, функции)
3. Получить API-ключи (OpenRouter, Telegram, Anthropic)
4. Задеплоить Edge Functions через Supabase CLI
5. Настроить Telegram webhook
6. Подключить MCP к AI-клиенту
7. (Опционально) Настроить brain-wiki + Obsidian

## Структура репо

```
open-brain-overview/
├── README.md                      ← этот файл
├── SETUP-GUIDE.md                 ← пошаговый гайд настройки
├── ONBOARDING.md                  ← краткий Quick Start
├── PERSONAL-GOOGLE-MCP-SETUP.md   ← настройка Google MCP (Gmail, Calendar, Drive)
├── src/
│   ├── supabase/                  ← SQL-миграции и Edge Functions
│   ├── deploy.sh                  ← скрипт деплоя
│   └── chrome-extension/          ← Chrome new tab extension
└── skills/                        ← готовые скиллы для импорта
```

## Примеры использования

**Через Telegram:**
- Кинул текст — сохранилось как мысль
- `?что я решил по проекту X` — поиск по базе
- `/today` — план на день из задач и встреч
- `/call позвони и забронируй стол на 4 человека` — голосовой агент

**Через AI-клиент (Claude Desktop / Cursor):**
- "Подготовь бриф к встрече с партнёром" — `route_task` найдёт skill `meeting-brief`
- "Что я знаю про налоговое планирование?" — `search_thoughts` по базе
- "Добавь Казахстан в wiki" — `manage_wiki_entity` + `compile_wiki`
- "Прикрепи финмодель к проекту" — `manage_artifact`

## Лицензия

MIT. Форкай, адаптируй под себя.
