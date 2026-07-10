# How to connect a personal Gmail and Drive account in Cowork

A short guide on running a second (personal) Google account in Cowork alongside a work account, through your own MCP server.

## Why this is needed

Cowork only supports one instance of the native Google Workspace connector. If you already have a work `@company.com` account connected through the native connector and you also need a personal `@gmail.com` one, you need a second channel. The fix: stand up your own MCP server for the personal account and register it as a Custom Connector next to the native one.

The tools are prefixed with `personal_` (`personal_gmail_search`, `personal_drive_list`, etc.) so the LLM doesn't get confused about which one to call. A request like "what's new in my personal email" calls `personal_gmail_search`; "what's new in my work email" calls the native `gmail_search`.

## What you end up with

- **12 tools** through a Custom Connector in Cowork:
  - Gmail: `search`, `get_thread`, `list_labels`, `draft_create`, `draft_preview`, `send`, `modify_labels`
  - Drive: `list`, `search`, `read`, `create`, `update`
- **Protection against accidental sends** — `send` requires a confirmation token from a prior `draft_create` or `draft_preview` call. The model can't send an email without an explicit draft step.
- **Drive scoping** — by default all operations are confined to a `Claude Workspace` folder. Escaping it requires an explicit `scope="full_drive"`.
- **Audit log** in Supabase: which tool, when, success/failure, duration, resource ID. No email or file content.

## What you'll need on hand

- A Google Cloud Platform account (free, no paid trial required)
- A Supabase project (the same one you use for Open Brain — `<your_project_ref>`)
- The Supabase CLI installed (`brew install supabase/tap/supabase`)
- 30–40 minutes

## Step 1. Google Cloud Console — OAuth setup

### 1.1. Enable the APIs

In Google Cloud Console (any project):
- ☰ → **APIs & Services** → **Library**
- Enable **Gmail API** and **Google Drive API**

### 1.2. Configure the OAuth consent screen

