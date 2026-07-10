# Open Brain — Setup Guide

A guide to setting up your own Open Brain system from scratch. Open Brain is a personal AI memory: you drop thoughts, tasks, and notes in via Telegram or Slack, and the system stores them, links them together, and answers questions against your own knowledge base.

---

## What you get

- **Telegram bot** — send text or voice, the bot saves it as a "thought" with automatic categorization
- **Commands**: `/today` (daily plan), `/tasks` (task list), questions against the knowledge base
- **MCP server** — connects to Claude Desktop, ChatGPT, Cursor, and any AI client
- **Semantic search** — searches by meaning, not by keyword
- **Skills system** — ready-made "recipes" for tasks: meeting-brief, follow-up, weekly-report, and more. You can create your own and import from GitHub

## Architecture

```
Telegram / Slack / AI client
        ↓
  Supabase Edge Functions (Deno)
        ↓
  PostgreSQL + pgvector
        ↓
  OpenRouter API (embeddings + LLM)
```

---

## Step 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com)
2. Create a new project and note down:
   - **Project ref** (in the URL: `https://supabase.com/dashboard/project/<project-ref>`)
   - **Region** (pick the one closest to you)
3. Wait for the project to initialize (~2 minutes)

## Step 2. Set up the database

Open the **SQL Editor** in the Supabase Dashboard and run these one at a time:

### 2.1. Enable pgvector

```sql
create extension if not exists vector with schema extensions;
```

### 2.2. Create the thoughts table

```sql
create table public.thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for fast vector search
create index thoughts_embedding_idx on public.thoughts
  using hnsw (embedding vector_cosine_ops);

-- Index for JSON queries against metadata
create index thoughts_metadata_idx on public.thoughts
  using gin (metadata);

-- Auto-update updated_at
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

### 2.3. Create the people table

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

### 2.4. Create the projects table

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

### 2.5. Create the skills table

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

-- Index for semantic skill search
create index if not exists skills_embedding_idx on skills
  using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists skills_category_idx on skills (category);
```

### 2.6. Create the semantic search function

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

### 2.7. Create the skill search function

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

### 2.8. Turn on RLS (for Edge Functions using the service role)

```sql
alter table public.thoughts enable row level security;
alter table public.people enable row level security;
alter table public.projects enable row level security;
alter table public.skills enable row level security;

-- Edge Functions use the service_role key, which bypasses RLS
-- If you want extra protection, add explicit policies
```

## Step 3. Get your API keys

You'll need:

