import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { USER_NAME, USER_TITLE, USER_EMPLOYER } from "../_shared/persona_config.ts";
import { callLLM, SYNTH_MODEL, TASK_MODEL, estimateCost, MODEL_PRICES } from "../_shared/llm.ts";
import { startJobRun, finishJobRun } from "../_shared/alert.ts";
import { matchesWholeWord } from "../_shared/text_match.ts";
import { agoLabel, cutoffDate } from "../_shared/dates.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";

const MAX_CONCURRENCY = 1;

// Supabase Edge Functions are killed at a ~150s wall clock. Sonnet generates at
// roughly 45-50 output tok/s, so the old maxTokens=8192 alone needed ~175s —
// the invocation died mid-generation, AFTER Anthropic had already billed the
// tokens, and before anything was written to wiki_compile_runs / wiki_entities /
// GitHub. Because last_compiled_at never advanced, the next cron tick picked the
// SAME entity and paid again, every 10 minutes, indefinitely. Diagnosed
// 2026-07-25: 890 runs stuck in status='running' since 2026-05-23 against 403
// successes; the half-dozen largest entities (200-300 thoughts each) could never
// complete even once.
//
// These two caps keep a single compile comfortably inside the limit. Measured:
// 17 thoughts / 2.9k out = 62s, 76 thoughts / ~5k out = 148s (the ceiling).
const MAX_OUTPUT_TOKENS = 4096;   // ~90s of generation, leaves headroom for I/O
// 60 still overran the output cap on the largest pages (measured: 60 thoughts ->
// stop_reason=max_tokens, page cut mid-sentence). Page length tracks thought
// count closely, so this is the lever that keeps generation inside the cap.
const MAX_THOUGHTS_PER_COMPILE = 35;

// Wall-clock budget tracking. Set at the top of each request so every check is
// relative to when THIS invocation started, not to module load (Edge Function
// instances are reused across requests, so a module-level timestamp would drift).
let invocationStart = Date.now();
const elapsedMs = () => Date.now() - invocationStart;
// Past this point a second full generation (the delta-regression retry) cannot
// finish before the kill, so it is skipped rather than paid for and thrown away.
const SECOND_CALL_DEADLINE_MS = 45_000;

// Фаза 21: бюджет на ЦИКЛ, а не только на второй вызов. Компиляция сущности —
// это полный проход Sonnet: начинать её, когда до предела осталось меньше её
// типичной длительности, значит гарантированно оплатить работу, которую убьют.
// Замерено на живых прогонах: 62–148с на сущность, поэтому запас крупный.
const LOOP_BUDGET_MS = 105_000;
const PER_ENTITY_MS = 60_000;

// A page is a rolling synthesis: the LLM always receives the existing page plus
// the most recent slice of thoughts, so history survives in the page text even
// though older thoughts drop out of the context window.

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
  error_count: number;
  next_retry_at: string | null;
  // Несёт либо текст ошибки, либо маркер «attempt in progress since …», который
  // пишется ПЕРЕД LLM-вызовом. По нему видно попытку, убитую по wall clock.
  last_error: string | null;
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
  const encoded = btoa(unescape(encodeURIComponent(content)));
  // SHA конфликт (409) случается, когда пользователь правит страницу в Obsidian между
  // нашим GET и PUT. Перечитываем актуальный SHA и повторяем — до 3 попыток.
  let existingSha = await getFileSha(filePath);
  let lastErr = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const body: Record<string, unknown> = {
      message,
      content: encoded,
      committer: { name: "Wiki Compiler", email: "bot@brain-wiki" },
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

    if (resp.ok) {
      const data = await resp.json();
      return data.content?.sha || "";
    }

    const errText = await resp.text();
    lastErr = `${resp.status} — ${errText}`;

    // 409 = SHA устарел; перечитываем и пробуем ещё раз. Прочие коды — фатальны.
    if (resp.status !== 409 || attempt === 3) {
      throw new Error(`GitHub PUT ${filePath}: ${lastErr}`);
    }
    console.warn(`GitHub PUT ${filePath}: 409 conflict, retry ${attempt}/3`);
    await new Promise((r) => setTimeout(r, 1500));
    existingSha = await getFileSha(filePath);
  }

  throw new Error(`GitHub PUT ${filePath}: ${lastErr}`);
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

// ─── LLM caller (delegates to shared module) ───

// Wiki compilation bills against its own Anthropic key (separate from the one
// daily-brief uses) so token consumption is visible per-feature in the
// Anthropic console. Optional: falls back to the shared ANTHROPIC_API_KEY
// in llm.ts if this one isn't set.
const WIKI_ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY_WIKI") || undefined;

