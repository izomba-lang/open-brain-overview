# Open Brain — Quick Start

A personal AI memory system built on Supabase + pgvector. You send thoughts in via Telegram or an AI client, the system stores and links them, and answers questions against your own knowledge base.

## What you get

- **Telegram bot** — text or voice -> a thought with auto-categorization; `/today`, `/tasks` commands
- **MCP server** — 15+ tools for Claude Desktop, Cursor, Claude Code
- **Chrome extension** — new-tab page with your top 3 tasks
- **Skills system** — meeting-brief, follow-up, weekly-report, and 12 more ready-made recipes

## Architecture

```
Telegram / AI client
      |
Supabase Edge Functions (Deno)
      |
PostgreSQL + pgvector
      |
OpenRouter API (embeddings + LLM)
```

## Setup: 9 steps

Detailed guide: https://github.com/izomba-lang/open-brain-overview/blob/main/SETUP-GUIDE.md

Short version:

1. **Supabase** — create a project at supabase.com
2. **Database** — run the SQL: pgvector, the thoughts/people/projects/skills tables, the match_thoughts/match_skills functions
3. **API keys** — OpenRouter, Telegram Bot Token, Telegram User ID, Groq (for voice), and make up an MCP_ACCESS_KEY
4. **Supabase CLI** — `brew install supabase/tap/supabase && supabase login`
5. **Clone the repo** — `git clone https://github.com/izomba-lang/open-brain-overview.git`
6. **Deploy** — `supabase link`, `supabase secrets set ...`, `supabase functions deploy`
7. **Telegram webhook** — `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" ...`
8. **AI client** — connect the MCP server to Claude Desktop / Cursor / Claude Code
9. **Chrome extension** — load unpacked from `src/chrome-extension/`

## Cost

- Supabase Free tier (500MB database, 500K invocations/month)
- OpenRouter ~$0.001/embedding, ~$0.005/metadata extraction
- Groq Free tier
- Telegram is free

In practice, < $1/month at 50–100 thoughts/day.

## Skills (15)

**Communication:** text-quality-pipeline, draft-email, email_writer, follow-up

**Management:** meeting-brief, weekly-report, delegate-task, decision-log, product-manager, plan-ceo-review, executive-summary-generator, weekly-engineering-retrospective

**Development:** code-reviewer, office-hours, expense-report-aed

You can create your own via `manage_skill` or import from GitHub via `import_skill`.

## Brain-wiki (nightly compilation)

An optional layer on top of the thought database. Every night the Wiki Compiler:

1. Finds entities (countries, people, companies, topics) with new thoughts
2. Gathers all thoughts for an entity and sends them to Claude Sonnet 4
3. Claude generates a markdown page: TL;DR, open questions, key decisions, contradictions
4. The page is committed to a private `brain-wiki` GitHub repo

Open Obsidian in the morning (with the Obsidian Git plugin) to a fresh wiki with cross-links and a Graph View:
- `countries/germany.md` — everything about a specific market
- `people/ivanov.md` — interaction history with a contact
- `topics/tax-planning.md` — a topic summary
- `_contradictions.md` — where the data conflicts with itself

MCP tools for the wiki: `compile_wiki`, `manage_wiki_entity`, `manage_artifact`

Cost: ~$0.15 per page, ~$3 for a full run over 20 entities, ~$0.50/night incremental.

## MCP tools

search_thoughts, list_thoughts, thought_stats, capture_thought, update_thought, delete_thought, manage_person, list_people, manage_project, list_projects, route_task, list_skills, manage_skill, import_skill, get_style_profile, compile_wiki, manage_wiki_entity, manage_artifact

## Useful commands once set up

- Via Telegram: just send text (it's saved as a thought), start with `?` to ask a question
- Via an AI client: "What do I know about X?", "Prepare a brief for the meeting", "Draft a follow-up"
- Wiki: "Add Argentina to the wiki", "Attach the financial model to the Germany page"
