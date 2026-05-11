# Как подключить личный Gmail и Drive в Cowork

Краткий гайд: как поднять второй (личный) Google-аккаунт в Cowork параллельно с рабочим, через собственный MCP-сервер.

## Зачем это нужно

Cowork поддерживает только один инстанс нативного Google Workspace-коннектора. Если у тебя уже подключён рабочий `@company.com` через нативный коннектор и нужен ещё личный `@gmail.com` — нужен второй канал. Решение: поднять собственный MCP-сервер для личного аккаунта и зарегистрировать его как Custom Connector рядом с нативным.

Инструменты будут с префиксом `personal_` (`personal_gmail_search`, `personal_drive_list` и т.д.), чтобы LLM не путалась, куда обращаться. По запросу "что в личной почте" вызовется `personal_gmail_search`, по запросу "что в рабочей" — нативный `gmail_search`.

## Что получишь в итоге

- **12 инструментов** через Custom Connector в Cowork:
  - Gmail: `search`, `get_thread`, `list_labels`, `draft_create`, `draft_preview`, `send`, `modify_labels`
  - Drive: `list`, `search`, `read`, `create`, `update`
- **Защита от случайной отправки писем** — send требует confirmation token из предварительного `draft_create` или `draft_preview`. Модель не сможет отправить письмо без явного draft-шага.
- **Drive-скоупинг** — по умолчанию все операции в папке `Claude Workspace`. Чтобы вылезти за её пределы — нужен явный `scope="full_drive"`.
- **Аудит-лог** в Supabase: какой tool, когда, успех/ошибка, длительность, ID ресурса. Без содержимого писем и файлов.

## Что нужно иметь под рукой

- Аккаунт в Google Cloud Platform (бесплатный, free trial не обязателен)
- Supabase-проект (у меня тот же, что для Open Brain — `qtjbweggawytrzsmlwtx`)
- Установленный Supabase CLI (`brew install supabase/tap/supabase`)
- 30-40 минут

## Шаг 1. Google Cloud Console — настройка OAuth

### 1.1. Включить API

В Google Cloud Console (любой проект):
- ☰ → **APIs & Services** → **Library**
- Включить **Gmail API** и **Google Drive API**

### 1.2. Настроить OAuth consent screen

- **APIs & Services** → **OAuth consent screen**
- User Type: **External** → Create
- App name: что-то понятное, например `Personal Google MCP`
- User support email и Developer email — свой
- Scopes можно не добавлять (запросим в URL)
- Test users → добавить свой gmail
- Save

**Важно: сразу опубликовать app** (Publishing status → **Publish app**). В Testing-режиме refresh token живёт всего 7 дней. После публикации Google показывает warning "unverified", но токен становится бессрочным.

### 1.3. Создать OAuth Client ID

Здесь есть нюанс. **Не делай Desktop app** — Google задепрекейтил OOB redirect, и Desktop-клиенты теперь плохо работают через `urn:ietf:wg:oauth:2.0:oob`. Делай Web app:

- **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
- Application type: **Web application**
- Name: например `Personal Google MCP Web`
- **Authorized redirect URIs** → Add: `https://developers.google.com/oauthplayground`
- Create
- Скопировать **Client ID** и **Client Secret** — сейчас понадобятся

## Шаг 2. Получить refresh token через OAuth Playground

OAuth Playground — Google-hosted тулза, через которую можно один раз получить refresh token без локальных скриптов.

1. Открыть https://developers.google.com/oauthplayground/
2. ⚙ (шестерёнка, правый верх) → ✅ **Use your own OAuth credentials** → вставить Client ID и Client Secret → Close
3. В левой панели **Step 1**, в поле "Input your own scopes" вставить (через пробел):
   ```
   https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive
   ```
4. **Authorize APIs** → залогиниться личным gmail → разрешить доступ
5. После редиректа окажешься на **Step 2** → нажать **Exchange authorization code for tokens**
6. В правой панели появится JSON с `refresh_token` — сохранить значение

Почему `gmail.modify`, а не `gmail.full`: modify даёт read + draft + send + labels + archive, но НЕ даёт permanent delete. Это компромисс — нельзя случайно (или через prompt injection) удалить почту навсегда.

## Шаг 3. Создать папку Claude Workspace в Drive

В личном Google Drive создай папку (имя любое, например `Claude Workspace`). Открой её, скопируй ID из URL — это часть после `/folders/`:

```
https://drive.google.com/drive/folders/1T6C9ZMKf3pdFZzvyHp-Z_AbglrPuvkFk
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       это folder ID
```

Все Drive-операции по умолчанию будут scoped в эту папку.

## Шаг 4. Положить секреты в Supabase

