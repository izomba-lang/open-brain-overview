import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";

const SONNET_MODEL = "claude-sonnet-4-20250514";
const MAX_CONCURRENCY = 1;
const SONNET_INPUT_PRICE = 3;    // $/M tokens
const SONNET_OUTPUT_PRICE = 15;  // $/M tokens

// ─── Types ───

interface WikiEntity {
  id: string;
  entity_type: string;
  canonical: string;
  slug: string;
  file_path: string;
  last_compiled_at: string | null;
  last_thought_seen_at: string | null;
  last_sha: string | null;
  thoughts_count: number;
  status: string;
}

interface CompileRun {
  id: string;
  entities_touched: number;
  thoughts_processed: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error_log: Array<{ entity: string; error: string }>;
}

interface ThoughtContext {
  thoughts: Array<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
  total: number;
  new_count: number;
  max_updated_at: string;
  related_entities: string[];
  artifacts: Array<{ title: string; url: string; artifact_type: string; description: string | null }>;
}

// ─── Auth ───

function authenticate(req: Request): boolean {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || req.headers.get("x-brain-key");
  return key === MCP_ACCESS_KEY;
}

// ─── GitHub API ───

async function getFileSha(filePath: string): Promise<string | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub GET ${filePath}: ${resp.status}`);
  const data = await resp.json();
  return data.sha;
}

async function commitToGitHub(
  filePath: string,
  content: string,
  message: string
): Promise<string> {
  const existingSha = await getFileSha(filePath);
  const body: Record<string, unknown> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    committer: { name: "Wiki Compiler", email: "bot@dodo-wiki" },
  };
  if (existingSha) body.sha = existingSha;

  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GitHub PUT ${filePath}: ${resp.status} — ${errText}`);
  }
  const data = await resp.json();
  return data.content?.sha || "";
}

async function getFileContent(filePath: string): Promise<string | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) return null;
  const data = await resp.json();
  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
}

// ─── Anthropic API ───

