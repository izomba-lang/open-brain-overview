# Open Brain — Setup Guide

Гайд по настройке собственной системы Open Brain с нуля. Open Brain — персональная AI-память: ты скидываешь мысли, задачи, заметки через Telegram или Slack, а система их сохраняет, связывает между собой и отвечает на вопросы по твоей базе знаний.

---

## Что ты получишь

- **Telegram-бот** — кидаешь текст или голосовое, бот сохраняет как "мысль" с автоматической категоризацией
- **Команды**: `/today` (план на день), `/tasks` (список задач), вопросы к базе знаний
- **MCP-сервер** — подключается к Claude Desktop, ChatGPT, Cursor и любому AI-клиенту
- **Chrome-расширение** — новая вкладка показывает топ-3 приоритетных задач
- **Семантический поиск** — ищет по смыслу, а не по словам
- **Система скиллов** — готовые "рецепты" для задач: meeting-brief, follow-up, weekly-report и другие. Можно создавать свои и импортировать из GitHub

## Архитектура

```
Telegram / Slack / AI-клиент
        ↓
  Supabase Edge Functions (Deno)
        ↓
  PostgreSQL + pgvector
        ↓
  OpenRouter API (embeddings + LLM)
```

---

## Шаг 1. Создай проект в Supabase

1. Зарегистрируйся на [supabase.com](https://supabase.com)
2. Создай новый проект, запомни:
   - **Project ref** (в URL: `https://supabase.com/dashboard/project/<project-ref>`)
   - **Region** (выбирай ближайший к себе)
3. Дождись инициализации проекта (~2 минуты)

## Шаг 2. Настрой базу данных

Открой **SQL Editor** в Supabase Dashboard и выполни по очереди:

### 2.1. Включи pgvector

```sql
create extension if not exists vector with schema extensions;
```

### 2.2. Создай таблицу thoughts

```sql
create table public.thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  due_date timestamptz,           -- дедлайн задачи (фильтры deadline_before/after, /tasks, overdue)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Индекс для быстрого векторного поиска
create index thoughts_embedding_idx on public.thoughts
  using hnsw (embedding vector_cosine_ops);

-- Индекс для JSON-запросов по metadata
create index thoughts_metadata_idx on public.thoughts
  using gin (metadata);

-- Автообновление updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger thoughts_updated_at
  before update on public.thoughts
  for each row execute function update_updated_at();
```

### 2.3. Создай таблицу people

```sql
create table public.people (
  id uuid default gen_random_uuid() primary key,
  name text unique not null,
  context text,
  role text,
  organization text,
  area text,
  metadata jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

create trigger people_updated_at
  before update on public.people
  for each row execute function update_updated_at();
```

### 2.4. Создай таблицу projects

```sql
create table public.projects (
  id uuid default gen_random_uuid() primary key,
  name text unique not null,
  description text,
  status text default 'active',
  area text,
  deadline text,
  metadata jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

create trigger projects_updated_at
  before update on public.projects
  for each row execute function update_updated_at();
```

### 2.5. Создай таблицу skills

```sql
create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null,
  trigger_patterns text[] not null default '{}',
  client text not null default 'any',
  skill_prompt text,
  tools_required text[] not null default '{}',
  category text not null default 'general',
  embedding extensions.vector(1536),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Индекс для семантического поиска скиллов
create index if not exists skills_embedding_idx on skills
  using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists skills_category_idx on skills (category);
```

### 2.6. Создай функцию семантического поиска

```sql
create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
  order by t.embedding <=> query_embedding
  limit match_count;
$$;
```

### 2.7. Создай функцию поиска скиллов

```sql
create or replace function match_skills(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.5,
  match_count int default 5
)
returns table (
  id uuid,
  name text,
  description text,
  client text,
  skill_prompt text,
  tools_required text[],
  category text,
  trigger_patterns text[],
  similarity float
)
language plpgsql stable
set search_path = public, extensions
as $$
begin
  return query
  select
    s.id,
    s.name,
    s.description,
    s.client,
    s.skill_prompt,
    s.tools_required,
    s.category,
    s.trigger_patterns,
    (1 - (s.embedding <=> query_embedding))::float as similarity
  from skills s
  where s.is_active = true
    and 1 - (s.embedding <=> query_embedding) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

### 2.8. RLS и права для service_role (обязательный шаг)

Edge Functions ходят в базу под `service_role` — этот ключ по умолчанию обходит RLS.
Но при некоторых конфигурациях (особенно с новой системой API-ключей Supabase) запросы
падают с `permission denied for table thoughts`. Чтобы гарантированно не ловить эту ошибку,
выполни оба блока:

```sql
-- 1. Включаем RLS (service_role всё равно его обходит; это защита для anon/authenticated)
alter table public.thoughts enable row level security;
alter table public.people   enable row level security;
alter table public.projects enable row level security;
alter table public.skills   enable row level security;

-- 2. Явно выдаём права service_role на все таблицы и последовательности схемы public
grant usage on schema public to service_role;
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- 3. И на будущие таблицы/функции (чтобы новые миграции не требовали повторного grant)
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
```

> Если после этого всё ещё ловишь `permission denied` — как аварийный вариант можно
> временно отключить RLS: `alter table public.thoughts disable row level security;`
> (и аналогично для people/projects/skills). Но `grant` выше — предпочтительнее.

### 2.9. Что покрывает эта схема (и что — нет)

Схема выше — это **ядро**: его достаточно, чтобы заработали capture, семантический
поиск, задачи/дедлайны, проекты, люди, скиллы и Telegram-бот. На этом ядре работают
основные инструменты MCP: `capture_thought`, `search_thoughts`, `list_thoughts`,
`update_thought`, `manage_project`, `manage_person`, `list_skills`, `route_task`,
`import_skill`, `thought_stats`.

`open-brain-mcp` в репозитории — полная версия и содержит ещё и **продвинутые**
инструменты (health-трекинг, компиляция wiki, голосовой агент, поиск по транскриптам,
алиасы людей, артефакты). Им нужны дополнительные таблицы и RPC, которых в этой
быстрой схеме нет — такие инструменты вернут ошибку вида `relation "wiki_entities"
does not exist`, пока ты не накатишь соответствующие миграции. Это нормально: ядро от
этого не страдает. Если захочешь включить продвинутый слой — заводи таблицы под
конкретный инструмент по мере необходимости.

## Шаг 3. Получи API-ключи

Тебе понадобятся:

| Сервис | Что получить | Где |
|--------|-------------|-----|
| **OpenRouter** | API Key | [openrouter.ai/keys](https://openrouter.ai/keys) — нужен для embeddings и LLM |
| **Telegram** | Bot Token | [@BotFather](https://t.me/BotFather) — создай нового бота |
| **Telegram** | Твой User ID | [@userinfobot](https://t.me/userinfobot) — чтобы бот работал только для тебя |
| **Groq** | API Key | [console.groq.com](https://console.groq.com) — для транскрипции голосовых |

> **Важно: пополни баланс OpenRouter.** Сохранение мыслей и поиск используют платные
> вызовы (embeddings + extraction). На нулевом балансе OpenRouter отвечает
> `401 User not found` — и это легко принять за неверный ключ, хотя дело в кредитах.
> Закинь хотя бы $5 на [openrouter.ai/credits](https://openrouter.ai/credits), иначе
> `capture_thought` и Telegram-бот не заработают.

Придумай свой **MCP_ACCESS_KEY** — любая длинная случайная строка, которая будет паролем к API (например, сгенерируй через `openssl rand -hex 24`).

## Шаг 4. Установи Supabase CLI

```bash
# macOS
brew install supabase/tap/supabase

# или npm
npm install -g supabase
```

Залогинься:

```bash
supabase login
```

## Шаг 5. Создай проект и задеплой

### 5.1. Создай структуру проекта

Весь исходный код лежит в папке [`src/`](src/) этого репозитория. Скопируй его к себе:

```bash
# Вариант 1: клонируй этот репозиторий
git clone https://github.com/izomba-lang/open-brain-overview.git
cd open-brain-overview/src

# Вариант 2: скачай только src/ через GitHub
```

Структура:
```
src/
├── supabase/functions/
│   ├── open-brain-mcp/                ← MCP-сервер (handlers + client/transport)
│   ├── ingest-thought-telegram/index.ts ← Telegram-бот (текст + голос)
│   ├── ingest-thought/index.ts        ← Slack-пайплайн (опционально)
│   ├── compile-wiki/index.ts          ← ночной компилятор wiki (опционально)
│   └── _shared/                       ← общий код: ingest, llm, people, topic-rules…
├── supabase/migrations/               ← SQL-миграция для skills
├── chrome-extension/                  ← Chrome new tab dashboard
└── deploy.sh                          ← Скрипт деплоя с версионированием
```

> **Сразу скачивай `.ts` через `git clone`, а не по одному файлу из браузера** —
> GitHub отдаёт `.ts` как `text/plain`, и браузер часто открывает их вместо
> сохранения, ломая структуру. Клон сохраняет все файлы и вложенность как есть.

### 5.1.1. Создай личные конфиги из шаблонов

В `_shared/` лежат два шаблона с суффиксом `.example`. Код импортирует их **без**
суффикса, а реальные версии добавлены в `.gitignore` — так твои имена, проекты и
namespace'ы не попадают в публичный репозиторий. Перед деплоем скопируй шаблоны и
подставь свои данные (имя/должность в `persona_config.ts`, свои namespace'ы и примеры
в `topic_config.ts`):

```bash
cd src/supabase/functions/_shared
cp persona_config.example.ts persona_config.ts
cp topic_config.example.ts   topic_config.ts
cd -
```

> Если не скопировать — деплой упадёт с понятной ошибкой импорта
> (`Module not found: ./topic_config.ts`). Это и есть напоминание создать конфиги.

### 5.2. Инициализируй Supabase-проект

```bash
cd src
supabase init
supabase link --project-ref <твой-project-ref>
```

### 5.3. Установи секреты

```bash
supabase secrets set \
  OPENROUTER_API_KEY="sk-or-..." \
  MCP_ACCESS_KEY="<твой_сгенерированный_ключ>" \
  TELEGRAM_BOT_TOKEN="123456:ABC-DEF..." \
  TELEGRAM_ALLOWED_USER_ID="123456789" \
  GROQ_API_KEY="gsk_..." \
  SERVICE_ROLE_KEY="<твой_service_role_key>"
```

> **Про `SERVICE_ROLE_KEY`.** Edge Functions ходят в базу под service_role. Раньше
> Supabase автоматически прокидывал `SUPABASE_SERVICE_ROLE_KEY`, но с новой системой
> ключей это срабатывает не всегда, а задать секрет с префиксом `SUPABASE_` нельзя
> (`Env name cannot start with SUPABASE_, skipping`). Поэтому код читает сначала
> `SERVICE_ROLE_KEY`, и только потом — авто-переменную. Скопируй service_role key из
> **Supabase Dashboard → Project Settings → API → Project API keys → `service_role`**
> и задай его под именем `SERVICE_ROLE_KEY`, как выше.

> **Опционально — `ANTHROPIC_API_KEY`.** Нужен только для функций, генерирующих текст
> через Claude (ночной компилятор wiki, план дня высокого качества). Для базового
> сценария (capture + поиск + Telegram-бот) не требуется — там всё на OpenRouter.

### 5.4. Задеплой функции

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy ingest-thought-telegram --no-verify-jwt
```

Slack-функция опциональна:
```bash
supabase functions deploy ingest-thought --no-verify-jwt
```

Или используй скрипт деплоя:
```bash
bash deploy.sh  # деплоит все функции + версионирование
```

## Шаг 6. Подключи Telegram-бота

Установи webhook — замени `<project-ref>` на свой:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<project-ref>.supabase.co/functions/v1/ingest-thought-telegram"}'
```

Проверь:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Теперь напиши боту в Telegram — он должен ответить!

## Шаг 7. Проверь MCP-сервер

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"thought_stats","arguments":{}}}'
```

Должен вернуть JSON с пустой статистикой.

## Шаг 8. Подключи к AI-клиентам

### Claude Desktop

Добавь в `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "curl",
      "args": [
        "-s", "-X", "POST",
        "https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>",
        "-H", "Content-Type: application/json",
        "-d", "@-"
      ]
    }
  }
}
```

> Или используй любой MCP-клиент, который поддерживает HTTP transport.

### Cursor

Создай файл `.cursor/mcp.json` в корне проекта:

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>"
    }
  }
}
```

### Claude Code

Добавь в настройки MCP-серверов:
- **URL**: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>`
- **Transport**: HTTP (JSON-RPC 2.0)

