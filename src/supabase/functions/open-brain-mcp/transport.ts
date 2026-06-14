// MCP protocol layer: tool catalog (TOOLS), JSON-RPC dispatch (handleMcpRequest),
// SSE encoding and CORS headers. The thin index.ts wires HTTP routing to these.

import {
  handleGetTranscript,
  handleSearchThoughts,
  handleListThoughts,
  handleThoughtStats,
  handleCaptureThought,
  handleUpdateThought,
  handleDeleteThought,
  handleGetStyleProfile,
} from "./handlers/thoughts.ts";
import {
  handleManagePerson,
  handleDeletePerson,
  handleMergePerson,
  handleListPeople,
  handleManageAlias,
} from "./handlers/people.ts";
import {
  handleManageProject,
  handleDeleteProject,
  handleListProjects,
} from "./handlers/projects.ts";
import {
  handleListSkills,
  handleManageSkill,
  handleImportSkill,
  handleRouteTask,
} from "./handlers/skills.ts";
import {
  handleGetHealthSummary,
  handleGetHealthTrend,
  handleCorrelateHealthThoughts,
} from "./handlers/health.ts";
import { handleVoiceCall } from "./handlers/voice.ts";
import {
  handleManageArtifact,
  handleCompileWiki,
  handleManageWikiEntity,
} from "./handlers/wiki.ts";