async function callClaude(
  systemPrompt: string,
  userMessage: string,
  maxRetries = 5
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
      const delay = Math.max(retryAfter * 1000, (2 ** attempt) * 15_000);
      console.log(`Rate limited, waiting ${Math.round(delay/1000)}s (attempt ${attempt + 1}/${maxRetries + 1})`);
      await resp.text();
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API: ${resp.status} — ${errText}`);
    }
    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    return {
      text,
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
    };
  }
  throw new Error("Anthropic API: max retries exceeded on 429");
}

// ─── Compiler system prompt ───

const COMPILER_SYSTEM_PROMPT = `Ты — Wiki Compiler для Open Brain Ильи Зомбы, Head of International Markets в Dodo Brands.

Твоя задача — поддерживать markdown-страницы wiki, которые описывают
сущности (страны, людей, компании, топики) на основе мыслей, заметок и решений,
накопленных в базе. Это compiled view поверх Source-of-truth БД.

Главные принципы:

1. ЯЗЫК. Илья работает на русском. Все страницы — на русском, кроме имён собственных
   и технических терминов. Исключение: имя сущности в title может быть на английском,
   если так канонизировано.

2. ИСТОЧНИК ПРАВДЫ. Ты НЕ источник правды. БД — источник. Ты — компилятор.
   Если в БД нет данных по какому-то аспекту — пиши «нет данных», НЕ выдумывай.

3. ПРОТИВОРЕЧИЯ — НЕ СГЛАЖИВАТЬ. Если в thoughts есть позиции, которые конфликтуют
   (партнёр обещал X, потом сказал Y; HQ считает A, оперативка B; в марте было одно,
   в апреле другое), они должны быть выделены в секции «⚠️ Противоречия» с обеими
   позициями и датами. НЕ пытайся примирить, НЕ выбирай «правильную» — это сигнал
   для Ильи, не помеха.

4. PROVENANCE. Каждое нетривиальное утверждение — со ссылкой на источник в формате:
   (источник: <thought-type>, <date>, <thought-id-короткий-8-символов>). Это позволяет
   Илье дойти до сырья.

5. РЕДАКТОРСКАЯ СТРУКТУРА. Сохраняй структуру существующей страницы (если она есть),
   обновляй только секции, в которые есть новые данные. НЕ пиши страницу с нуля
   каждый раз — это разрушает Илья-добавленные пометки, если он их вносил.
   Блоки <!-- ILYA: ... --> сохраняй as-is, переноси в новую версию.

6. КРОСС-ССЫЛКИ. Когда упоминаешь другую сущность, ставь [[entity-slug]].
   Используй канонические имена из предоставленного списка связанных сущностей.

7. ЯЗЫК ВЫВОДА — ДЕЛОВОЙ. Никакого маркетинга, восторгов, hedging-фраз
   «возможно, наверное, кажется». Если что-то неточно — «по состоянию на <дата>:
   <утверждение>». Если совсем неясно — «требует проверки».

8. ОБЪЁМ. Страница сущности — до 1500 слов. Если выходит больше — сокращай
   хронологию, оставляя ключевые решения и инсайты.

9. ФОРМАТ ВЫВОДА — ТОЛЬКО MARKDOWN. Не оборачивай в \`\`\`markdown блоки.
   Выведи чистый markdown, начиная с # заголовка.

Структура страницы:

# <Каноническое имя>
> tags: <автогенерируемые>
> last compiled: <ISO timestamp>
> thoughts: <count>

## TL;DR (3-5 строк)
Текущее состояние на сегодня.

## Открытые вопросы
Что не закрыто, требует решения / действия. Со сроками, если известны.

## Контекст
Кто, что, история отношений, ключевые факты.

## Ключевые решения и инсайты
Из thoughts типа decision и insight. Хронологически (новые сверху).

## ⚠️ Противоречия (если есть)
Конфликтующие данные с датами и источниками. БЕЗ резолюции.

## Артефакты (если предоставлены)
Список ссылок на документы, расчёты, презентации, письма. Каждый — кликабельная ссылка
в формате [Название](url) с кратким описанием. НЕ выдумывай артефакты — бери только из
предоставленного списка.

## Связанные сущности
[[link]] на людей, страны, компании, топики.

## Последние события (последние 30 дней)
Свежие thoughts кратко, со ссылкой на тип.`;

// ─── Delta compiler system prompt ───

const DELTA_SYSTEM_PROMPT = `Ты — Wiki Compiler (delta mode) для Open Brain Ильи Зомбы.

Тебе даны:
1. Текущая markdown-страница wiki-сущности (ПОЛНАЯ)
2. Только НОВЫЕ thoughts (появившиеся с последней компиляции)

Твоя задача — ОБНОВИТЬ страницу, интегрируя новые thoughts.

Правила:
- НЕ переписывай страницу с нуля. Обнови только те секции, куда попадают новые данные.
- Блоки <!-- ILYA: ... --> сохраняй as-is.
- Сохраняй существующий provenance (ссылки на thought-id).
- Добавляй provenance для новых данных: (источник: <type>, <date>, <id-8>).
- Если новые thoughts противоречат существующим — добавь в секцию "⚠️ Противоречия".
- Обнови TL;DR если новые данные существенно меняют картину.
- Обнови "Последние события" — добавь новые, убери старше 30 дней.
- Обнови "Открытые вопросы" — закрой решённые, добавь новые.
- Если предоставлены артефакты — обнови секцию "Артефакты".
- Язык — русский, деловой, без hedging.
- Обнови timestamp "last compiled" и счётчик thoughts в шапке.
- ФОРМАТ ВЫВОДА — ТОЛЬКО MARKDOWN. Не оборачивай в \`\`\`markdown блоки.`;

// ─── Entity resolution helpers ───

async function resolvePersonCanonical(name: string): Promise<string | null> {
  const normalized = name.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

  const { data: alias } = await supabase
    .from("person_aliases")
    .select("person_id, people!inner(name)")
    .eq("alias_normalized", normalized)
    .limit(1)
    .maybeSingle();

  if (alias) return (alias as any).people?.name || null;

  const { data: person } = await supabase
    .from("people")
    .select("name")
    .eq("normalized_name", normalized)
    .limit(1)
    .maybeSingle();

  return person?.name || null;
}

async function resolveEntityCanonical(
  entityType: string,
  name: string
): Promise<string | null> {
  if (entityType === "person") return resolvePersonCanonical(name);

  const normalized = name.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

  const { data: alias } = await supabase
    .from("entity_aliases")
    .select("canonical")
    .eq("entity_type", entityType)
    .eq("alias_normalized", normalized)
    .limit(1)
    .maybeSingle();

  return alias?.canonical || null;
}

// ─── Load entity context ───

async function loadEntityContext(
  entity: WikiEntity,
  deltaOnly = false
): Promise<ThoughtContext> {
  const since = entity.last_thought_seen_at || "1970-01-01T00:00:00Z";

  // deltaOnly: load only thoughts newer than last compilation
  // Used for incremental updates when existing page exists
  const filterSince = deltaOnly ? since : "1970-01-01T00:00:00Z";

  let allThoughts: any[] = [];

  if (entity.entity_type === "person") {
    // Resolve person_id from people table
    const normalized = entity.canonical.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
    const { data: person } = await supabase
      .from("people")
      .select("id")
      .eq("normalized_name", normalized)
      .limit(1)
      .maybeSingle();

    if (person) {
      // Get all aliases for this person
      const { data: aliases } = await supabase
        .from("person_aliases")
        .select("alias_raw")
        .eq("person_id", person.id);

      const names = [entity.canonical, ...(aliases || []).map((a: any) => a.alias_raw)];

      // Query via linked_people (uuid array)
      let linkedQuery = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .contains("metadata", { linked_people: [person.id] });
      if (deltaOnly) linkedQuery = linkedQuery.gt("updated_at", filterSince);
      const { data: linkedThoughts } = await linkedQuery
        .order("updated_at", { ascending: false })
        .limit(200);

      // Also query by text mentions in metadata.people (string array)
      // for thoughts that weren't properly linked
      let mentionQuery = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .or(names.map(n => `metadata->>people.cs.{${n}}`).join(","));
      if (deltaOnly) mentionQuery = mentionQuery.gt("updated_at", filterSince);
      const { data: mentionThoughts } = await mentionQuery
        .order("updated_at", { ascending: false })
        .limit(50);

      const seen = new Set<string>();
      for (const t of [...(linkedThoughts || []), ...(mentionThoughts || [])]) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          allThoughts.push(t);
        }
      }
    }
  } else if (entity.entity_type === "country") {
    // Countries are mentioned in topic, content, or area metadata
    const { data: entityAliases } = await supabase
      .from("entity_aliases")
      .select("alias")
      .eq("entity_type", "country")
      .eq("canonical", entity.canonical);

    const searchTerms = [entity.canonical, ...(entityAliases || []).map((a: any) => a.alias)];

    for (const term of searchTerms) {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .ilike("content", `%${term}%`);
      if (deltaOnly) q = q.gt("updated_at", filterSince);
      const { data } = await q
        .order("updated_at", { ascending: false })
        .limit(100);

      if (data) {
        const seen = new Set(allThoughts.map(t => t.id));
        for (const t of data) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            allThoughts.push(t);
          }
        }
      }
    }
  } else {
    // Companies and topics — search by canonical + aliases in content
    const table = "entity_aliases";
    const { data: entityAliases } = await supabase
      .from(table)
      .select("alias")
      .eq("entity_type", entity.entity_type)
      .eq("canonical", entity.canonical);

    const searchTerms = [entity.canonical, ...(entityAliases || []).map((a: any) => a.alias)];

    for (const term of searchTerms) {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .ilike("content", `%${term}%`);
      if (deltaOnly) q = q.gt("updated_at", filterSince);
      const { data } = await q
        .order("updated_at", { ascending: false })
        .limit(100);

      if (data) {
        const seen = new Set(allThoughts.map(t => t.id));
        for (const t of data) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            allThoughts.push(t);
          }
        }
      }
    }
  }

  // Sort by updated_at desc, keep max 200
  allThoughts.sort((a, b) =>
    new Date(b.updated_at || b.created_at).getTime() -
    new Date(a.updated_at || a.created_at).getTime()
  );

  // Always keep ALL decision/insight/reflection regardless of limit
  const critical = allThoughts.filter((t: any) =>
    ["decision", "insight", "reflection"].includes(t.metadata?.type)
  );
  const rest = allThoughts.filter((t: any) =>
    !["decision", "insight", "reflection"].includes(t.metadata?.type)
  );
  const kept = [...critical, ...rest.slice(0, 200 - critical.length)];

  const newCount = kept.filter(
    (t: any) => new Date(t.updated_at || t.created_at) > new Date(since)
  ).length;

  const maxUpdatedAt = kept.length > 0
    ? kept.reduce((max, t) => {
        const ts = t.updated_at || t.created_at;
        return ts > max ? ts : max;
      }, "1970-01-01T00:00:00Z")
    : since;

  // Find related entities (cross-references)
  const relatedPeople = new Map<string, number>();
  for (const t of kept) {
    const people = t.metadata?.people as string[] || [];
    for (const p of people) {
      if (p !== entity.canonical) {
        relatedPeople.set(p, (relatedPeople.get(p) || 0) + 1);
      }
    }
  }
  const relatedEntities = [...relatedPeople.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name);

  // Load artifacts linked to this entity
  const { data: artifactsData } = await supabase
    .from("artifacts")
    .select("title, url, artifact_type, description")
    .eq("entity_id", entity.id)
    .order("created_at", { ascending: false });

  return {
    thoughts: kept.map(t => ({
      id: t.id,
      content: t.content,
      metadata: t.metadata,
      created_at: t.created_at,
    })),
    total: kept.length,
    new_count: newCount,
    max_updated_at: maxUpdatedAt,
    related_entities: relatedEntities,
    artifacts: artifactsData || [],
  };
}