async function callCompileLLM(
  systemPrompt: string,
  userMessage: string,
  model?: string,
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<{ text: string; input_tokens: number; output_tokens: number; model: string; stop_reason?: string }> {
  return callLLM({
    model: model || SYNTH_MODEL,
    system: systemPrompt,
    user: userMessage,
    maxTokens,
    maxRetries: 5,
    apiKeyOverride: WIKI_ANTHROPIC_KEY,
  });
}

// ─── Compiler system prompt ───

const COMPILER_SYSTEM_PROMPT = `Ты — Wiki Compiler для Open Brain ${USER_NAME}, ${USER_TITLE} в ${USER_EMPLOYER}.

Твоя задача — поддерживать markdown-страницы wiki, которые описывают
сущности (страны, людей, компании, топики) на основе мыслей, заметок и решений,
накопленных в базе. Это compiled view поверх Source-of-truth БД.

Главные принципы:

1. ЯЗЫК. Пользователь работает на русском. Все страницы — на русском, кроме имён собственных
   и технических терминов. Исключение: имя сущности в title может быть на английском,
   если так канонизировано.

2. ИСТОЧНИК ПРАВДЫ. Ты НЕ источник правды. БД — источник. Ты — компилятор.
   Если в БД нет данных по какому-то аспекту — пиши «нет данных», НЕ выдумывай.

3. ПРОТИВОРЕЧИЯ — НЕ СГЛАЖИВАТЬ. Если в thoughts есть позиции, которые конфликтуют
   (партнёр обещал X, потом сказал Y; HQ считает A, оперативка B; в марте было одно,
   в апреле другое), они должны быть выделены в секции «⚠️ Противоречия» с обеими
   позициями и датами. НЕ пытайся примирить, НЕ выбирай «правильную» — это сигнал
   для пользователя, не помеха.

4. PROVENANCE. Каждое нетривиальное утверждение — со ссылкой на источник в формате:
   (источник: <thought-type>, <date>, <thought-id-короткий-8-символов>). Это позволяет
   пользователю дойти до сырья.

5. РЕДАКТОРСКАЯ СТРУКТУРА. Сохраняй структуру существующей страницы (если она есть),
   обновляй только секции, в которые есть новые данные. НЕ пиши страницу с нуля
   каждый раз — это разрушает пользовательские пометки, если они были внесены.
   Блоки <!-- USER: ... --> сохраняй as-is, переноси в новую версию.

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

## Последние события
Свежие thoughts кратко, со ссылкой на тип. Границу свежести не вычисляй — она дана во входных данных.`;

// ─── Delta compiler system prompt ───

const DELTA_SYSTEM_PROMPT = `Ты — Wiki Compiler (delta mode) для Open Brain ${USER_NAME}.

Тебе даны:
1. Текущая markdown-страница wiki-сущности (ПОЛНАЯ)
2. Только НОВЫЕ thoughts (появившиеся с последней компиляции)

Твоя задача — ОБНОВИТЬ страницу, интегрируя новые thoughts.

Правила:
- НЕ переписывай страницу с нуля. Обнови только те секции, куда попадают новые данные.
- Блоки <!-- USER: ... --> сохраняй as-is.
- Сохраняй существующий provenance (ссылки на thought-id).
- Добавляй provenance для новых данных: (источник: <type>, <date>, <id-8>).
- Если новые thoughts противоречат существующим — добавь в секцию "⚠️ Противоречия".
- Обнови TL;DR если новые данные существенно меняют картину.
- Обнови "Последние события" — добавь новые, убери те, чья дата РАНЬШЕ границы свежести (она дана во входных данных). Сам возраст записей не вычисляй.
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
  deltaOnly = false,
  // Chronology mode reads the entity's ENTIRE history: no LLM call follows, so
  // neither the per-query limits (tuned to keep a prompt small) nor
  // MAX_THOUGHTS_PER_COMPILE apply. Everything else keeps the old behaviour.
  fullHistory = false,
): Promise<ThoughtContext> {
  const since = entity.last_thought_seen_at || "1970-01-01T00:00:00Z";
  const qLimit = (normal: number) => (fullHistory ? 2000 : normal);

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
        .limit(qLimit(200));

      // Also query by text mentions in metadata.people (string array)
      // for thoughts that weren't properly linked
      let mentionQuery = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .or(names.map(n => `metadata->>people.cs.{${n}}`).join(","));
      if (deltaOnly) mentionQuery = mentionQuery.gt("updated_at", filterSince);
      const { data: mentionThoughts } = await mentionQuery
        .order("updated_at", { ascending: false })
        .limit(qLimit(50));

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
        .limit(qLimit(100));

      if (data) {
        const seen = new Set(allThoughts.map(t => t.id));
        for (const t of data) {
          // ilike — грубый DB-префильтр; matchesWholeWord отсекает подстрочные ложняки.
          if (!seen.has(t.id) && matchesWholeWord(t.content, term)) {
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
        .limit(qLimit(100));

      if (data) {
        const seen = new Set(allThoughts.map(t => t.id));
        for (const t of data) {
          // ilike — грубый DB-префильтр; matchesWholeWord отсекает подстрочные ложняки.
          if (!seen.has(t.id) && matchesWholeWord(t.content, term)) {
            seen.add(t.id);
            allThoughts.push(t);
          }
        }
      }
    }
  }

  // Never let identity/banking documents reach a compiled artifact. Entity
  // attribution here is substring-based, so a note only has to MENTION the
  // employer to be pulled into its page — that is how a passport record and a
  // set of bank account details ended up in a company chronology (2026-07-25):
  // both merely cited the employer when explaining what the document was for.
  // Filtering on the flag rather than on the matched entity means it holds no
  // matter which page the thought attaches to. The thoughts stay in the DB and
  // remain reachable via search_thoughts.
  allThoughts = allThoughts.filter((t: any) => t.metadata?.sensitive !== true);

  // Sort by updated_at desc, keep max 200
  allThoughts.sort((a, b) =>
    new Date(b.updated_at || b.created_at).getTime() -
    new Date(a.updated_at || a.created_at).getTime()
  );

  // Prefer decision/insight/reflection, but no longer keep them ALL regardless of
  // the limit — an entity with 100+ decisions used to blow straight past the wall
  // clock on that exemption alone (see MAX_THOUGHTS_PER_COMPILE). Both lists are
  // already sorted newest-first, so each slice keeps the freshest of its kind.
  const critical = allThoughts.filter((t: any) =>
    ["decision", "insight", "reflection"].includes(t.metadata?.type)
  );
  const rest = allThoughts.filter((t: any) =>
    !["decision", "insight", "reflection"].includes(t.metadata?.type)
  );
  // fullHistory (chronology) keeps everything — the cap exists only to bound an
  // LLM prompt, and no LLM call follows in that mode.
  const keptCritical = fullHistory ? critical : critical.slice(0, MAX_THOUGHTS_PER_COMPILE);
  const kept = fullHistory
    ? [...critical, ...rest]
    : [
        ...keptCritical,
        ...rest.slice(0, Math.max(0, MAX_THOUGHTS_PER_COMPILE - keptCritical.length)),
      ];

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

// ─── Identifier redaction (safety net) ───

// The metadata.sensitive flag is the primary guard, but it is only as good as
// whatever set it — a new thought carrying an ID number reaches a compiled
// artifact before anything has a chance to classify it. So every thought body
// that leaves for GitHub (chronology entries) or for the LLM (compile prompts)
// gets its known identifiers masked regardless of the flag. Patterns cover a
// typical document set: Israeli Teudat Zehut, Russian passports, IBANs — add
// your own country's ID formats here. Deliberately narrow — a broad \d{9} rule would eat
// order numbers and revenue figures.
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:AE|IL|RU|GB|DE|FR|ES|IT|NL|CH|CY|KZ)\d{2}[\s-]?(?:[A-Z0-9][\s-]?){10,30}/g, "[IBAN скрыт]"],
  // Russian internal passport: "12 34 № 567890". Anchor on the NUMBER SHAPE,
  // not on a neighbouring word — an earlier version keyed off "Серия" and the
  // model then reformatted the record into a table cell that dropped the word,
  // letting the number through on the next rebuild. 2+2 digits, a № / N / No
  // separator, then exactly 6 digits is specific enough not to eat figures.
  [/\b\d{2}\s?\d{2}\s*(?:№|N°|No\.?|N)\s*\d{6}\b/gi, "[номер документа скрыт]"],
  [/((?:ת\.?ז|T\.?Z\.?|теудат\s+зеут|тевудат\s+зеут)[^0-9]{0,12})\d{9}/gi, "$1[ID скрыт]"],
];

function redactIdentifiers(text: string): string {
  let out = text;
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

// ─── Chronology mode (no LLM) ───

// A chronology is a mechanical, exhaustive dump: every thought the entity has,
// oldest first, grouped by month. Deliberately NOT an LLM synthesis — the
// synthesized page is capped by the wall clock and drops its oldest sections,
// which is exactly what makes it useless for "what happened, in order". Costs
// nothing, has no time limit, and never loses an entry.
const RU_MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function chronologyPath(entity: WikiEntity): string {
  return `chronicles/${entity.slug}.md`;
}

function buildChronology(entity: WikiEntity, context: ThoughtContext): string {
  const sorted = [...context.thoughts].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const out: string[] = [];
  out.push(`# Хронология: ${entity.canonical}`);
  out.push("");
  out.push(`> Полная выгрузка всех мыслей по сущности, от старых к новым.`);
  out.push(`> Записей: ${sorted.length}. Собрано: ${new Date().toISOString().slice(0, 10)}.`);
  out.push(`> Это механический дамп без синтеза — смысловая страница лежит в \`${entity.file_path}\`.`);
  out.push("");

  let currentMonth = "";
  for (const t of sorted) {
    const d = new Date(t.created_at);
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      out.push("");
      out.push(`## ${RU_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
      out.push("");
    }
    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const type = (t.metadata?.type as string) || "note";
    // Newlines inside a thought would break the list item; flatten them.
    const body = redactIdentifiers(t.content.replace(/\s*\n+\s*/g, " ").trim());
    out.push(`- **${day}.${month}** \`[${type}]\` ${body} <sub>${t.id.slice(0, 8)}</sub>`);
  }

  out.push("");
  return out.join("\n");
}