### ChatGPT

Подключение MCP к ChatGPT требует двух вещей:

1. **Платный план** (Plus/Pro/Team) — на бесплатном кастомные коннекторы недоступны.
2. **Developer Mode** — включается в **Settings → Connectors → Advanced → Developer
   Mode**. Учти: он **отключает встроенную память ChatGPT** в пользу внешних
   коннекторов — это ожидаемо, память теперь живёт в Open Brain.

Дальше добавь коннектор с тем же URL и `?key=<MCP_ACCESS_KEY>`. Подробнее — в
`skills/open-brain-companion/SKILL.md`.

## Шаг 9. Chrome-расширение (опционально)

1. Открой `chrome://extensions/`
2. Включи **Developer mode**
3. Нажми **Load unpacked**
4. Выбери папку `chrome-extension/`
5. Открой новую вкладку — появится дэшборд
6. Введи в настройках:
   - **Endpoint**: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`
   - **API Key**: твой `MCP_ACCESS_KEY`

## Шаг 10. Чтение wiki в Obsidian (опционально)

Это слой поверх базы мыслей: ночной компилятор (`compile-wiki`) собирает мысли по
сущностям (страны, люди, компании, топики) в markdown-страницы и коммитит их в
отдельный GitHub-репозиторий. Ты читаешь и правишь эти страницы в Obsidian.

> Требует **продвинутой схемы** (таблицы `wiki_entities`, `wiki_compile_runs` и др.,
> см. шаг 2.9) и `ANTHROPIC_API_KEY` для качественного синтеза. Базовый сценарий
> (capture + поиск + бот) работает и без этого слоя.

1. **Создай приватный GitHub-репозиторий** для wiki (например, `brain-wiki`).
2. **Выдай функции доступ к нему** — задай секреты:
   ```bash
   supabase secrets set \
     GITHUB_TOKEN="ghp_..." \          # PAT с правом push в этот репо
     GITHUB_REPO="<user>/brain-wiki" \
     ANTHROPIC_API_KEY="sk-ant-..."
   ```
   Имя репо также прописано в `persona_config.ts` (`WIKI_REPO`) — оно должно совпадать.
3. **Задеплой компилятор**: `supabase functions deploy compile-wiki --no-verify-jwt`.
4. **Запусти компиляцию** — из AI-клиента «скомпилируй все wiki-страницы»
   (`compile_wiki`) или дёрни функцию напрямую. Страницы появятся в `brain-wiki`.
5. **Открой wiki в Obsidian:**
   - Установи [Obsidian](https://obsidian.md), затем плагин **Obsidian Git**
     (Settings → Community plugins → Browse → "Obsidian Git").
   - Открой клон репозитория `brain-wiki` как vault (или склонируй его в папку vault'а).
   - Включи в Obsidian Git авто-pull (например, каждые N минут) — и каждое утро
     получаешь свежую wiki с кросс-ссылками `[[entity]]` и Graph View.
   - Правки, сделанные в Obsidian, компилятор не затирает: блоки `<!-- USER: ... -->`
     сохраняются как есть.

---

## Как пользоваться

### Telegram-бот

| Действие | Что делать |
|----------|-----------|
| Сохранить мысль | Просто напиши текст |
| Голосовая заметка | Отправь голосовое сообщение |
| Переслать | Перешли сообщение — сохранится с пометкой |
| Задать вопрос | Начни с `?` или задай вопрос ("Что мы решили про...?") |
| План на день | `/today` |
| Список задач | `/tasks` |

### MCP-сервер (15 инструментов, через AI-клиента)

- **"Запомни: завтра встреча с Петей в 15:00"** → `capture_thought`
- **"Что я знаю про налоги?"** → `search_thoughts`
- **"Покажи открытые задачи"** → `list_thoughts` (type: task)
- **"Отметь задачу X как выполненную"** → `update_thought`
- **"Создай проект Ремонт квартиры"** → `manage_project`
- **"Подготовь бриф к встрече"** → `route_task` → подберёт скилл `meeting-brief`
- **"Какие скиллы есть?"** → `list_skills`
- **"Импортируй скилл из GitHub"** → `import_skill` (URL или текст)

---

## Скиллы — готовые рецепты для задач

Скилл — это инструкция для AI, которая описывает шаги для конкретной задачи. Когда ты говоришь "подготовь бриф к встрече", `route_task` находит подходящий скилл и даёт AI готовый промпт.

### Предустановленные скиллы

| Скилл | Что делает |
|-------|-----------|
| `meeting-brief` | Собирает заметки, участников и задачи в бриф перед встречей |
| `follow-up` | Формирует письмо-фоллоуап после встречи в твоём стиле |
| `weekly-report` | Генерирует еженедельный отчёт из заметок за неделю |
| `delegate-task` | Составляет чёткую постановку задачи для делегирования |
| `decision-log` | Фиксирует решение с контекстом, альтернативами и обоснованием |
| `draft-email` | Пишет email в твоём стиле на основе контекста из базы |

### Импорт скиллов

Можно импортировать скиллы из GitHub — система автоматически адаптирует их:

```
# Через AI-клиента (Claude Desktop, Cursor и т.д.):
"Импортируй скилл из https://github.com/user/repo/blob/main/SKILL.md"
```

Или через MCP напрямую — `import_skill` принимает URL или текст описания скилла.

### Создание своих скиллов

Через AI-клиента:
```
"Создай скилл standup-summary: собирает задачи за последние 24 часа,
группирует по проектам, формирует краткий отчёт для стендапа"
```

Или через `manage_skill` с описанием, trigger_patterns и промптом.

---

## Стоимость

| Сервис | Стоимость |
|--------|----------|
| Supabase | Free tier: 500MB БД, 500K Edge Function invocations/мес |
| OpenRouter | ~$0.001 за embedding, ~$0.005 за metadata extraction |
| Groq | Free tier: достаточно для голосовых |
| Telegram | Бесплатно |

На практике при активном использовании (50-100 мыслей/день) — **меньше $1/мес** на OpenRouter.

---

## Troubleshooting

### Бот не отвечает
```bash
# Проверь логи
supabase functions logs ingest-thought-telegram --project-ref <ref>