// ─── Build compiler prompt ───

function buildCompilerPrompt(
  entity: WikiEntity,
  context: ThoughtContext,
  existingPage: string | null,
  isDelta = false
): string {
  const parts: string[] = [];

  parts.push(`## Сущность для компиляции\n`);
  parts.push(`- Тип: ${entity.entity_type}`);
  parts.push(`- Каноническое имя: ${entity.canonical}`);
  parts.push(`- Slug: ${entity.slug}`);
  if (isDelta) {
    parts.push(`- Новых thoughts: ${context.total}`);
    parts.push(`- Режим: DELTA (обнови существующую страницу)\n`);
  } else {
    parts.push(`- Всего thoughts: ${context.total} (новых: ${context.new_count})`);
  }
  parts.push(`- Дата компиляции: ${new Date().toISOString()}\n`);

  if (context.related_entities.length > 0) {
    parts.push(`## Связанные сущности (упоминаются ≥3 раз)`);
    parts.push(context.related_entities.join(", ") + "\n");
  }

  if (context.artifacts.length > 0) {
    parts.push(`## Артефакты (документы, расчёты, презентации)`);
    parts.push(`Вставь эти ссылки в секцию "Артефакты" на странице.\n`);
    for (const a of context.artifacts) {
      const desc = a.description ? ` — ${a.description}` : "";
      parts.push(`- [${a.title}](${a.url}) (${a.artifact_type})${desc}`);
    }
    parts.push("");
  }

  if (existingPage) {
    parts.push(`## Текущая страница${isDelta ? '' : ' (обнови, не переписывай с нуля)'}`);
    parts.push("```markdown");
    parts.push(existingPage);
    parts.push("```\n");
  }

  const label = isDelta ? `Новые thoughts` : `Thoughts`;
  parts.push(`## ${label} (${context.total} штук, отсортированы по дате, новые первыми)\n`);

  for (const t of context.thoughts) {
    const meta = t.metadata as Record<string, unknown>;
    const type = meta.type || "note";
    const topic = meta.topic || "";
    const date = t.created_at.slice(0, 10);
    const shortId = t.id.slice(0, 8);

    parts.push(`### [${type}] ${date} (${shortId})`);
    if (topic) parts.push(`topic: ${topic}`);
    parts.push(t.content);
    parts.push("---");
  }

  return parts.join("\n");
}

