# Open Brain — Setup Guide

Гайд по настройке собственной системы Open Brain с нуля. Open Brain — персональная AI-память: ты скидываешь мысли, задачи, заметки через Telegram или Slack, а система их сохраняет, связывает между собой и отвечает на вопросы по твоей базе знаний.

---

## Что ты получишь

- **Telegram-бот** — кидаешь текст или голосовое, бот сохраняет как "мысль" с автоматической категоризацией
- **Команды**: `/today` (план на день), `/tasks` (список задач), вопросы к базе знаний
- **MCP-сервер** — подключается к Claude Desktop, ChatGPT, Cursor и любому AI-клиенту
- **Chrome-расширение** — новая вкладка показывает топ-3 приоритетных задач
- **Семантический поиск** — ищет по смыслу, а не по словам

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

### 2.5. Создай функцию семантического поиска

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

### 2.6. Отключи RLS (для Edge Functions с service role)

```sql
alter table public.thoughts enable row level security;
alter table public.people enable row level security;
alter table public.projects enable row level security;

-- Edge Functions используют service_role key, который обходит RLS
-- Если хочешь дополнительную защиту, добавь policies
```

## Шаг 3. Получи API-ключи

Тебе понадобятся:

| Сервис | Что получить | Где |
|--------|-------------|-----|
| **OpenRouter** | API Key | [openrouter.ai/keys](https://openrouter.ai/keys) — нужен для embeddings и LLM |
| **Telegram** | Bot Token | [@BotFather](https://t.me/BotFather) — создай нового бота |
| **Telegram** | Твой User ID | [@userinfobot](https://t.me/userinfobot) — чтобы бот работал только для тебя |
| **Groq** | API Key | [console.groq.com](https://console.groq.com) — для транскрипции голосовых |

Придумай свой **MCP_ACCESS_KEY** — любая строка, которая будет паролем к API (например: `my-secret-brain-key-2024`).

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

## Шаг 5. Склонируй и задеплой

```bash
git clone https://github.com/izomba-lang/Open-Brain.git
cd Open-Brain
```

### 5.1. Привяжи к своему проекту

```bash
supabase link --project-ref <твой-project-ref>
```

### 5.2. Установи секреты

```bash
supabase secrets set \
  OPENROUTER_API_KEY="sk-or-..." \
  MCP_ACCESS_KEY="my-secret-brain-key-2024" \
  TELEGRAM_BOT_TOKEN="123456:ABC-DEF..." \
  TELEGRAM_ALLOWED_USER_ID="123456789" \
  GROQ_API_KEY="gsk_..."
```

### 5.3. Задеплой функции

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy ingest-thought-telegram --no-verify-jwt
```

Slack-функция опциональна:
```bash
supabase functions deploy ingest-thought --no-verify-jwt
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

### Cursor / Claude Code

Добавь в настройки MCP-серверов:
- **URL**: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>`
- **Transport**: HTTP (JSON-RPC 2.0)

## Шаг 9. Chrome-расширение (опционально)

1. Открой `chrome://extensions/`
2. Включи **Developer mode**
3. Нажми **Load unpacked**
4. Выбери папку `chrome-extension/`
5. Открой новую вкладку — появится дэшборд
6. Введи в настройках:
   - **Endpoint**: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`
   - **API Key**: твой `MCP_ACCESS_KEY`

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

### MCP-сервер (через AI-клиента)

- **"Запомни: завтра встреча с Петей в 15:00"** → `capture_thought`
- **"Что я знаю про налоги?"** → `search_thoughts`
- **"Покажи открытые задачи"** → `list_thoughts` (type: task)
- **"Отметь задачу X как выполненную"** → `update_thought`
- **"Создай проект Ремонт квартиры"** → `manage_project`

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