# Проверь webhook
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### MCP возвращает 401
Проверь, что `MCP_ACCESS_KEY` совпадает с тем, что передаёшь в `?key=`.

### Сохранение мысли падает с `401 User not found`
Это ошибка **OpenRouter**, а не Supabase: на балансе нет кредитов. Пополни OpenRouter
(см. Шаг 3) — `capture_thought` и бот заработают.

### `permission denied for table thoughts`
Не выполнен grant для service_role. Вернись к **шагу 2.8** и накати блок с `grant ...`.

### `column thoughts.due_date does not exist`
Таблица создана по старой схеме без `due_date`. Добавь колонку:
```sql
alter table public.thoughts add column if not exists due_date timestamptz;
```

### `Module not found` при деплое (`topic_config.ts` / `persona_config.ts`)
Не скопированы личные конфиги из шаблонов. См. **шаг 5.1.1** (`cp *.example.ts → *.ts`).

### Инструмент вернул `relation "..." does not exist`
Ты дёрнул продвинутый инструмент (health/wiki/voice/transcripts), для которого нужна
доп. таблица. Для базового сценария это не нужно — см. **шаг 2.9**.

### Поиск ничего не находит
Убедись, что pgvector extension включен и `match_thoughts` функция создана. Попробуй уменьшить threshold до 0.3.

### Chrome-расширение не загружает задачи
Проверь endpoint (должен быть без `/` в конце) и API key в настройках расширения.

---

## Кастомизация

- **Язык** — бот и дэшборд на русском. Чтобы переключить на английский, поменяй строки в `ingest-thought-telegram/index.ts` и `chrome-extension/newtab.js`
- **Приоритизация задач** — логика скоринга в `newtab.js` → `pickTopTasks()`. Можно менять веса
- **Стиль письма** — сохрани мысль с `source: "style_analysis"` через `capture_thought`, и AI будет использовать твой стиль при генерации текстов
- **Slack-интеграция** — задеплой `ingest-thought`, создай Slack App с Event Subscriptions, укажи URL функции

---

*Built with Supabase, pgvector, OpenRouter, and Deno.*