// ─── Find touched entities ───

async function getTouchedEntities(force: boolean): Promise<WikiEntity[]> {
  if (force) {
    const { data, error } = await supabase
      .from("wiki_entities")
      .select("*")
      .in("status", ["pending", "active", "stale", "error"]);
    if (error) throw new Error(`getTouchedEntities: ${error.message}`);
    return data || [];
  }

  // Incremental: find entities with thoughts newer than last compile
  // For each entity, check if there are new thoughts mentioning it
  const { data: entities, error } = await supabase
    .from("wiki_entities")
    .select("*")
    .in("status", ["pending", "active", "stale", "error"]);

  if (error) throw new Error(`getTouchedEntities: ${error.message}`);
  if (!entities || entities.length === 0) return [];

  // Separate pending (always compile) from active (need new-thought check)
  const pending = entities.filter(e => e.status === "pending");
  const active = entities.filter(e => e.status !== "pending");

  if (active.length === 0) return pending;

  // Find the oldest last_thought_seen_at across all active entities
  const oldestSince = active.reduce((min, e) => {
    const ts = e.last_thought_seen_at || "1970-01-01T00:00:00Z";
    return ts < min ? ts : min;
  }, "9999-12-31T23:59:59Z");

  // Single query: get all thoughts updated since oldest checkpoint
  const { data: recentThoughts } = await supabase
    .from("thoughts")
    .select("id, content, metadata, updated_at")
    .gt("updated_at", oldestSince)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (!recentThoughts || recentThoughts.length === 0) return pending;

  // Load all aliases in one query
  const { data: allAliases } = await supabase
    .from("entity_aliases")
    .select("entity_type, canonical, alias");

  const aliasMap = new Map<string, string[]>();
  for (const a of allAliases || []) {
    const key = `${a.entity_type}:${a.canonical}`;
    if (!aliasMap.has(key)) aliasMap.set(key, []);
    aliasMap.get(key)!.push(a.alias.toLowerCase());
  }

  // Load person IDs for person entities
  const personEntities = active.filter(e => e.entity_type === "person");
  const personIds = new Map<string, string>();
  if (personEntities.length > 0) {
    for (const pe of personEntities) {
      const normalized = pe.canonical.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
      const { data: person } = await supabase
        .from("people")
        .select("id")
        .eq("normalized_name", normalized)
        .limit(1)
        .maybeSingle();
      if (person) personIds.set(pe.canonical, person.id);
    }
  }

  // Check each entity against recent thoughts
  const touched: WikiEntity[] = [...pending];

  for (const entity of active) {
    const since = entity.last_thought_seen_at || "1970-01-01T00:00:00Z";
    const relevantThoughts = recentThoughts.filter(t => t.updated_at > since);
    if (relevantThoughts.length === 0) continue;

    let hasNew = false;

    if (entity.entity_type === "person") {
      const pid = personIds.get(entity.canonical);
      if (pid) {
        hasNew = relevantThoughts.some(t =>
          (t.metadata?.linked_people as string[] || []).includes(pid)
        );
      }
    } else {
      const key = `${entity.entity_type}:${entity.canonical}`;
      const searchTerms = [entity.canonical.toLowerCase(), ...(aliasMap.get(key) || [])];
      const contentLower = relevantThoughts.map(t => t.content.toLowerCase());

      hasNew = searchTerms.some(term =>
        contentLower.some(c => c.includes(term))
      );
    }

    if (hasNew) touched.push(entity);
  }

  return touched;
}

