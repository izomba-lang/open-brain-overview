# Open Brain — карта модулей

Что есть в полной системе поверх ядра из [SETUP-GUIDE.md](SETUP-GUIDE.md), в каком порядке это подключать и сколько стоит. Описание собрано по коду и докам боевого инстанса (около 30 Edge Functions плюс сервисы на VPS и Mac). Уроки эксплуатации вынесены в [LESSONS.md](LESSONS.md).

## Сначала главное: что опубликовано, а что нет

В этом репо лежит только часть кода. Остальные модули описаны здесь, чтобы было понятно, как устроена полная система и что строить самому.

| Модуль | Код в `src/` | Схема БД в `src/` или SETUP-GUIDE |
|---|---|---|
| `open-brain-mcp` (27 тулов) | ✅ | частично: `thoughts`, `people`, `projects`, `skills`, `match_thoughts`, `match_skills` |
| `ingest-thought-telegram` (бот) | ✅ (ранняя версия) | ✅ |
| `ingest-thought` (Slack) | ✅ | ✅ |
| `compile-wiki` | ✅ (без защиты от wall clock, см. ниже) | ❌ |
| `_shared/` (llm, ingest, people, topic_prompt, alert, text_match, voice/intent) | ✅ | — |
| Всё остальное в этом документе | ❌ только описание | ❌ |

Тулы MCP, которым нужны таблицы вне SETUP-GUIDE (`wiki_entities`, `entity_aliases`, `person_aliases`, `artifacts`, `raw_transcripts`, `health_metrics_daily`, `health_workouts`, `call_tasks`, `call_events`, RPC `hybrid_match_thoughts`, `search_transcripts`, `find_similar_person` и др.), без них вернут ошибку. `search_thoughts` при отсутствии `hybrid_match_thoughts` откатывается на `match_thoughts` и работает.

### Расхождения опубликованного кода с боевым