const TOOLS = [
  {
    name: "get_transcript",
    description: "Fetch or search verbatim (diarized) meeting transcripts (stored outside the thoughts table; the thought holds only the summary). Modes: (1) `plaud_id` → returns ONE transcript, PAGINATED — transcripts are large, so it returns a chunk plus `total_chars`, `has_more`, `next_offset`; to read the WHOLE transcript, call repeatedly passing `offset=next_offset` until `has_more` is false. (2) `query` → full-text search (RU+EN), ranked snippets. (3) neither → list recent transcripts. Use this for the exact wording of a meeting.",
    inputSchema: {
      type: "object",
      properties: {
        plaud_id: { type: "string", description: "Exact recording id — returns one transcript (paginated)" },
        offset: { type: "number", description: "Char offset to start from (paginate the transcript); default 0. Use next_offset from the previous call." },
        chars: { type: "number", description: "Chunk size in characters per call, default 14000 (max 20000)." },
        query: { type: "string", description: "Full-text search across transcripts (RU+EN); returns ranked snippets" },
        limit: { type: "number", description: "Max results for search/list, default 5" },
      },
    },
  },
  {
    name: "search_thoughts",
    description: "Hybrid search: combines semantic similarity (vector) with keyword matching (BM25) using Reciprocal Rank Fusion. Results are ranked by combined relevance and recency (Ebbinghaus decay). Supports post-filtering by type, topic, person, area, source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (used for both semantic and keyword matching)" },
        threshold: { type: "number", description: "Similarity threshold 0-1, default 0.3 (lower than before — keyword matches compensate)" },
        limit: { type: "number", description: "Max results, default 10" },
        type: { type: "string", description: "Filter by type: idea, task, reflection, note, question, event, decision, insight" },
        topic: { type: "string", description: "Filter by topic (partial match)" },
        person: { type: "string", description: "Filter by person mentioned" },
        area: { type: "string", description: "Filter by area: work, personal, health, finance, learning, social" },
        source: { type: "string", description: "Filter by source: mcp, slack, telegram, google-calendar, gmail, granola" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description: "Browse recent thoughts with optional filters by type, topic, person, time range, area, source, or deadline.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results, default 20" },
        offset: { type: "number", description: "Skip first N results for pagination, default 0" },
        type: { type: "string", description: "Filter: idea, task, reflection, note, question, event, decision, insight" },
        topic: { type: "string", description: "Filter by topic (partial match)" },
        person: { type: "string", description: "Filter by person mentioned" },
        days: { type: "number", description: "Only last N days" },
        area: { type: "string", description: "Filter by area: work, personal, health, finance, learning, social" },
        source: { type: "string", description: "Filter by source: mcp, slack, telegram, google-calendar, gmail, granola" },
        deadline_before: { type: "string", description: "Filter: due_date <= this date (ISO format)" },
        deadline_after: { type: "string", description: "Filter: due_date >= this date (ISO format)" },
        overdue: { type: "boolean", description: "Filter: only overdue tasks (due_date < now AND not done)" },
        has_deadline: { type: "boolean", description: "Filter: only thoughts that have a deadline set" },
      },
    },
  },
  {
    name: "thought_stats",
    description: "Get statistics: total count, type breakdown, top topics and people, last 7 days.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_thought",
    description: "Capture a new thought. Embedding and metadata are generated automatically. Use 'project' to explicitly link to a project by name.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The thought to capture" },
        type: { type: "string", description: "Override type: idea, task, reflection, note, question" },
        topic: { type: "string", description: "Override topic" },
        source: { type: "string", description: "Source identifier, default 'mcp'" },
        project: { type: "string", description: "Link to project by name (partial match). Creates an explicit linked_projects entry." },
        deadline: { type: "string", description: "Deadline in ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm. Also auto-extracted from content by LLM." },
      },
      required: ["content"],
    },
  },
  {
    name: "update_thought",
    description: "Update a thought: mark as done/in_progress/open/cancelled, change content, set topic, deadline, link/unlink a project. Existing project links, people links, and related thoughts are always preserved even when content changes. Requires the thought's id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID of the thought to update" },
        status: { type: "string", description: "New status: done, in_progress, open, cancelled" },
        content: { type: "string", description: "New content (re-embeds automatically if changed)" },
        topic: { type: "string", description: "Override topic (survives content re-extraction)" },
        project: { type: "string", description: "Link to project by name (adds to existing links, does not replace)" },
        unlink_project: { type: "string", description: "Unlink a project by name (partial match) or UUID. Removes it from linked_projects." },
        deadline: { type: ["string", "null"], description: "Set or update deadline (ISO format). Pass null to remove deadline." },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_thought",
    description: "Permanently delete a thought by id. Use with caution — irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID of the thought to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "manage_person",
    description: "Add or update a person in the people directory. Use this to store context about people: who they are, their role, organization. Upserts by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's full name" },
        context: { type: "string", description: "Who they are, how you know them, key details" },
        role: { type: "string", description: "Role: colleague, friend, family, client, manager, mentor, etc." },
        organization: { type: "string", description: "Company or group they belong to" },
        area: { type: "string", description: "Primary area: work, personal, health, finance, learning, social" },
        metadata: { type: "object", description: "Additional structured data (email, telegram, notes)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_person",
    description: "Permanently delete a person from the directory by UUID. Use when merging duplicates or removing garbage entries. Irreversible. For merging duplicates prefer merge_person — it copies context, adds alias, and rewrites thoughts.linked_people atomically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID of the person to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "merge_person",
    description: "Atomically merge an orphan/duplicate person card into a canonical one. Copies context (with [merged from] marker), fills target's null role/org from source, adds alias source.name → target.id, rewrites thoughts.metadata.linked_people from source.id to target.id, then deletes source. Solves the manage_person upsert-bug (can't rename a card without creating a duplicate).",
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "UUID of the orphan/duplicate to merge from" },
        target_id: { type: "string", description: "UUID of the canonical card to merge into" },
        add_alias: { type: "boolean", description: "Add source.name as alias of target. Default true." },
      },
      required: ["source_id", "target_id"],
    },
  },
  {
    name: "list_people",
    description: "List people in the directory. Search by name, filter by role, area, or organization. Use orphans_only=true to find cards with zero linked thoughts (cleanup candidates).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search in name, context, organization" },
        role: { type: "string", description: "Filter by role: colleague, friend, family, client, etc." },
        area: { type: "string", description: "Filter by area: work, personal, social, etc." },
        organization: { type: "string", description: "Filter by organization (partial match)" },
        orphans_only: { type: "boolean", description: "If true, return only people with zero linked thoughts (orphan cards for cleanup)" },
        limit: { type: "number", description: "Max results, default 50" },
      },
    },
  },
  {
    name: "manage_alias",
    description: "Add or remove a canonical-name alias mapping. Use to fix recurring short-form duplicates ('Соколов' → Дмитрий Соколов), Russian morphology ('Андреем' → Андрей Смирнов), and transliteration variants ('Akshay' / 'Aakshay'). Aliases are checked BEFORE fuzzy matching in the ingest pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"], description: "add maps alias→person; remove deletes by normalized alias" },
        alias: { type: "string", description: "Raw alias as it appears in input text, e.g. 'Соколов' or 'Akshay'. Normalized internally (lowercase, ё→е, trim)." },
        person_id: { type: "string", description: "UUID of the canonical person. Required for action=add." },
        source: { type: "string", enum: ["manual", "nightly-dream", "merge"], description: "Origin of the alias. Default 'manual'." },
      },
      required: ["action", "alias"],
    },
  },
  {
    name: "manage_project",
    description: "Add or update a project/goal/initiative. Tracks name, description, status, area, deadline. Upserts by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "What this project is about, goals, key context" },
        status: { type: "string", description: "Status: active, paused, completed, archived" },
        area: { type: "string", description: "Area: work, personal, health, finance, learning, social" },
        deadline: { type: "string", description: "Deadline in ISO format (YYYY-MM-DD)" },
        metadata: { type: "object", description: "Additional data: tags, links, milestones, stakeholders" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_project",
    description: "Permanently delete a project by UUID. Use when merging duplicates or removing test entries. Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID of the project to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_projects",
    description: "List projects/goals/initiatives. Filter by status, area, or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: active, paused, completed, archived" },
        area: { type: "string", description: "Filter by area: work, personal, etc." },
        search: { type: "string", description: "Search in name and description" },
        limit: { type: "number", description: "Max results, default 20" },
      },
    },
  },
  {
    name: "get_style_profile",
    description: "Get the user's writing style profile. ALWAYS call this before drafting messages, emails, or any text on behalf of the user. Returns tone, structure, vocabulary and formatting rules to match the user's personal writing style.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_skills",
    description: "Browse available skills in the skill library. Filter by category, client, or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter: management, development, communication, analysis, design, marketing, testing, support" },
        client: { type: "string", description: "Filter: claude-code, cursor, claude-desktop, any" },
        search: { type: "string", description: "Search in name and description" },
        limit: { type: "number", description: "Max results, default 20" },
      },
    },
  },
  {
    name: "manage_skill",
    description: "Add or update a skill in the registry. A skill defines a reusable capability: what it does, which client handles it best, trigger keywords, and an optional system prompt. Upserts by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (unique identifier)" },
        description: { type: "string", description: "What this skill does" },
        category: { type: "string", description: "Category: management, development, communication, analysis" },
        client: { type: "string", description: "Best client: claude-code, cursor, claude-desktop, any" },
        trigger_patterns: { type: "array", items: { type: "string" }, description: "Keywords that trigger this skill" },
        tools_required: { type: "array", items: { type: "string" }, description: "MCP tools this skill needs" },
        skill_prompt: { type: "string", description: "System prompt to use when executing this skill" },
        is_active: { type: "boolean", description: "Enable/disable the skill" },
      },
      required: ["name"],
    },
  },
  {
    name: "import_skill",
    description: "Import a skill from an external source (URL to markdown file or raw text). Automatically parses the agent description, adapts it to Open Brain MCP tools, generates trigger patterns, and saves to the skill registry.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch the skill/agent description from" },
        text: { type: "string", description: "Raw text of the skill/agent description (alternative to URL)" },
        override_name: { type: "string", description: "Override the auto-generated skill name" },
        override_category: { type: "string", description: "Override category" },
      },
    },
  },
  {
    name: "route_task",
    description: "Find the best skill to handle a task. Returns recommended skill with prompt, alternatives, and relevant context from memory. Use this when you have a task and want to know the best approach.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Description of the task to route" },
        category: { type: "string", description: "Optional filter by category" },
        limit: { type: "number", description: "Max skill matches, default 3" },
      },
      required: ["task"],
    },
  },
  {
    name: "get_health_summary",
    description: "Aggregate health metrics (steps, sleep, heart rate, VO2max, workouts) over a date range. Returns averages, totals and workout breakdown. Defaults to the last 7 days when dates are omitted. Source: Samsung Health via Health Connect.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive start date (YYYY-MM-DD). Default: 7 days ago." },
        end_date: { type: "string", description: "Inclusive end date (YYYY-MM-DD). Default: today." },
      },
    },
  },
  {
    name: "get_health_trend",
    description: "Time series of a single health metric over the last N weeks. Returns one point per day plus min/max/avg stats. Useful for spotting trends.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "One of: steps, distance_meters, total_calories, hr_min, hr_max, hr_avg, resting_hr, sleep_minutes, vo2max, active_minutes_moderate, active_minutes_vigorous" },
        weeks: { type: "number", description: "Number of past weeks to include, default 4" },
      },
      required: ["metric"],
    },
  },
  {
    name: "correlate_health_thoughts",
    description: "Find days where a health metric satisfies a condition (e.g. sleep_minutes < 360, resting_hr > 65, steps < 5000) and return the thoughts captured on those days. Use for queries like 'show me reflections from days I slept poorly' or 'what was on my mind on low-activity days'. Joins health_metrics_daily and thoughts on calendar date.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "One of: steps, distance_meters, total_calories, hr_min, hr_max, hr_avg, resting_hr, sleep_minutes, vo2max, active_minutes_moderate, active_minutes_vigorous" },
        operator: { type: "string", enum: ["<", "<=", ">", ">=", "==", "!="], description: "Comparison operator" },
        threshold: { type: "number", description: "Numeric threshold for the condition" },
        days_lookback: { type: "number", description: "How many past days to scan, default 30" },
        thoughts_per_day_limit: { type: "number", description: "Max thoughts returned per day, default 10" },
        type: { type: "string", description: "Optional filter: only thoughts of this type (idea, task, reflection, note, ...)" },
        area: { type: "string", description: "Optional filter: only thoughts in this area (work, personal, health, ...)" },
      },
      required: ["metric", "operator", "threshold"],
    },
  },
  {
    name: "voice_call",
    description: "Запустить голосовой звонок через Vapi от твоего имени. Принимает свободное описание задачи (на русском), парсит intent через Claude, создаёт call_task и сразу инициирует исходящий звонок. Telegram-эквивалент: /call <task>. Отчёт о звонке (статус, transcript, recording) прилетит в Telegram-бот после окончания, и summary автоматически попадёт в Open Brain как note. Использовать когда пользователь просит позвонить куда-либо: 'позвони в клинику и запиши на приём', 'позвони в кафе и забронируй стол на 4 человек', 'узнай у магазина X есть ли товар Y'.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Свободный текст задачи на русском. Пример: 'позвони в клинику и запиши на приём к ортопеду, желательно в четверг или пятницу после 16:00'" },
        phone: { type: "string", description: "Опционально: телефон в формате +972XXXXXXXXX. Если не указан, парсер intent сам подставит из мини-справочника известных организаций (Леумит = *507 и т.п.)" },
      },
      required: ["task"],
    },
  },
  {
    name: "manage_artifact",
    description: "Управление артефактами wiki — документы, расчёты, презентации, привязанные к wiki-сущностям. Артефакты появляются на wiki-странице в секции 'Артефакты' при следующей компиляции. Использовать: 'прикрепи финмодель к Alshaya', 'покажи артефакты по Египту', 'удали артефакт'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"], description: "add — прикрепить артефакт, remove — удалить, list — показать артефакты" },
        entity: { type: "string", description: "Имя или slug wiki-сущности (для add и list). Пример: 'Alshaya Group', 'egypt', 'mfa-template'" },
        title: { type: "string", description: "Название артефакта (для add). Пример: 'Финмодель Alshaya Q2'" },
        url: { type: "string", description: "Ссылка на артефакт (для add). Google Drive URL, file:///path, или любой другой URL" },
        artifact_type: { type: "string", enum: ["document", "spreadsheet", "presentation", "pdf", "email", "link", "other"], description: "Тип артефакта (для add, по умолчанию document)" },
        description: { type: "string", description: "Краткое описание (для add, опционально)" },
        artifact_id: { type: "string", description: "UUID артефакта (для remove)" },
      },
      required: ["action"],
    },
  },
  {
    name: "compile_wiki",
    description: "Запустить компиляцию wiki-страницы для одной или всех сущностей. Не ждать ночного cron — скомпилировать прямо сейчас. Использовать: 'скомпилируй Egypt', 'обнови wiki по Alshaya', 'пересобери все wiki-страницы'.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Slug или имя сущности для компиляции. Если не указан — компилирует все затронутые (incremental). Примеры: 'egypt', 'Alshaya Group', 'mfa-template'" },
        force: { type: "boolean", description: "true — перекомпилировать даже если нет новых thoughts. По умолчанию true для single entity, false для all." },
      },
    },
  },
  {
    name: "manage_wiki_entity",
    description: "Управление wiki-сущностями и алиасами brain-wiki. Создать/удалить сущность (страну, компанию, топик, человека), добавить/удалить алиас, посмотреть список. Использовать: 'добавь Казахстан в wiki', 'добавь алиас Alshaya для Alshaya Group', 'покажи все wiki-сущности'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove", "add_alias", "remove_alias"], description: "Действие" },
        entity_type: { type: "string", enum: ["person", "country", "company", "topic"], description: "Тип сущности (для add)" },
        canonical: { type: "string", description: "Каноническое имя (для add). Пример: 'Kazakhstan', 'Долгосрочный финансовый план'" },
        slug: { type: "string", description: "Slug для URL/файла (для add, автогенерится если пусто)" },
        file_path: { type: "string", description: "Путь файла в репо (для add, по умолчанию <type>s/<slug>.md)" },
        id: { type: "string", description: "UUID сущности (для remove)" },
        search: { type: "string", description: "Поиск по canonical/slug (для list)" },
        filter_type: { type: "string", description: "Фильтр по entity_type (для list)" },
        limit: { type: "number", description: "Лимит результатов (для list, default 50)" },
        entity: { type: "string", description: "Canonical или slug целевой сущности (для add_alias/remove_alias)" },
        alias: { type: "string", description: "Текст алиаса (для add_alias/remove_alias)" },
      },
      required: ["action"],
    },
  },
];