| Service | What to get | Where |
|--------|-------------|-----|
| **OpenRouter** | API Key | [openrouter.ai/keys](https://openrouter.ai/keys) — needed for embeddings and the LLM |
| **Telegram** | Bot Token | [@BotFather](https://t.me/BotFather) — create a new bot |
| **Telegram** | Your User ID | [@userinfobot](https://t.me/userinfobot) — so the bot only works for you |
| **Groq** | API Key | [console.groq.com](https://console.groq.com) — for voice transcription |

Make up your own **MCP_ACCESS_KEY** — any long random string that acts as the password to the API (e.g. generate one with `openssl rand -hex 24`).

## Step 4. Install the Supabase CLI

```bash
# macOS
brew install supabase/tap/supabase

# or npm
npm install -g supabase
```

Log in:

```bash
supabase login
```

## Step 5. Create the project and deploy

### 5.1. Get the project structure

All the source code lives in the [`src/`](src/) folder of this repository. Copy it to your machine:

```bash
# Option 1: clone this repository
git clone https://github.com/izomba-lang/open-brain-overview.git
cd open-brain-overview/src

# Option 2: download just the src/ folder from GitHub
```

Structure:
```
src/
├── supabase/functions/
│   ├── open-brain-mcp/index.ts        ← MCP server (15 tools)
│   ├── ingest-thought-telegram/index.ts ← Telegram bot
│   └── ingest-thought/index.ts         ← Slack pipeline (optional)
├── supabase/migrations/                ← SQL migration for skills
└── deploy.sh                           ← Versioned deploy script
```

### 5.2. Initialize the Supabase project

```bash
cd src
supabase init
supabase link --project-ref <your-project-ref>
```

### 5.3. Set the secrets

```bash
supabase secrets set \
  OPENROUTER_API_KEY="sk-or-..." \
  MCP_ACCESS_KEY="<your_generated_key>" \
  TELEGRAM_BOT_TOKEN="123456:ABC-DEF..." \
  TELEGRAM_ALLOWED_USER_ID="123456789" \
  GROQ_API_KEY="gsk_..."
```

### 5.4. Deploy the functions

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy ingest-thought-telegram --no-verify-jwt
```

The Slack function is optional:
```bash
supabase functions deploy ingest-thought --no-verify-jwt
```

Or use the deploy script:
```bash
bash deploy.sh  # deploys all functions + versioning
```

## Step 6. Connect the Telegram bot

Set the webhook — replace `<project-ref>` with your own:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<project-ref>.supabase.co/functions/v1/ingest-thought-telegram"}'
```

Verify:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Now message the bot on Telegram — it should reply!

## Step 7. Check the MCP server

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"thought_stats","arguments":{}}}'
```

Should return JSON with empty stats.

## Step 8. Connect your AI clients

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

> Or use any MCP client that supports HTTP transport.

### Cursor

Create a `.cursor/mcp.json` file at the root of your project:

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

Add to your MCP server settings:
- **URL**: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>`
- **Transport**: HTTP (JSON-RPC 2.0)

---

## How to use it

### Telegram bot

| Action | What to do |
|----------|-----------|
| Save a thought | Just send text |
| Voice note | Send a voice message |
| Forward something | Forward a message — it's saved with a marker |
| Ask a question | Start with `?` or ask a question ("What did we decide about...?") |
| Daily plan | `/today` |
| Task list | `/tasks` |

### MCP server (15 tools, via an AI client)

- **"Remember: meeting with Peter tomorrow at 3pm"** → `capture_thought`
- **"What do I know about taxes?"** → `search_thoughts`
- **"Show my open tasks"** → `list_thoughts` (type: task)
- **"Mark task X as done"** → `update_thought`
- **"Create a project called Apartment Renovation"** → `manage_project`
- **"Prepare a brief for the meeting"** → `route_task` → picks the `meeting-brief` skill
- **"What skills are available?"** → `list_skills`
- **"Import a skill from GitHub"** → `import_skill` (URL or text)

---

## Skills — ready-made recipes for tasks

A skill is a set of instructions for the AI describing the steps for a specific task. When you say "prepare a brief for the meeting," `route_task` finds the right skill and hands the AI a ready-made prompt.

### Built-in skills

| Skill | What it does |
|-------|-----------|
| `meeting-brief` | Pulls together notes, participants, and tasks into a pre-meeting brief |
| `follow-up` | Drafts a follow-up email after a meeting in your writing style |
| `weekly-report` | Generates a weekly report from the week's notes |
| `delegate-task` | Writes a clear task description for delegation |
| `decision-log` | Records a decision with context, alternatives, and rationale |
| `draft-email` | Writes an email in your style, based on context from the database |

### Importing skills

You can import skills from GitHub — the system adapts them automatically:

```
# Via an AI client (Claude Desktop, Cursor, etc.):
"Import the skill from https://github.com/user/repo/blob/main/SKILL.md"
```

Or directly via MCP — `import_skill` accepts a URL or a text description of the skill.

### Creating your own skills

Via an AI client:
```
"Create a standup-summary skill: gathers tasks from the last 24 hours,
groups them by project, produces a short standup report"
```

Or via `manage_skill` with a description, trigger_patterns, and a prompt.

---

## Cost

| Service | Cost |
|--------|----------|
| Supabase | Free tier: 500MB database, 500K Edge Function invocations/month |
| OpenRouter | ~$0.001 per embedding, ~$0.005 per metadata extraction |
| Groq | Free tier: plenty for voice |
| Telegram | Free |

In practice, with active use (50–100 thoughts/day) — **under $1/month** on OpenRouter.

---

## Troubleshooting

### The bot isn't responding
```bash
# Check the logs
supabase functions logs ingest-thought-telegram --project-ref <ref>

# Check the webhook
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### MCP returns 401
Check that `MCP_ACCESS_KEY` matches what you're passing in `?key=`.

### Search finds nothing
Make sure the pgvector extension is enabled and the `match_thoughts` function was created. Try lowering the threshold to 0.3.

---

## Customization

- **Language** — the bot defaults to Russian. To switch to English, change the strings in `ingest-thought-telegram/index.ts`
- **Writing style** — save a thought with `source: "style_analysis"` via `capture_thought`, and the AI will use your style when generating text
- **Slack integration** — deploy `ingest-thought`, create a Slack App with Event Subscriptions, and point it at the function's URL

---

*Built with Supabase, pgvector, OpenRouter, and Deno.*
