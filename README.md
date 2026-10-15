# Open Brain

A personal AI memory system with an automatically-compiled wiki. You drop thoughts in via Telegram, calls, email, and chat — the system stores them, links them together, and compiles them every night into a structured wiki you read in Obsidian.

## How it works

```
                    INPUT (automatic)                                OUTPUT
   ┌──────────────────────────────────────┐
   │  Telegram bot    (text, voice)       │
   │  Calls/meetings  (Plaud recorder)    │       ┌─────────────────────────┐
   │  Gmail           (emails, threads)   │──────>│     Open Brain DB       │
   │  Slack           (messages)          │       │  PostgreSQL + pgvector  │
   │  AI client       (Claude, ChatGPT)   │       │  ~1500 thoughts/month   │
   │  Calendar        (meetings, events)  │       └───────────┬─────────────┘
   └──────────────────────────────────────┘                   │
                                                              │
                                          ┌───────────────────┼───────────────────┐
                                          │                   │                   │
                                          ▼                   ▼                   ▼
                                    MCP server           Wiki Compiler        Telegram bot
                                   (27 tools)           (nightly build)      (/today, /tasks)
                                          │                   │                   │
                                          ▼                   ▼                   ▼
                                   Claude Desktop        Obsidian              Mobile
                                   Cursor, Claude Code   (brain-wiki)        notifications
```

## System layers

### 1. Capture (autopilot)
You work as usual. Thoughts land in the database automatically:
- **Telegram bot** — send text or voice, it's saved as a thought with auto-categorization
- **Plaud recorder** — record a call or an in-person meeting, the transcript lands in the database overnight, with speakers identified by voice
- **Gmail** — emails waiting for your reply are pulled in every morning, one thought per email
- **Calendar** — today's and tomorrow's meetings sync automatically (one thought per event)
- **AI client** — tell Claude "remember that..." — `capture_thought` saves it

Meeting capture runs through a separate poller that talks to the Plaud API; it is not part of the code published here. [MODULES.md](MODULES.md) describes how it works.

### 2. Synthesis (the nightly robot)
Every night the Wiki Compiler:
1. Checks which entities (countries, people, companies, topics) have new thoughts
2. Gathers all thoughts for an entity and sends them to Claude Sonnet
3. Claude generates a markdown page: TL;DR, open questions, key decisions, contradictions
4. The page is committed to the `brain-wiki` GitHub repo
5. Cost: ~$0.15 per page, ~$3 for a full run over 20 entities

### 3. Reading (Obsidian)
Open Obsidian in the morning to a fresh wiki with cross-links and a Graph View:
- `countries/germany.md` — everything you know about a specific market
- `people/ivanov.md` — interaction history with a contact
- `topics/tax-planning.md` — a topic summary
- `_contradictions.md` — where the data conflicts with itself
- An **Artifacts** section — clickable links to documents, spreadsheets, presentations

### 4. Proactive advisor
The memory doesn't just answer queries — it also surfaces the next step on its own:
- **Morning brief** — a short daily summary: today's focus, up to 3 suggestions, overdue warnings. Each suggestion has "do it / skip / later" buttons — reactions accumulate and feed the next brief, so the advisor learns over time (feedback loop)
- **Deadlines** — a single digest of tasks due in the next 48 hours; on Mondays, an overdue-items block with a "clear in bulk" button
- **Commitments from meetings** — after a call, the system pulls your commitments out of the transcript and turns them into tasks
- **Precision over recall** — better to stay silent than offer a weak suggestion; a hard cap keeps it from turning into spam

## MCP server (27 tools)

Connects to any AI client (Claude Desktop, Cursor, Claude Code, ChatGPT). The code in `src/` ships 27 tools; the author's production instance has 29 (plus `manage_asr_correction` and `review_context`, not published yet):