```bash
supabase secrets set \
  PERSONAL_GOOGLE_CLIENT_ID="<client_id>" \
  PERSONAL_GOOGLE_CLIENT_SECRET="<client_secret>" \
  PERSONAL_GOOGLE_REFRESH_TOKEN="<refresh_token>" \
  PERSONAL_GOOGLE_WORKSPACE_FOLDER_ID="<folder_id>" \
  --project-ref <твой_project_ref>
```

## Шаг 5. Задеплоить Edge Function

Код сервера лежит в Open Brain репозитории: [supabase/functions/personal-google-mcp/](../../supabase/functions/personal-google-mcp/).

```bash
cd /path/to/open-brain
supabase functions deploy personal-google-mcp --no-verify-jwt --project-ref <твой_project_ref>
```

Auth через `MCP_ACCESS_KEY` — тот же, что у Open Brain, можно переиспользовать.

## Шаг 6. Прогнать SQL-миграцию для аудит-логов

В Supabase Dashboard → **Database** → **Extensions** → включить `pg_cron` (если ещё не включён).

Затем в SQL Editor выполнить миграцию из [supabase/migrations/20260511_personal_google_mcp_audit.sql](../../supabase/migrations/20260511_personal_google_mcp_audit.sql). Она создаст:
- Схему `personal_google_mcp`
- Таблицу `tool_calls` (метаданные вызовов, без контента)
- Индексы для быстрых запросов
- pg_cron-задачу очистки записей старше 90 дней

## Шаг 7. Экспонировать схему через PostgREST

Без этого аудит-инсерты будут падать с 404 (но это fire-and-forget — основные tool calls не сломаются).

Supabase Dashboard → **Settings** → **API** → **Data API** → **Settings** → **Exposed schemas** → добавить `personal_google_mcp` через запятую к существующим → Save.

## Шаг 8. Зарегистрировать в Cowork

В Cowork → Add Custom Connector → ввести URL:

```
https://<твой_project_ref>.supabase.co/functions/v1/personal-google-mcp?key=<твой_MCP_ACCESS_KEY>
```

После подключения видны все 12 personal_* инструментов.

## Проверка работы

В Cowork в одной сессии задать:

1. **"Что у меня нового в личной почте?"** → должен вызваться `personal_gmail_search`
2. **"Что у меня нового в рабочей почте?"** → должен вызваться нативный `gmail_search`
3. **"Создай файл test.txt в моей Claude Workspace папке с текстом hello"** → `personal_drive_create`

Аудит проверить SQL-запросом в Supabase:

```sql
select tool_name, status, duration_ms, ts
from personal_google_mcp.tool_calls
order by ts desc limit 10;
```

## Подводные камни, на которые я наткнулся

| Проблема | Симптом | Решение |
|----------|---------|---------|
| OOB redirect deprecated | `Error 400: invalid_request` при OAuth flow | Использовать Web app тип OAuth client + OAuth Playground |
| Testing mode → 7-дневный refresh token | Через неделю ничего не работает | Опубликовать app в OAuth consent screen |
| Drive API not enabled | `Error 403: SERVICE_DISABLED` при первом вызове Drive | Включить Drive API в Library |
| In-memory token state не выживает между Edge Function воркерами | `Invalid or expired confirmation_token` сразу после draft_create | Stateless HMAC-токены (уже зашиты в коде) |
| `cron schema not exist` при миграции | Миграция падает | Включить `pg_cron` extension в Database → Extensions |
| Аудит-логи не пишутся | Таблица пустая после tool calls | Добавить схему в Exposed schemas |

## Безопасность — что заложено

- **Send guard:** для отправки нужен confirmation_token, который выдаётся только из предварительного `draft_create` или `draft_preview`. Это блокирует prompt injection через содержимое писем — модель не сможет отправить что-то "по случайности".
- **Drive scoping:** все операции по умолчанию в `Claude Workspace`. Выйти за пределы — только явный `scope: "full_drive"`.
- **Гранулярный scope:** `gmail.modify` вместо `gmail.full` — нельзя permanent delete.
- **Аудит без контента:** в логи пишутся метаданные (тул, статус, длительность, ID ресурса), но НЕ тело писем, имена файлов или search queries.

## Файлы и ссылки

- Код сервера: [supabase/functions/personal-google-mcp/](../../supabase/functions/personal-google-mcp/)
- Миграция БД: [supabase/migrations/20260511_personal_google_mcp_audit.sql](../../supabase/migrations/20260511_personal_google_mcp_audit.sql)
- Bootstrap-скрипт (альтернатива OAuth Playground): [scripts/personal_google_auth.ts](../../scripts/personal_google_auth.ts)
- Gmail REST API docs: https://developers.google.com/gmail/api/reference/rest
- Drive REST API docs: https://developers.google.com/drive/api/reference/rest/v3