async function compileChronology(entityFilter: string): Promise<{
  status: string;
  entity: string;
  entries: number;
  file_path: string;
  cost_usd: number;
}> {
  const { data } = await supabase
    .from("wiki_entities")
    .select("*")
    .or(`canonical.ilike.%${entityFilter}%,slug.ilike.%${entityFilter}%`)
    .limit(1);

  const entity = (data || [])[0] as WikiEntity | undefined;
  if (!entity) throw new Error(`entity not found: ${entityFilter}`);

  const context = await loadEntityContext(entity, false, true);
  if (context.total === 0) throw new Error(`no thoughts found for ${entity.canonical}`);

  const filePath = chronologyPath(entity);
  await commitToGitHub(
    filePath,
    buildChronology(entity, context),
    `Chronology: ${entity.canonical} (${context.total} entries)`
  );

  return {
    status: "success",
    entity: entity.canonical,
    entries: context.total,
    file_path: filePath,
    cost_usd: 0,
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
  parts.push(`- Дата компиляции: ${new Date().toISOString().slice(0, 10)}`);
  // Готовая граница вместо «30 дней»: сравнить две даты модель умеет надёжно,
  // вычесть их — нет.
  parts.push(`- Граница свежести для секции «Последние события»: ${cutoffDate(30, new Date())} (всё, что раньше — убрать)`);
  parts.push(`- Давность каждой записи посчитана и указана рядом с её датой. НЕ вычисляй интервалы сам, не переводи дни в недели и месяцы; если готовой формулировки нет — не делай утверждения о сроке.\n`);

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

  const now = new Date();
  const label = isDelta ? `Новые thoughts` : `Thoughts`;
  parts.push(`## ${label} (${context.total} штук, отсортированы по дате, новые первыми)\n`);

  for (const t of context.thoughts) {
    const meta = t.metadata as Record<string, unknown>;
    const type = meta.type || "note";
    const topic = meta.topic || "";
    const date = t.created_at.slice(0, 10);
    const shortId = t.id.slice(0, 8);

    // Фаза 20: давность считает код. Прежде запись несла только голую дату, а
    // промпт требовал «убери старше 30 дней» — то есть модель вычитала даты в
    // уме по каждой записи. Ровно так бриф однажды назвал пятидневную
    // просрочку «больше двух недель» (v1.83.1).
    parts.push(`### [${type}] ${date} · ${agoLabel(t.created_at, now)} (${shortId})`);
    if (topic) parts.push(`topic: ${topic}`);
    parts.push(redactIdentifiers(t.content));
    parts.push("---");
  }

  return parts.join("\n");
}

// ─── Find touched entities ───

async function getTouchedEntities(force: boolean): Promise<WikiEntity[]> {
  // Backoff: сущности с активным окном ретрая (next_retry_at в будущем) пропускаем.
  // Целевой ретрай конкретной сущности — через entity_filter (минует getTouchedEntities).
  const nowIso = new Date().toISOString();
  const retryReady = `next_retry_at.is.null,next_retry_at.lte.${nowIso}`;

  if (force) {
    const { data, error } = await supabase
      .from("wiki_entities")
      .select("*")
      .in("status", ["pending", "active", "stale", "error"])
      .or(retryReady);
    if (error) throw new Error(`getTouchedEntities: ${error.message}`);
    return data || [];
  }

  // Incremental: find entities with thoughts newer than last compile
  // For each entity, check if there are new thoughts mentioning it
  const { data: entities, error } = await supabase
    .from("wiki_entities")
    .select("*")
    .in("status", ["pending", "active", "stale", "error"])
    .or(retryReady);

  if (error) throw new Error(`getTouchedEntities: ${error.message}`);
  if (!entities || entities.length === 0) return [];

  // Separate pending (always compile) from active (need new-thought check).
  //
  // Фаза 21: незавершённая попытка возвращается в кандидаты НАРАВНЕ с pending,
  // не дожидаясь новых мыслей. Раньше убитая по wall clock компиляция оставляла
  // маркер «attempt in progress» и backoff, но попасть в отбор снова могла
  // только если по сущности придут новые мысли — а по редко упоминаемым их может
  // не быть месяцами. Наблюдалось 26.07: две сущности застряли в «attempt in
  // progress since 17:1x», окно ретрая истекло в 17:33/17:36, и четыре
  // последующих прогона крона взяли entities_touched: 0.
  const stalledAttempt = (e: WikiEntity) =>
    typeof e.last_error === "string" && e.last_error.startsWith("attempt in progress");

  const pending = entities.filter((e) => e.status === "pending" || stalledAttempt(e));
  const active = entities.filter((e) => e.status !== "pending" && !stalledAttempt(e));

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
      // matchesWholeWord регистронезависим — терминам не нужен .toLowerCase().
      const searchTerms = [entity.canonical, ...(aliasMap.get(key) || [])];

      hasNew = relevantThoughts.some(t =>
        searchTerms.some(term => matchesWholeWord(t.content, term))
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
  errorMessage?: string,
  model?: string,
): Promise<void> {
  const prices = MODEL_PRICES[model || SYNTH_MODEL] || MODEL_PRICES[SYNTH_MODEL];
  const cost = (run.tokens_in * prices.input + run.tokens_out * prices.output) / 1_000_000;
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
    const e: Promise<void> = p.then(() => { executing.delete(e); });
    executing.add(e);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

// ─── Page-structure helpers (quality checks + contradictions cache) ───

// Body of the "## ⚠️ Противоречия" section (without its header), or "" when the
// page has none / a trivially short one. Shared by the contradictions-page
// regen and the per-entity cache write in compileEntity.
function extractContradictionsSection(page: string): string {
  const m = page.match(/## ⚠️ Противоречия[\s\S]*?(?=\n## |$)/);
  if (m && m[0].trim().split("\n").length > 2) {
    return m[0].replace("## ⚠️ Противоречия", "").trim();
  }
  return "";
}

// Level-2 headings present in a page (text only), for delta regression checks.
function pageHeadings(md: string): string[] {
  return (md.match(/^##\s+.+$/gm) || []).map((h) => h.replace(/^##\s+/, "").trim());
}

// A delta recompile edits the existing page in place; if the model dropped
// headings or collapsed the page to a fraction of its prior size, it likely
// mangled it. Returns a reason string when the delta output looks regressed
// (caller should fall back to a full recompile), else null.
function deltaRegression(before: string, after: string): string | null {
  const lost = pageHeadings(before).filter((h) => !pageHeadings(after).includes(h));
  if (lost.length > 0) return `lost ${lost.length} heading(s): ${lost.slice(0, 3).join(", ")}`;
  const a = after.trim().length, b = before.trim().length;
  if (b > 0 && a < b * 0.5) return `length ${a} < 50% of prior ${b}`;
  return null;
}

// ─── Contradictions page ───

async function regenerateContradictionsPage(run: CompileRun): Promise<void> {
  // Pull each entity's contradictions section from the DB cache (populated by
  // compileEntity). Cold rows (contradictions_md IS NULL) are backfilled with a
  // one-time GitHub GET, so steady-state runs make ZERO GitHub GETs here — the
  // nightly pick_one compile fires this every ~10 min, and the old per-entity
  // GET loop was the dominant GitHub-call cost.
  const { data: entities } = await supabase
    .from("wiki_entities")
    .select("id, canonical, entity_type, file_path, slug, contradictions_md")
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
    let section = e.contradictions_md as string | null;
    if (section === null || section === undefined) {
      const page = await getFileContent(e.file_path);
      section = page ? extractContradictionsSection(page) : "";
      await supabase.from("wiki_entities").update({ contradictions_md: section }).eq("id", e.id);
    }
    if (section && section.trim()) {
      lines.push(`## [[${e.slug}]] (${e.canonical})`);
      lines.push(section.trim());
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
  // Redacted on the way in as well, so the model never sees an identifier it
  // could paraphrase past the output filter.
  const existingPageRaw = dryRun ? null : await getFileContent(entity.file_path);
  const existingPage = existingPageRaw === null ? null : redactIdentifiers(existingPageRaw);
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

  // Claim the attempt BEFORE spending money. If this invocation is killed
  // mid-generation (wall clock), nothing downstream of the LLM call ever runs —
  // no run row, no wiki_entities update, no GitHub commit — so without this the
  // entity looked untouched and the next tick paid for it again, forever. Writing
  // the backoff up front means a killed attempt still costs the entity its retry
  // slot, and repeated kills widen the window instead of hammering every 10 min.
  // Cleared on success below, so a healthy entity is unaffected.
  const attemptCount = (entity.error_count ?? 0) + 1;
  const attemptBackoffMin = Math.min(Math.pow(2, attemptCount) * 10, 6 * 60);
  await supabase
    .from("wiki_entities")
    .update({
      error_count: attemptCount,
      next_retry_at: new Date(Date.now() + attemptBackoffMin * 60_000).toISOString(),
      last_error: `attempt in progress since ${new Date().toISOString()}`,
    })
    .eq("id", entity.id);

  let result = await callCompileLLM(systemPrompt, prompt);

  // Quality gate: a delta build rewrites the existing page from a small diff; if
  // it dropped headings or shrank the page drastically, the model mangled it.
  // Recompile in full mode (from all thoughts) and use that instead — precision
  // over speed, a mangled page is worse than an extra LLM call.
  // Skipped when the first call already ate most of the wall clock: a second
  // full generation would be killed anyway, wasting its tokens and losing the
  // usable (if imperfect) page we already have.
  if (isDelta && existingPage && elapsedMs() < SECOND_CALL_DEADLINE_MS) {
    const regression = deltaRegression(existingPage, result.text);
    if (regression) {
      console.warn(`[quality] delta regressed for ${entity.canonical} (${regression}) — full recompile`);
      context = await loadEntityContext(entity, false);
      const fullPrompt = buildCompilerPrompt(entity, context, existingPage, false);
      // The discarded first call was still billed — bank its tokens before
      // overwriting `result`, otherwise the run under-reports its real cost.
      run.tokens_in += result.input_tokens;
      run.tokens_out += result.output_tokens;
      result = await callCompileLLM(COMPILER_SYSTEM_PROMPT, fullPrompt);
      isDelta = false;
    }
  }

  // A max_tokens stop means the page is cut mid-sentence. Committing that
  // verbatim corrupts the wiki (observed on the largest entity: the page ended
  // "…должность"). Trim back to the last complete section instead — a slightly
  // short but well-formed page beats a truncated one, and the dropped sections
  // are the oldest entries, which the next compile will re-emit.
  // Redact the OUTPUT, not just the thoughts feeding the prompt: a delta compile
  // hands the model the existing page and it copies content forward verbatim, so
  // an identifier already committed by an earlier build survives every later
  // rebuild unless it is stripped here (observed on a personal-documents page, which
  // still carried passport numbers after a full recompile).
  let pageText = redactIdentifiers(result.text);
  if (result.stop_reason === "max_tokens") {
    // Look for BOTH heading levels. The old code searched only "\n### ", but
    // COMPILER_SYSTEM_PROMPT asks for "## " sections (TL;DR, Контекст, Ключевые
    // решения…) — "### " appears in the INPUT context that feeds thought entries
    // to the model, not in the page it writes back. So on any page where the
    // model emitted no sub-headings the trim found nothing and threw, and the
    // entity could never compile again: error_count grew, backoff spaced the
    // retries out, and every one of them still paid Sonnet in full for output
    // that was discarded. Observed on two large entities on 2026-07-26.
    const lastH3 = pageText.lastIndexOf("\n### ");
    const lastH2 = pageText.lastIndexOf("\n## ");
    const cut = Math.max(lastH3, lastH2);

    // A trim that leaves almost nothing is not a page. Better to fail loudly and
    // keep the previous version than to commit a stub over a good page.
    const MIN_KEPT = 400;
    if (cut > MIN_KEPT) {
      const level = cut === lastH3 ? "###" : "##";
      pageText = pageText.slice(0, cut).trimEnd() + "\n";
      console.warn(
        `[quality] ${entity.canonical}: output hit max_tokens — trimmed to last complete ${level} section (${pageText.length} chars kept)`,
      );
    } else {
      throw new Error(
        `output truncated at max_tokens and nothing usable to trim to ` +
          `(page ${pageText.length} chars, last ## at ${lastH2}, last ### at ${lastH3})`,
      );
    }
  }

  // For delta, also count total thoughts (existing page's count + new)
  const totalThoughts = isDelta
    ? entity.thoughts_count + context.total
    : context.total;

  const sha = await commitToGitHub(
    entity.file_path,
    pageText,
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
      error_count: 0,
      next_retry_at: null,
      contradictions_md: extractContradictionsSection(pageText),
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

    // Фаза 21: сколько сущностей начинать — решает ЧАСЫ, а не длина списка.
    // Прежде цикл шёл по всем найденным и упирался в убийство по wall clock на
    // середине очередной компиляции: токены уже оплачены, страница не записана.
    // Теперь перед каждой сущностью спрашиваем, успеет ли она; не успевающие
    // остаются в кандидатах и достаются следующему прогону.
    let deferredOnBudget = 0;

    await mapWithConcurrency(
      entities,
      async (entity) => {
        if (elapsedMs() + PER_ENTITY_MS > LOOP_BUDGET_MS) {
          deferredOnBudget++;
          return;
        }
        try {
          await compileEntity(entity, run, opts.dry_run || false, opts.force || false);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Error compiling ${entity.canonical}: ${msg}`);
          run.error_log.push({ entity: entity.canonical, error: msg });
          if (!opts.dry_run) {
            // Backoff: 2^n * 10 минут, потолок 6 часов. Так error-сущность
            // (напр. транзиентный 529 от Anthropic) не ретраится каждые 10 минут.
            const errorCount = (entity.error_count ?? 0) + 1;
            const backoffMin = Math.min(Math.pow(2, errorCount) * 10, 6 * 60);
            const nextRetryAt = new Date(Date.now() + backoffMin * 60_000).toISOString();
            await supabase
              .from("wiki_entities")
              .update({
                status: "error",
                last_error: msg,
                error_count: errorCount,
                next_retry_at: nextRetryAt,
              })
              .eq("id", entity.id);
          }
        }
      },
      MAX_CONCURRENCY
    );

    if (deferredOnBudget > 0) {
      console.log(`[budget] отложено сущностей до следующего прогона: ${deferredOnBudget} (прошло ${Math.round(elapsedMs() / 1000)}с)`);
    }

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

    await finishRun(run, finalStatus, undefined, SYNTH_MODEL);

    const cost = estimateCost(SYNTH_MODEL, run.tokens_in, run.tokens_out);

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

// ─── Lint mode ───

const LINT_SYSTEM_PROMPT = `Ты — Wiki Linter для Open Brain. Анализируешь wiki-страницы и находишь проблемы.

Задачи:
1. ПРОТИВОРЕЧИЯ — факты, которые конфликтуют между страницами или внутри одной страницы.
2. СЛЕПЫЕ ЗОНЫ — имена людей, компании или темы, часто упоминаемые в thoughts, но без wiki-страницы.
3. УСТАРЕВШИЕ ДАННЫЕ — факты с пометкой "по состоянию на", чья дата РАНЬШЕ границы устаревания (она дана во входных данных). Возраст фактов сам не вычисляй.
4. БИТЫЕ ССЫЛКИ — [[slug]], которые указывают на несуществующие страницы.
5. НОВЫЕ СВЯЗИ — потенциально интересные связи между сущностями, которые не отражены.

Отвечай строго JSON:
{
  "contradictions": [{"entities": ["slug1", "slug2"], "description": "...", "severity": "high"|"medium"|"low"}],
  "blind_spots": [{"name": "...", "mention_count": N, "suggested_type": "person"|"company"|"topic"|"country"}],
  "stale_data": [{"entity": "slug", "fact": "...", "last_date": "YYYY-MM-DD"}],
  "broken_links": [{"from": "slug", "to": "slug"}],
  "new_connections": [{"entities": ["slug1", "slug2"], "reason": "..."}],
  "summary": "1-2 предложения общего здоровья wiki"
}`;

interface LintResult {
  contradictions: Array<{ entities: string[]; description: string; severity: string }>;
  blind_spots: Array<{ name: string; mention_count: number; suggested_type: string }>;
  stale_data: Array<{ entity: string; fact: string; last_date: string }>;
  broken_links: Array<{ from: string; to: string }>;
  new_connections: Array<{ entities: string[]; reason: string }>;
  summary: string;
}

async function lintWiki(): Promise<{
  lint: LintResult;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
}> {
  // Load all active wiki entities
  const { data: entities } = await supabase
    .from("wiki_entities")
    .select("canonical, entity_type, slug, file_path, thoughts_count, status")
    .in("status", ["active", "stale"]);

  if (!entities || entities.length === 0) {
    throw new Error("No wiki entities to lint");
  }

  const existingSlugs = new Set(entities.map(e => e.slug));

  // Load all wiki pages from GitHub
  const pages: string[] = [];
  for (const e of entities) {
    const content = await getFileContent(e.file_path);
    if (content) {
      pages.push(`=== ${e.slug} (${e.entity_type}: ${e.canonical}) ===\n${content}\n`);
    }
  }

  // Load recent thoughts to find blind spots
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { data: recentThoughts } = await supabase
    .from("thoughts")
    .select("content, metadata")
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: false })
    .limit(200);

  // Extract frequently mentioned names not in wiki
  const mentionedPeople = new Map<string, number>();
  for (const t of recentThoughts || []) {
    const people = (t.metadata as Record<string, unknown>)?.people as string[] || [];
    for (const p of people) {
      mentionedPeople.set(p, (mentionedPeople.get(p) || 0) + 1);
    }
  }

  const untracked = [...mentionedPeople.entries()]
    .filter(([name, count]) => count >= 3 && !entities.some(e => e.canonical === name))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  const untrackedSection = untracked.length > 0
    ? `\n\nЧасто упоминаемые, но без wiki-страницы:\n${untracked.map(([n, c]) => `- ${n} (${c} упоминаний)`).join("\n")}`
    : "";

  const existingSlugsSection = `\nСуществующие slugs: ${[...existingSlugs].join(", ")}`;

  // Фаза 20: граница вместо «3 месяца назад». Сравнить дату с готовой границей
  // модель умеет надёжно; вычесть три месяца от сегодня — уже арифметика,
  // которую она делает молча и иногда неверно.
  const userPrompt = `Проанализируй wiki-страницы и найди проблемы.

Сегодня: ${cutoffDate(0, new Date())}
Граница устаревания: ${cutoffDate(90, new Date())} — факты с датой раньше считаются устаревшими.

${pages.join("\n")}
${existingSlugsSection}
${untrackedSection}`;

  const result = await callCompileLLM(LINT_SYSTEM_PROMPT, userPrompt, TASK_MODEL, 4096);

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse lint response");

  const lint = JSON.parse(jsonMatch[0]) as LintResult;
  const cost = estimateCost(TASK_MODEL, result.input_tokens, result.output_tokens);

  return {
    lint,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
    cost_usd: Math.round(cost * 10000) / 10000,
    model: TASK_MODEL,
  };
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

  invocationStart = Date.now();

  // Job-run recording is scoped to the compile path (set on startJobRun below);
  // lint mode and early errors leave it null so they don't touch job_runs.
  let runId: string | null = null;
  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};

    // Chronology mode — on-demand, no LLM, no job-run tracking (nothing to bill
    // or alert on). Requires an explicit entity: a full-history dump only makes
    // sense for one entity at a time.
    if (body.mode === "chronology") {
      if (!body.entity_filter) {
        return new Response(JSON.stringify({ error: "chronology mode requires entity_filter" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await compileChronology(String(body.entity_filter));
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Lint mode — separate path, not a tracked nightly job.
    if (body.mode === "lint") {
      const result = await lintWiki();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    runId = await startJobRun(supabase, "compile-wiki", { pick_one: body.pick_one === true });

    const result = await compileWiki({
      force: body.force === true,
      entity_filter: body.entity_filter || undefined,
      dry_run: body.dry_run === true,
      pick_one: body.pick_one === true,
    });

    // status from compileWiki: success | partial | failed.
    // Alert only on a wholesale "failed"; "partial" (one flaky entity) is left to
    // Phase 8's per-entity backoff and would otherwise spam the every-10-min cron.
    const jobStatus = result.status === "failed" ? "error" : result.status === "partial" ? "partial" : "success";
    await finishJobRun(supabase, {
      runId, job: "compile-wiki", status: jobStatus as "success" | "partial" | "error",
      error: result.status === "failed" ? `failed: ${JSON.stringify(result.errors).slice(0, 2000)}` : undefined,
      details: { entities_touched: result.entities_touched, errors: result.errors?.length ?? 0 },
      alert: result.status === "failed",
    });

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await finishJobRun(supabase, { runId, job: "compile-wiki", status: "error", error: msg });
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