// ─── Compile run management ───

async function startRun(mode: string): Promise<CompileRun> {
  const { data, error } = await supabase
    .from("wiki_compile_runs")
    .insert({ status: "running", mode })
    .select("id")
    .single();
  if (error) throw new Error(`startRun: ${error.message}`);
  return {
    id: data.id,
    entities_touched: 0,
    thoughts_processed: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    error_log: [],
  };
}

async function finishRun(
  run: CompileRun,
  status: string,
  errorMessage?: string
): Promise<void> {
  const cost = (run.tokens_in * SONNET_INPUT_PRICE + run.tokens_out * SONNET_OUTPUT_PRICE) / 1_000_000;
  await supabase
    .from("wiki_compile_runs")
    .update({
      finished_at: new Date().toISOString(),
      status,
      entities_touched: run.entities_touched,
      thoughts_processed: run.thoughts_processed,
      tokens_in: run.tokens_in,
      tokens_out: run.tokens_out,
      cost_usd: cost,
      error_log: run.error_log.length > 0 ? run.error_log : null,
      details: errorMessage ? { fatal_error: errorMessage } : {},
    })
    .eq("id", run.id);
}

// ─── Concurrency limiter ───

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).then((r) => { results.push(r); });
    const e = p.then(() => executing.delete(e));
    executing.add(e);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

// ─── Contradictions page ───