| Category | Tools |
|---|---|
| Search & read | `search_thoughts`, `list_thoughts`, `thought_stats`, `get_transcript` |
| Write | `capture_thought`, `update_thought`, `delete_thought` |
| People | `manage_person`, `list_people`, `delete_person`, `merge_person`, `manage_alias` |
| Projects | `manage_project`, `list_projects`, `delete_project` |
| Skills | `route_task`, `list_skills`, `manage_skill`, `import_skill` |
| Wiki | `compile_wiki`, `manage_wiki_entity`, `manage_artifact` |
| Health | `get_health_summary`, `get_health_trend`, `correlate_health_thoughts` |
| Other | `get_style_profile`, `voice_call` |

## Skills (15)

Ready-made "recipes" for common tasks. Claude finds the right one automatically via `route_task`. All 15 are exported to [`skills/library/`](skills/library/) with import instructions:

- **Communication:** draft-email, email-writer, follow-up, text-quality-pipeline, ru-deck-editor
- **Management:** meeting-brief, weekly-report, delegate-task, decision-log, weekly-engineering-retrospective
- **Product:** product-manager, plan-ceo-review, executive-summary-generator
- **Development:** code-reviewer, office-hours

You can create your own (`manage_skill`) or import them from GitHub (`import_skill`).

## Stack

| Component | Technology |
|---|---|
| Runtime | Deno (Supabase Edge Functions) |
| Database | PostgreSQL + pgvector (1536-dim embeddings) |
| Embeddings | `text-embedding-3-small` via OpenRouter |
| Wiki Compiler | Claude Sonnet 4.6 (Anthropic API) |
| Wiki storage | GitHub (private repo) |
| Wiki reader | Obsidian + Obsidian Git plugin |
| Protocol | MCP (JSON-RPC 2.0 over HTTP) |
| Voice | Groq Whisper (STT) |
| Calls | Vapi (voice agent) |

## Cost

| Component | Cost |
|---|---|
| Supabase | Free tier (500MB, 500K invocations/month) |
| OpenRouter (embeddings) | ~$0.001/thought |
| Wiki Compiler (Anthropic) | ~$3/full run, ~$0.50/night incremental |
| Groq (voice) | Free tier |
| Telegram | Free |
| **Total** | **~$15–20/month with active use** |

## Quick start

Detailed guide: **[SETUP-GUIDE.md](SETUP-GUIDE.md)**

Short version:
1. Create a Supabase project
2. Run the SQL migrations (pgvector, tables, functions)
3. Get API keys (OpenRouter, Telegram, Anthropic)
4. Deploy the Edge Functions via the Supabase CLI
5. Set up the Telegram webhook
6. Connect the MCP server to your AI client
7. (Optional) Set up brain-wiki + Obsidian

## Repo structure

```
open-brain-overview/
├── README.md                      ← this file
├── SETUP-GUIDE.md                 ← step-by-step setup guide
├── ONBOARDING.md                  ← short Quick Start
├── MODULES.md                     ← map of every module beyond the core, in setup order
├── LESSONS.md                     ← operational lessons and incidents
├── PERSONAL-GOOGLE-MCP-SETUP.md   ← setting up a personal Google MCP (Gmail, Calendar, Drive)
├── src/
│   ├── supabase/                  ← SQL migrations and Edge Functions
│   └── deploy.sh                  ← deploy script
└── skills/                        ← companion skill + skill library to import
```

## Usage examples

**Via Telegram:**
- Send text — it's saved as a thought
- `?what did I decide about project X` — search the database
- `/today` — today's plan from tasks and meetings
- `/call call and book a table for 4` — voice agent

**Via an AI client (Claude Desktop / Cursor):**
- "Prepare a brief for the partner meeting" — `route_task` finds the `meeting-brief` skill
- "What do I know about tax planning?" — `search_thoughts` over the database
- "Add Argentina to the wiki" — `manage_wiki_entity` + `compile_wiki`
- "Attach the financial model to the project" — `manage_artifact`

## License

MIT. Fork it, adapt it.