// Handle MCP JSON-RPC requests
export async function handleMcpRequest(body: Record<string, unknown>) {
  const { method, id, params } = body as {
    method: string;
    id: unknown;
    params?: Record<string, unknown>;
  };

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "open-brain-mcp", version: "3.6.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // no response for notifications
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === "tools/call") {
    const toolName = (params as Record<string, unknown>)?.name as string;
    const toolArgs = ((params as Record<string, unknown>)?.arguments || {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (toolName) {
        case "get_transcript":
          result = await handleGetTranscript(toolArgs);
          break;
        case "search_thoughts":
          result = await handleSearchThoughts(toolArgs);
          break;
        case "list_thoughts":
          result = await handleListThoughts(toolArgs);
          break;
        case "thought_stats":
          result = await handleThoughtStats();
          break;
        case "capture_thought":
          result = await handleCaptureThought(toolArgs);
          break;
        case "update_thought":
          result = await handleUpdateThought(toolArgs);
          break;
        case "delete_thought":
          result = await handleDeleteThought(toolArgs);
          break;
        case "manage_person":
          result = await handleManagePerson(toolArgs);
          break;
        case "delete_person":
          result = await handleDeletePerson(toolArgs);
          break;
        case "merge_person":
          result = await handleMergePerson(toolArgs);
          break;
        case "list_people":
          result = await handleListPeople(toolArgs);
          break;
        case "manage_alias":
          result = await handleManageAlias(toolArgs);
          break;
        case "manage_project":
          result = await handleManageProject(toolArgs);
          break;
        case "delete_project":
          result = await handleDeleteProject(toolArgs);
          break;
        case "list_projects":
          result = await handleListProjects(toolArgs);
          break;
        case "get_style_profile":
          result = await handleGetStyleProfile();
          break;
        case "list_skills":
          result = await handleListSkills(toolArgs);
          break;
        case "manage_skill":
          result = await handleManageSkill(toolArgs);
          break;
        case "import_skill":
          result = await handleImportSkill(toolArgs);
          break;
        case "route_task":
          result = await handleRouteTask(toolArgs);
          break;
        case "get_health_summary":
          result = await handleGetHealthSummary(toolArgs);
          break;
        case "get_health_trend":
          result = await handleGetHealthTrend(toolArgs);
          break;
        case "voice_call":
          result = await handleVoiceCall(toolArgs);
          break;
        case "correlate_health_thoughts":
          result = await handleCorrelateHealthThoughts(toolArgs);
          break;
        case "manage_artifact":
          result = await handleManageArtifact(toolArgs);
          break;
        case "compile_wiki":
          result = await handleCompileWiki(toolArgs);
          break;
        case "manage_wiki_entity":
          result = await handleManageWikiEntity(toolArgs);
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// --- SSE helpers ---

export function sseEncode(event: string, data: string): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

// --- CORS ---

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-brain-key, mcp-session-id",
};