async function regenerateContradictionsPage(run: CompileRun): Promise<void> {
  // Collect all entities with contradictions from their compiled pages
  const { data: entities } = await supabase
    .from("wiki_entities")
    .select("canonical, entity_type, file_path, slug")
    .eq("status", "active");

  if (!entities || entities.length === 0) return;

  const lines: string[] = [
    "# Противоречия",
    `> last compiled: ${new Date().toISOString()}`,
    "",
    "Автогенерируемая сводка. Детали — на страницах сущностей.",
    "",
  ];

  for (const e of entities) {
    const page = await getFileContent(e.file_path);
    if (!page) continue;
    const contradictionMatch = page.match(/## ⚠️ Противоречия[\s\S]*?(?=\n## |$)/);
    if (contradictionMatch && contradictionMatch[0].trim().split("\n").length > 2) {
      lines.push(`## [[${e.slug}]] (${e.canonical})`);
      const content = contradictionMatch[0].replace("## ⚠️ Противоречия", "").trim();
      lines.push(content);
      lines.push("");
    }
  }

  if (lines.length > 5) {
    await commitToGitHub("_contradictions.md", lines.join("\n"), "Compile: update contradictions");
  }
}

// ─── Index page ───

async function regenerateIndex(): Promise<void> {
  const { data: entities } = await supabase
    .from("wiki_entities")
    .select("canonical, entity_type, slug, file_path, thoughts_count, last_compiled_at, status")
    .order("entity_type")
    .order("canonical");

  if (!entities) return;

  const lines: string[] = [
    "# Brain Wiki — Index",
    `> last compiled: ${new Date().toISOString()}`,
    "",
  ];

  const byType = new Map<string, typeof entities>();
  for (const e of entities) {
    const list = byType.get(e.entity_type) || [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  const typeLabels: Record<string, string> = {
    country: "Страны",
    person: "Люди",
    company: "Компании",
    topic: "Топики",
  };

  for (const [type, label] of Object.entries(typeLabels)) {
    const items = byType.get(type);
    if (!items || items.length === 0) continue;
    lines.push(`## ${label}`);
    for (const e of items) {
      const status = e.status === "active" ? "" : ` ⚠️ ${e.status}`;
      const compiled = e.last_compiled_at ? e.last_compiled_at.slice(0, 10) : "—";
      lines.push(`- [[${e.slug}]] — ${e.canonical} (${e.thoughts_count} thoughts, compiled ${compiled})${status}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("Также: [[_contradictions]] — сводка противоречий");

  await commitToGitHub("_index.md", lines.join("\n"), "Compile: update index");
}

// ─── Main compile logic ───

async function compileEntity(
  entity: WikiEntity,
  run: CompileRun,
  dryRun: boolean,
  forceFull = false
): Promise<void> {
  // Decide: delta or full compilation
  // Delta when: existing page exists + entity was compiled before + not forced full
  const existingPage = dryRun ? null : await getFileContent(entity.file_path);
  const canDelta = !forceFull && existingPage && entity.last_compiled_at;

  let context: ThoughtContext;
  let isDelta = false;

  if (canDelta) {
    // Try delta first: load only new thoughts
    const deltaContext = await loadEntityContext(entity, true);
    if (deltaContext.total === 0) {
      console.log(`Skip ${entity.canonical}: no new thoughts since last compile`);
      return;
    }
    // Use delta if new thoughts are < 50% of last known total
    // (if ratio is high, full recompile gives better quality)
    const ratio = entity.thoughts_count > 0
      ? deltaContext.total / entity.thoughts_count
      : 1;
    if (ratio < 0.5) {
      context = deltaContext;
      isDelta = true;
      console.log(`Delta mode for ${entity.canonical}: ${deltaContext.total} new thoughts (${Math.round(ratio * 100)}% of ${entity.thoughts_count})`);
    } else {
      // Too many new thoughts relative to total — full recompile is better
      context = await loadEntityContext(entity, false);
      console.log(`Full mode for ${entity.canonical}: ${deltaContext.total} new thoughts is ${Math.round(ratio * 100)}% of total — full recompile`);
    }
  } else {
    // First compile or forced: load all thoughts
    context = await loadEntityContext(entity, false);
  }

  if (context.total === 0) {
    console.log(`Skip ${entity.canonical}: no thoughts found`);
    return;
  }

  const systemPrompt = isDelta ? DELTA_SYSTEM_PROMPT : COMPILER_SYSTEM_PROMPT;
  const prompt = buildCompilerPrompt(entity, context, existingPage, isDelta);

  const inputEstimate = prompt.length / 4;
  const outputEstimate = isDelta ? 2000 : 4000;

  if (dryRun) {
    console.log(
      `[DRY-RUN] ${entity.canonical}: ${context.total} thoughts (${isDelta ? 'delta' : 'full'}), ~${Math.round(inputEstimate)} input tokens`
    );
    run.entities_touched++;
    run.thoughts_processed += context.total;
    run.tokens_in += Math.round(inputEstimate);
    run.tokens_out += outputEstimate;
    return;
  }

  const result = await callClaude(systemPrompt, prompt);

  // For delta, also count total thoughts (existing page's count + new)
  const totalThoughts = isDelta
    ? entity.thoughts_count + context.total
    : context.total;

  const sha = await commitToGitHub(
    entity.file_path,
    result.text,
    `${isDelta ? 'Delta' : 'Compile'}: ${entity.canonical} (+${isDelta ? context.total : context.new_count} thoughts)`
  );

  await supabase
    .from("wiki_entities")
    .update({
      last_compiled_at: new Date().toISOString(),
      last_thought_seen_at: context.max_updated_at,
      last_sha: sha,
      thoughts_count: totalThoughts,
      status: "active",
      last_error: null,
    })
    .eq("id", entity.id);

  run.entities_touched++;
  run.thoughts_processed += context.total;
  run.tokens_in += result.input_tokens;
  run.tokens_out += result.output_tokens;

  console.log(
    `${isDelta ? 'Delta' : 'Full'} compiled ${entity.canonical}: ${context.total} thoughts, ${result.input_tokens}+${result.output_tokens} tokens`
  );
}

async function compileWiki(opts: {
  force?: boolean;
  entity_filter?: string;
  dry_run?: boolean;
  pick_one?: boolean;
}): Promise<{
  status: string;
  entities_touched: number;
  thoughts_processed: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  remaining?: number;
  errors: Array<{ entity: string; error: string }>;
}> {
  const mode = opts.dry_run
    ? "dry-run"
    : opts.entity_filter
    ? "single"
    : opts.force
    ? "full"
    : "incremental";

  const run = await startRun(mode);

  try {
    let entities: WikiEntity[];

    if (opts.entity_filter) {
      const { data } = await supabase
        .from("wiki_entities")
        .select("*")
        .or(`canonical.ilike.%${opts.entity_filter}%,slug.ilike.%${opts.entity_filter}%`);
      entities = data || [];
    } else {
      entities = await getTouchedEntities(opts.force || false);
    }

    if (entities.length === 0) {
      await finishRun(run, "success");
      return {
        status: "success",
        entities_touched: 0,
        thoughts_processed: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        remaining: 0,
        errors: [],
      };
    }

    // pick_one mode: take only the first entity, report remaining
    const totalFound = entities.length;
    if (opts.pick_one) {
      entities = [entities[0]];
    }

    console.log(`Compiling ${entities.length} of ${totalFound} entities (mode: ${mode}${opts.pick_one ? ', pick_one' : ''})`);

    await mapWithConcurrency(
      entities,
      async (entity) => {
        try {
          await compileEntity(entity, run, opts.dry_run || false, opts.force || false);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Error compiling ${entity.canonical}: ${msg}`);
          run.error_log.push({ entity: entity.canonical, error: msg });
          if (!opts.dry_run) {
            await supabase
              .from("wiki_entities")
              .update({ status: "error", last_error: msg })
              .eq("id", entity.id);
          }
        }
      },
      MAX_CONCURRENCY
    );

    const finalStatus = run.error_log.length > 0
      ? run.error_log.length === entities.length ? "failed" : "partial"
      : "success";

    // Regenerate meta pages (skip for dry-run and single-entity runs)
    if (!opts.dry_run && !opts.entity_filter) {
      try {
        await regenerateIndex();
        await regenerateContradictionsPage(run);
      } catch (e) {
        console.error("Error regenerating meta pages:", e);
      }
    }

    await finishRun(run, finalStatus);

    const cost = (run.tokens_in * SONNET_INPUT_PRICE + run.tokens_out * SONNET_OUTPUT_PRICE) / 1_000_000;

    return {
      status: finalStatus,
      entities_touched: run.entities_touched,
      thoughts_processed: run.thoughts_processed,
      tokens_in: run.tokens_in,
      tokens_out: run.tokens_out,
      cost_usd: Math.round(cost * 10000) / 10000,
      remaining: opts.pick_one ? totalFound - entities.length : 0,
      errors: run.error_log,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run, "failed", msg);
    throw e;
  }
}

// ─── HTTP handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-brain-key",
      },
    });
  }

  if (!authenticate(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};

    const result = await compileWiki({
      force: body.force === true,
      entity_filter: body.entity_filter || undefined,
      dry_run: body.dry_run === true,
      pick_one: body.pick_one === true,
    });

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