- **APIs & Services** → **OAuth consent screen**
- User Type: **External** → Create
- App name: something recognizable, e.g. `Personal Google MCP`
- User support email and Developer email — your own
- Scopes can be left empty (we'll request them in the URL)
- Test users → add your own gmail
- Save

**Important: publish the app right away** (Publishing status → **Publish app**). In Testing mode the refresh token only lives 7 days. Once published, Google shows an "unverified" warning, but the token becomes permanent.

### 1.3. Create an OAuth Client ID

There's a catch here. **Don't create a Desktop app** — Google deprecated the OOB redirect, and Desktop clients now work poorly with `urn:ietf:wg:oauth:2.0:oob`. Create a Web app instead:

- **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
- Application type: **Web application**
- Name: e.g. `Personal Google MCP Web`
- **Authorized redirect URIs** → Add: `https://developers.google.com/oauthplayground`
- Create
- Copy the **Client ID** and **Client Secret** — you'll need them next

## Step 2. Get a refresh token via OAuth Playground

OAuth Playground is a Google-hosted tool that lets you get a refresh token once, without any local scripts.

1. Open https://developers.google.com/oauthplayground/
2. ⚙ (gear icon, top right) → check **Use your own OAuth credentials** → paste your Client ID and Client Secret → Close
3. In the left panel, **Step 1**, in the "Input your own scopes" field, paste (space-separated):
   ```
   https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive
   ```
4. **Authorize APIs** → log in with your personal gmail → grant access
5. After the redirect you'll land on **Step 2** → click **Exchange authorization code for tokens**
6. The right panel will show JSON containing `refresh_token` — save that value

Why `gmail.modify` and not `gmail.full`: modify grants read + draft + send + labels + archive, but NOT permanent delete. That's a deliberate tradeoff — nothing can permanently delete mail by accident (or via prompt injection).

## Step 3. Create a Claude Workspace folder in Drive

In your personal Google Drive, create a folder (any name, e.g. `Claude Workspace`). Open it and copy the ID from the URL — the part after `/folders/`:

```
https://drive.google.com/drive/folders/1T6C9ZMKf3pdFZzvyHp-Z_AbglrPuvkFk
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       this is the folder ID
```

All Drive operations will be scoped to this folder by default.

## Step 4. Store the secrets in Supabase

```bash
supabase secrets set \
  PERSONAL_GOOGLE_CLIENT_ID="<client_id>" \
  PERSONAL_GOOGLE_CLIENT_SECRET="<client_secret>" \
  PERSONAL_GOOGLE_REFRESH_TOKEN="<refresh_token>" \
  PERSONAL_GOOGLE_WORKSPACE_FOLDER_ID="<folder_id>" \
  --project-ref <your_project_ref>
```

## Step 5. Deploy the Edge Function

The server code lives in the Open Brain repository: [supabase/functions/personal-google-mcp/](../../supabase/functions/personal-google-mcp/).

```bash
cd /path/to/open-brain
supabase functions deploy personal-google-mcp --no-verify-jwt --project-ref <your_project_ref>
```

Auth is via `MCP_ACCESS_KEY`, the same one Open Brain uses — you can reuse it.

## Step 6. Run the audit-log SQL migration

In the Supabase Dashboard → **Database** → **Extensions**, enable `pg_cron` if it isn't already.

Then, in the SQL Editor, run the `supabase/migrations/20260511_personal_google_mcp_audit.sql` migration (shipped with the server code). It creates:
- A `personal_google_mcp` schema
- A `tool_calls` table (call metadata, no content)
- Indexes for fast queries
- A pg_cron job that prunes records older than 90 days

## Step 7. Expose the schema via PostgREST

Without this, audit inserts will fail with 404 (but it's fire-and-forget — actual tool calls won't break).

Supabase Dashboard → **Settings** → **API** → **Data API** → **Settings** → **Exposed schemas** → add `personal_google_mcp` to the comma-separated list → Save.

## Step 8. Register it in Cowork

In Cowork → Add Custom Connector → enter the URL:

```
https://<your_project_ref>.supabase.co/functions/v1/personal-google-mcp?key=<your_MCP_ACCESS_KEY>
```

Once connected, all 12 personal_* tools should be visible.

## Verifying it works

In a single Cowork session, ask:

1. **"What's new in my personal email?"** → should call `personal_gmail_search`
2. **"What's new in my work email?"** → should call the native `gmail_search`
3. **"Create a file test.txt in my Claude Workspace folder with the text hello"** → `personal_drive_create`

Check the audit log with a SQL query in Supabase:

```sql
select tool_name, status, duration_ms, ts
from personal_google_mcp.tool_calls
order by ts desc limit 10;
```

## Gotchas I ran into

| Problem | Symptom | Fix |
|----------|---------|---------|
| OOB redirect deprecated | `Error 400: invalid_request` during the OAuth flow | Use a Web app type OAuth client + OAuth Playground |
| Testing mode → 7-day refresh token | Everything stops working after a week | Publish the app in the OAuth consent screen |
| Drive API not enabled | `Error 403: SERVICE_DISABLED` on the first Drive call | Enable the Drive API in the Library |
| In-memory token state doesn't survive across Edge Function workers | `Invalid or expired confirmation_token` right after draft_create | Stateless HMAC tokens (already built into the code) |
| `cron schema not exist` during migration | The migration fails | Enable the `pg_cron` extension in Database → Extensions |
| Audit logs aren't written | The table is empty after tool calls | Add the schema to Exposed schemas |

## Security — what's built in

- **Send guard:** sending requires a confirmation_token, which is only issued by a prior `draft_create` or `draft_preview` call. This blocks prompt injection via email content — the model can't send anything "by accident."
- **Drive scoping:** all operations default to the `Claude Workspace` folder. Escaping it requires an explicit `scope: "full_drive"`.
- **Granular scope:** `gmail.modify` instead of `gmail.full` — no permanent delete.
- **Content-free audit:** logs record metadata (tool, status, duration, resource ID), but NOT email bodies, file names, or search queries.

## Where the code lives

The MCP server itself is a Supabase Edge Function on Deno. Structure:

```
supabase/
├── functions/
│   └── personal-google-mcp/
│       ├── index.ts          # MCP entry point: JSON-RPC 2.0, auth, dispatch
│       ├── auth.ts           # OAuth token refresh + in-memory cache
│       ├── gmail.ts          # Gmail REST API wrapper
│       ├── drive.ts          # Drive REST API wrapper
│       ├── confirmation.ts   # Stateless HMAC confirmation tokens
│       ├── audit.ts          # Fire-and-forget logging
│       └── tools/
│           ├── gmail_tools.ts
│           └── drive_tools.ts
├── migrations/
│   └── 20260511_personal_google_mcp_audit.sql
└── scripts/
    └── personal_google_auth.ts   # a CLI alternative to OAuth Playground
```

Architecture mirrors [Open Brain MCP](https://github.com/izomba-lang/open-brain-overview) — same Supabase project, same `MCP_ACCESS_KEY`, one deploy pipeline.

If you need the code for your own implementation, reach out directly.

## Links

- Gmail REST API docs: https://developers.google.com/gmail/api/reference/rest
- Drive REST API docs: https://developers.google.com/drive/api/reference/rest/v3
- MCP spec: https://spec.modelcontextprotocol.io