- **`_shared/llm.ts`: `TASK_MODEL = "qwen/qwen3-235b-a22b"`.** OpenRouter снял эту модель 09.10.2026, вызовы отвечают 404. В боевом инстансе стоит `qwen/qwen3.7-plus`. Замени до деплоя.
- **`compile-wiki`: `maxTokens = 8192`.** Генерация не укладывается в лимит Edge Function (~150 с), функцию убивают после того, как провайдер уже списал токены. В боевом инстансе `MAX_OUTPUT_TOKENS = 4096` и `MAX_THOUGHTS_PER_COMPILE = 35`. Подробно в [LESSONS.md](LESSONS.md#1-edge-functions-wall-clock--это-деньги).
- **Telegram-бот.** В боевом инстансе `ingest-thought-telegram` давно слит в `telegram-callback-webhook` (сообщения + кнопки + команды). Опубликована ранняя версия: захват текста и голоса, вопросы к базе, `/today`, `/tasks`.
- **MCP:** в боевом инстансе 29 тулов. Не опубликованы `manage_asr_correction` (правила исправления ослышек в именах) и `review_context`.

---

## Порядок подключения

```
1. Ядро            Supabase + pgvector, MCP, Telegram-бот          ← SETUP-GUIDE.md
2. Эксплуатация    job_runs, бэкап, reprocess, system-health       ← подключать сразу после ядра
3. Gmail/Calendar  capture-calendar-email, personal-google-mcp
4. Вики            compile-wiki + GitHub + Obsidian
5. Советник        daily-brief, deadline-watcher, data-hygiene
6. Встречи         Plaud-поллер на VPS → ingest-thought-plaud → диаризация, voiceprints
7. Звонки          Vapi: voice-trigger-call + voice-vapi-webhook
```

Каждый шаг опирается на предыдущие, но 3–7 между собой почти независимы: можно взять вики и пропустить встречи. Шаг 6 самый сложный и самый дорогой по времени настройки.

**Общие соглашения всех функций:**

- Авторизация: `?key=` или заголовок `x-brain-key`, сверяется с секретом `MCP_ACCESS_KEY`. Поэтому деплой всегда с `--no-verify-jwt`.
- Все функции используют `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` (ниже не повторяются).
- Расписания — `pg_cron` + `net.http_post` на URL функции. Не вписывай ключ в SQL миграции, храни его в Vault (см. [LESSONS.md](LESSONS.md#12-секреты-и-публичный-репо)).
- Времена кронов ниже в UTC.

### Модели (`_shared/llm.ts`)

| Константа | Модель в боевом инстансе | Для чего | Цена за 1M токенов (вход / выход) |
|---|---|---|---|
| `SYNTH_MODEL` | `claude-sonnet-4-6` (Anthropic напрямую) | страницы вики, утренний бриф, судья спикеров | $3 / $15 |
| `TASK_MODEL` | `qwen/qwen3.7-plus` (OpenRouter) | классификация, парсинг, извлечение задач, lint вики | $0.32 / $1.28 |
| `MINI_MODEL` | `openai/gpt-4o-mini` (OpenRouter) | метаданные мысли, саммари встреч | $0.15 / $0.60 |
| эмбеддинги | `openai/text-embedding-3-small`, 1536 измерений (OpenRouter) | поиск | — |

Цены взяты из `MODEL_PRICES` в коде боевого инстанса; сверяй с провайдером.

---

## 1. Ядро

Подробно в [SETUP-GUIDE.md](SETUP-GUIDE.md).

### `open-brain-mcp`
MCP-сервер (JSON-RPC 2.0 поверх HTTP). Опубликованная версия даёт 27 тулов:

| Группа | Тулы |
|---|---|
| Мысли | `search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`, `update_thought`, `delete_thought`, `get_transcript` |
| Люди | `manage_person`, `list_people`, `delete_person`, `merge_person`, `manage_alias` |
| Проекты | `manage_project`, `list_projects`, `delete_project` |
| Скиллы | `route_task`, `list_skills`, `manage_skill`, `import_skill` |
| Вики | `compile_wiki`, `manage_wiki_entity`, `manage_artifact` |
| Здоровье | `get_health_summary`, `get_health_trend`, `correlate_health_thoughts` |
| Прочее | `get_style_profile`, `voice_call` |

- Секреты: `MCP_ACCESS_KEY`, `OPENROUTER_API_KEY`; опционально `USER_DEFAULT_CONTEXT`.
- Вызывает `compile-wiki` (тул `compile_wiki`) и `voice-trigger-call` (тул `voice_call`).
- Тулы здоровья читают `health_metrics_daily` / `health_workouts`. Как эти таблицы наполняются, в коде боевого инстанса не описано; без них тулы бесполезны.

### Telegram-бот
Опубликован как `ingest-thought-telegram`: текст или голос → мысль. Голос распознаётся через Groq `whisper-large-v3-turbo`. Вопрос с `?` → поиск по `match_thoughts` + ответ `gpt-4o-mini`.

- Секреты: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`.

В боевом инстансе бот вырос в `telegram-callback-webhook` (~2400 строк): команды `/start`, `/today`, `/tasks`, `/waiting`, `/hygiene`, `/review`, `/help`, `/call`; обработка кнопок всех модулей ниже; файлы складываются в папку Google Drive; вебхук проверяется секретом `TELEGRAM_WEBHOOK_SECRET`; есть защищённые роуты `?action=webhook-status` и `?action=webhook-repair`.

### `ingest-thought` (Slack, опционально)
Слушает один канал Slack (`SLACK_CAPTURE_CHANNEL`), отвечает на `url_verification`, фильтрует сообщения ботов и сохраняет мысль.

### Стоимость ядра
По SETUP-GUIDE: Supabase Free (500 МБ, 500K вызовов в месяц), ~$0.001 за эмбеддинг и ~$0.005 за извлечение метаданных, Groq бесплатно. Меньше $1 в месяц при 50–100 мыслях в день.

---

## 2. Эксплуатация (подключать сразу после ядра)

Не опубликовано. Это скучные модули, но именно они сообщают, что что-то сломалось.

| Функция | Что делает | Запуск | Таблицы |
|---|---|---|---|
| `_shared/alert.ts` | строки начала/конца в `job_runs` и Telegram-алерты при сбое | из каждой функции | `job_runs` |
| `reprocess-pending` | добирает эмбеддинги и метаданные для мыслей, сохранённых с `needs_reprocess=true`, пока OpenRouter лежал | cron `7,37 * * * *` | `thoughts` |
| `backup-db` | ночной JSON-дамп ключевых таблиц в приватный Storage-бакет, ротация 30 дней; эмбеддинги мыслей не сохраняет (их можно пересчитать), voiceprints сохраняет | cron `0 4 * * *` | `thoughts`, `people`, `projects`, `skills`, вики-таблицы, `voiceprints`, `speaker_embeddings` |
| `system-health` | ежедневный heartbeat в Telegram: свежесть каждой задачи в `job_runs`, свежесть источников, «деградировавшие» мысли, прямой пинг всех трёх моделей | cron `30 6 * * *` | `thoughts`, `job_runs` |
| `vps-heartbeat` | принимает пинги живости от сервисов на VPS (allowlist имён) и пишет в `job_runs` | HTTP от cron на VPS | `job_runs` |

---

## 3. Gmail и Calendar

### `capture-calendar-email`
Раз в день читает события календаря на сегодня и завтра и письма, ждущие ответа, с двух Google-аккаунтов (рабочего и личного). LLM (`TASK_MODEL`) отфильтровывает шум, каждое событие или письмо пишется отдельной мыслью через `capture_thought`. Дедупликация по маркеру `[ref:…]`.

- Запуск: cron `15 4 * * *`.
- Секреты: `GCAP_WORK_REFRESH_TOKEN`, `GCAP_PERSONAL_REFRESH_TOKEN`, `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `MCP_ACCESS_KEY`.
- API: Gmail, Calendar, OpenRouter.
- Правила фильтрации лежат отдельным промптом; в боевом инстансе они написаны под конкретного владельца, их придётся переписать под себя.

### `personal-google-mcp`
Отдельный MCP-сервер для второго (личного) Google-аккаунта, когда первый уже подключён нативным коннектором. 12 тулов с префиксом `personal_` (Gmail: поиск, тред, метки, черновик, превью, отправка, смена меток; Drive: список, поиск, чтение, создание, обновление). Отправка требует HMAC-токен подтверждения из превью (TTL 10 минут). Пишет аудит-лог без содержимого писем.

Пошаговая установка: [PERSONAL-GOOGLE-MCP-SETUP.md](PERSONAL-GOOGLE-MCP-SETUP.md).

### `organize-inbox` (Drive)
Обходчик папки `00_Inbox` в Google Drive: LLM классифицирует файлы (включая OCR страниц сканов), раскладывает их по нумерованным папкам и важное сохраняет мыслью типа `document`. Режимы `diag`, `dry` (по умолчанию), `apply`, `requeue`.

- Запуск: ежедневный cron.
- Секреты: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, `GDRIVE_INBOX_FOLDER_ID`, `OPENROUTER_API_KEY`.

---

## 4. Вики: compile-wiki + GitHub + Obsidian

### `compile-wiki`
Собирает мысли по каждой сущности (`person`, `country`, `company`, `topic`), генерирует markdown-страницу через `SYNTH_MODEL` (TL;DR, открытые вопросы, ключевые решения, противоречия, артефакты) и коммитит её в приватный GitHub-репо. Читается в Obsidian с плагином Obsidian Git (auto-pull).

- Режимы: инкрементальный (только сущности с новыми мыслями), `pick_one` (одна сущность за вызов), `force`, полный, `chronology`, `lint`.
- Запуск в боевом инстансе: cron `*/10 22-23,0 * * *` с `{"pick_one": true}`, то есть по одной сущности каждые 10 минут ночью. Так каждый вызов гарантированно укладывается в лимит Edge Function. Плюс тул `compile_wiki` и ручной POST.
- Секреты: `ANTHROPIC_API_KEY` (в боевом инстансе отдельный `ANTHROPIC_API_KEY_WIKI`), `GITHUB_TOKEN`, `GITHUB_REPO`, `MCP_ACCESS_KEY`.
- Таблицы: `wiki_entities` (реестр страниц), `entity_aliases` (алиасы для не-людей), `person_aliases`, `wiki_compile_runs` (аудит прогонов), `artifacts` (ссылки на документы, привязанные к сущности). Миграций для них в этом репо нет.
- Привязка мыслей: люди — через `person_aliases`, остальное — через `entity_aliases` + поиск по содержимому с границами слов (`_shared/text_match.ts`).

Стоимость (из доков боевого инстанса): ~$0.15 за страницу, ~$3 за полный прогон по 20 сущностям; дельта-компиляция ~$0.03 за сущность против ~$0.30 полной; lint ~$0.15 за прогон.

### `render-meetings` (требует шага 6)
Проецирует встречи из БД в заметки Obsidian (`Meetings/…` и `_chronology.md`) в тот же GitHub-репо. LLM (`TASK_MODEL`) выделяет ключевые пункты, решения, задачи и открытые вопросы. Идемпотентна: повторный рендер сверяется по отпечатку. ~$0.005 за встречу (реальный замер — $0.0027).

### `admin-wiki-status`
Read-only диагностика: размер и свежесть каждой страницы плюс фактическая стоимость компиляции из `wiki_compile_runs`.

---

## 5. Проактивный советник

| Функция | Что делает | Запуск | Модели |
|---|---|---|---|
| `daily-brief` | утренний бриф: фокус дня, просрочки, до трёх предложений с кнопками «сделать / пропустить / позже»; реакции копятся в `advisor_suggestions` и влияют на следующие брифы | cron `0 6 * * *` (`?notify=1`), команда `/today` | `SYNTH_MODEL`, `TASK_MODEL` |
| `deadline-watcher` | дайджест задач со сроком в ближайшие 48 часов; по понедельникам — блок просроченных больше чем на 7 дней с кнопкой массового закрытия | cron `5 6 * * *` | — |
| `data-hygiene` | еженедельная уборка: ротация служебных таблиц (TTL 30 дней), очередь на ревью (неоднозначные карточки людей, просроченные задачи, застывшие проекты), дайджест с одной кнопкой; может вызывать `merge_person` | cron `0 8 * * 0`, команда `/review` | — |

Общий троттлинг проактивных сообщений — `_shared/proactive.ts` через таблицу `proactive_sends`: лучше промолчать, чем заспамить.

---

## 6. Встречи: Plaud + диаризация + voiceprints

Самый сложный модуль. Перед тем как браться, прочитай разделы 8–10 в [LESSONS.md](LESSONS.md).

```
Plaud Desktop / Note Pro ──> облако Plaud
                                │  (каждые ~10 мин)
                                ▼
                 VPS: plaud-poller (Python) ── STT (Soniox / AssemblyAI / Plaud)
                   │  + локальные голосовые эмбеддинги (sherpa-onnx, CAM++)
                   │  + сравнение с voiceprints (RPC get_active_voiceprints)
                   │  + twotrack: микрофон / системный звук от ShadowRecorder
                   ▼  HMAC-подписанный webhook
          ingest-thought-plaud ──> thought (type=event), raw_transcripts,
                   │               задачи владельца, Telegram-отбивка
                   ├──> speaker-review (карточка «кто это?» в Telegram)
                   └──> render-meetings (заметка в Obsidian)
```

### `vps/plaud-poller` (VPS)
- Python 3.12, только стандартная библиотека для HTTP (`urllib`). Запускается systemd-таймером примерно раз в 10 минут. Docker не нужен.
- VPS в боевом инстансе: 1 vCPU, 2 ГБ RAM. torch и pyannote сознательно отвергнуты как слишком тяжёлые для такой машины.
- Шаги: список записей Plaud (короче 10 с пропускаются) → скачивание аудио → STT → применение правил исправления имён → эмбеддинги голоса по прогонам речи → сопоставление с банком отпечатков → POST в `ingest-thought-plaud`.
- STT (`STT_PROVIDER`): `soniox` (`stt-async-v4`, подсказки языков `ru`/`en`, диаризация, контекст из имён людей), `assemblyai` или `plaud` (встроенный AI Plaud, бесплатно 300 минут в месяц).
- Голос: sherpa-onnx + `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` (~27 МБ, CPU). Порог совпадения в боевом `.env` — 0.65 (дефолт в коде 0.68), отпечатки только с текстовым происхождением требуют ≥0.78 и отрыва ≥0.10.
- Конфиг (`.env`): `PLAUD_TOKEN`, `PLAUD_API_BASE`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `STT_PROVIDER`, `SONIOX_API_KEY` / `ASSEMBLYAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`. На VPS только anon-ключ: отпечатки читаются через `SECURITY DEFINER` RPC.
- Инструменты рядом: `rediarize.py` (переразметка одной встречи по прогонам), `harness.py` (прогон боевых функций по эталонному корпусу встреч), калибровочные скрипты.
- Стоимость: локальные эмбеддинги — $0 в месяц. Альтернатива — платный тариф Plaud: 1200 минут в месяц Pro не хватало на ~1150+ минут реальных встреч.

### `mac/shadow-recorder` (Mac, опционально)
Swift-агент в строке меню, запускается launchd, нужен macOS 14.2+ (Core Audio process tap). Когда Plaud Desktop начинает запись, ShadowRecorder параллельно пишет микрофон и системный звук отдельными файлами и отправляет их по `scp` на VPS. Поллер (`twotrack.py`) по уровням дорожек решает «владелец или собеседник» без эмбеддингов: 92,7% согласия с диаризатором. Зачем это нужно — в [LESSONS.md](LESSONS.md#платформенный-трюк-две-дорожки-вместо-компенсаторов).

### `ingest-thought-plaud`
Принимает транскрипт от поллера (подпись `X-Applaud-Signature: sha256=…` по `PLAUD_WEBHOOK_SECRET`). Ставит имена спикерам (голос, затем календарный fast-path для встреч один на один; текст — только кандидат для ручной проверки), сохраняет эмбеддинги неназванных спикеров, извлекает обязательства владельца как задачи, отправляет Telegram-отбивку по встрече, публикует страницу.

- Секреты: `OPENROUTER_API_KEY`, `PLAUD_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GITHUB_REPO`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, Google-токены календаря, `ANTHROPIC_API_KEY_DIARIZATION`.
- Таблицы: `thoughts`, `raw_transcripts`, `speaker_embeddings`, `voiceprints`.

### Модули разметки спикеров

| Функция | Что делает | Запуск |
|---|---|---|
| `speaker-review` | карточка в Telegram «кто это?» для неназванных спикеров; ответ сразу пополняет банк отпечатков | вызывается из `ingest-thought-plaud` |
| `speaker-audit` | еженедельная перепроверка уже названных встреч, находки — кнопками в Telegram | cron `5 9 * * 0` |
| `daily-speaker-digest` | вечерняя таблица: как прошла диаризация каждой сегодняшней встречи | cron `0 19 * * *` |
| `admin-speaker-fix` | ручное переименование спикера; отказывает, если акустика противоречит (`force: true` только после прослушивания) | вручную |
| `admin-refresh-summaries` | чинит саммари, где остались «Speaker X»; `dry_run` по умолчанию | вручную |
| `admin-token-spans` | сохраняет поток токенов Soniox в `raw_transcripts` (Soniox удаляет транскрипции через 30 дней) | вручную / из поллера |
| `asr-name-audit` | фонетический аудит ослышек в именах: уверенные правила применяются ко всему архиву, спорные идут в очередь (тул `manage_asr_correction`) | еженедельный cron |
| `check-speaker-banking` | одноразовая проверка, что поллер начал копить эмбеддинги; удаляет собственный cron после первого сообщения | cron до срабатывания |

Стоимость модуля в целом из доков не собрана. Известные точки: STT Soniox или AssemblyAI (по их прайсу), судья спикеров на Sonnet (64 вызова `validateSpeakerNames` оценивались в ~$1.3), саммари на `gpt-4o-mini`.

---

## 7. Голосовые звонки (Vapi)

```
/call в Telegram  или  тул voice_call
        ▼
_shared/voice/intent.ts  (LLM разбирает: кому, зачем, на каком языке)
        ▼
call_tasks  ──(кнопка «Звонить»)──>  voice-trigger-call  ──>  Vapi  ──>  телефон
                                                                  │
               voice-vapi-webhook  <──  function-calls, end-of-call report
                       ▼
          call_events / call_messages, отчёт в Telegram, мысль в Open Brain
```

- `voice-trigger-call`: исходящий звонок через `api.vapi.ai`; голос, язык распознавания и приветствие задаются по языку (RU, EN, HE). Секреты: `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `USER_NAME`, `USER_DEFAULT_CONTEXT`.
- `voice-vapi-webhook`: принимает события Vapi (проверка `VAPI_WEBHOOK_SECRET`), логирует, уведомляет в Telegram, сохраняет итог мыслью через `capture_thought`.
- Ассистент и его тулы регистрируются в Vapi одноразовым скриптом; в боевом инстансе голос — ElevenLabs.
- Стоимость в доках не зафиксирована: смотри прайс Vapi, телефонного номера и голосового провайдера.

---

## Прочее

- **`pyrus-mcp`** — пример read-only MCP-коннектора к внешней системе тикетов (6 тулов, токен кэшируется на 20 минут). Полезен как шаблон «свой MCP для рабочей системы за 150 строк».
- **Ночной индекс** — launchd-задача на Mac (03:00) пересобирает мысль-карту «что где лежит» для AI-клиентов.
- **Leak-guard** — pre-commit хук, который сканирует staged-диф на секреты и денайлист личных слов. Поставь до первого коммита, если твой репо может стать публичным.
