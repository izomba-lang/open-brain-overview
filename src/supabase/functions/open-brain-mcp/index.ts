import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { TOPIC_RULES, lintTopic, autocorrectTopic, sanitizeTopic } from "../_shared/topic_prompt.ts";
import { parseIntent } from "../_shared/voice/intent.ts";

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// --- Helpers ---

/**
 * Normalize a name for alias lookup: lowercase, trim, ё→е, collapse whitespace.
 * Russian morphology and transliteration are NOT auto-handled — covered by
 * explicit alias rows added via manage_alias.
 */
export function normalizeAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

/**
 * Attempt to reduce a Russian surname to its nominative (dictionary) form
 * by stripping common case suffixes. NOT full morphology — just the most
 * frequent patterns for -ский/-цкий/-ский/-ный/-вый/-ой/-ий/-ый adjective-style
 * surnames, plus -ов/-ев/-ин patronymic-style ones.
 *
 * Returns an array of candidate stems (may be empty if no rule matched).
 * The caller should try each as an alias lookup.
 */
export function russianSurnameCandidates(normalized: string): string[] {
  // Each rule: [regex matching inflected suffix, replacement for nominative]
  const rules: [RegExp, string][] = [
    // -ский/-цкий style: Горецкому→Горецкий, Горецким→Горецкий, Горецкого→Горецкий
    [/([стц]к)(ому|им|ого|ом|ую)$/, "$1ий"],
    [/([стц]к)(ой)$/, "$1ой"],   // -ской stays -ской (Донской→Донской)
    // -ный/-вый/-жий/-ший: Главному→Главный
    [/(н|в|ж|ш)(ому|ым|ого|ом|ую)$/, "$1ый"],
    [/(н|в|ж|ш)(ему|им|его|ем)$/, "$1ий"],
    // -ов/-ев style: Петрову→Петров, Петровым→Петров, Петрова→Петров
    [/(ов|ев)(у|ым|а|ой|ом)$/, "$1"],
    // -ин style: Ельцину→Ельцин, Ельциным→Ельцин, Ельцина→Ельцин
    [/(ин)(у|ым|а|ой|ом|е)$/, "$1"],
  ];
  const candidates: string[] = [];
  for (const [re, repl] of rules) {
    if (re.test(normalized)) {
      candidates.push(normalized.replace(re, repl));
    }
  }
  return [...new Set(candidates)];
}

/**
 * Find person by alias map → fuzzy name match (pg_trgm + ILIKE), or create new.
 * Alias map handles short forms ("Соловьёв"), morphology ("Ильёй"),
 * and transliteration ("Akshya"/"Aakshya") that fuzzy match misses.
 */
// Common Russian/English nouns that LLM sometimes mis-classifies as person names.
// Filtered out before alias lookup so "юрист", "адвокат" etc. don't become orphan cards.
const COMMON_NOUNS = new Set([
  "юрист", "адвокат", "врач", "доктор", "партнер", "партнёр",
  "директор", "сотрудник", "клиент", "инвестор", "поставщик",
  "менеджер", "коллега", "босс", "руководитель", "ассистент",
  "коллеги", "партнеры", "партнёры", "юристы", "адвокаты", "клиенты",
  "lawyer", "advocate", "manager", "director", "partner", "client",
  "colleague", "boss", "doctor", "investor", "supplier",
]);

const HEBREW_RANGE = /[֐-׿]/;

/**
 * Filter strings that the LLM extracted into `people` but aren't actually person names:
 *   - common profession nouns (юрист, адвокат, manager, ...)
 *   - very short Hebrew tokens (< 4 chars — "עיליה" is fine, "עמ" is not)
 *   - 1-2 char garbage
 */
const ORG_SUFFIXES_RE = /\b(ltd|llc|inc|gmbh|corp|group|plc|co\b|ооо|ип|зао|оао|пао)\b\.?/i;

function isLikelyPersonName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return false;
  if (COMMON_NOUNS.has(trimmed.toLowerCase())) return false;
  if (HEBREW_RANGE.test(trimmed) && trimmed.replace(/\s/g, "").length < 4) return false;
  if (ORG_SUFFIXES_RE.test(trimmed)) return false;
  return true;
}

/**
 * Resolve a name → canonical person UUID. Returns null when the input doesn't
 * look like a person name (filtered out) so the caller can skip linking.
 *
 * Optional `role` and `org` populate the new card on creation only — they
 * never overwrite an existing card's fields. Lets nightly-dream's enrichment
 * step skip cards that arrived with role/org already set on ingest.
 *
 * Pipeline:
 *   0. Filter common nouns / too-short Hebrew / garbage
 *   1. Alias hit (person_aliases table) — exact normalized match
 *   2. Fuzzy match via pg_trgm — but ONLY for unambiguous names
 *      (multi-word OR ≥ 8 chars). Short single-word names like "Сергей"
 *      are too ambiguous for fuzzy fallback — they'd attach to whatever
 *      Сергей happens to be first in the table, regardless of context.
 *      In that case we create a fresh orphan, which nightly-dream can
 *      then merge + alias when context is clearer.
 *   3. Create new person card (with role/org if provided).
 */
async function findOrCreatePerson(
  name: string,
  area: string = "work",
  role?: string,
  org?: string,
): Promise<string | null> {
  const trimmedName = name.trim();
  if (!trimmedName) return null;

  // 0. Filter
  if (!isLikelyPersonName(trimmedName)) {
    console.log(`[people] Filtered "${trimmedName}" — common noun or non-name token`);
    return null;
  }

  // 1. Alias hit — exact normalized match wins immediately
  const normalized = normalizeAlias(trimmedName);
  const { data: alias } = await supabase
    .from("person_aliases")
    .select("person_id")
    .eq("alias_normalized", normalized)
    .maybeSingle();
  if (alias?.person_id) {
    console.log(`[people] "${trimmedName}" matched alias → ${alias.person_id}`);
    return alias.person_id as string;
  }

  // 1b. Morphological fallback — try stemmed surname candidates
  // Handles inflected forms: "Горецкому"→"горецкий", "Петрова"→"петров"
  // Applied per-word so "Владимиру Горецкому" tries stems of each word
  const words = normalized.split(" ");
  if (words.length >= 1) {
    // Generate all stem combos for multi-word names (usually 2 words max)
    const wordCandidates = words.map((w) => {
      const stems = russianSurnameCandidates(w);
      return stems.length > 0 ? [w, ...stems] : [w];
    });
    // Build candidate normalized names from stem combinations
    const stemCandidates: string[] = [];
    if (wordCandidates.length === 1) {
      for (const s of wordCandidates[0]) {
        if (s !== normalized) stemCandidates.push(s);
      }
    } else if (wordCandidates.length === 2) {
      for (const a of wordCandidates[0]) {
        for (const b of wordCandidates[1]) {
          const candidate = `${a} ${b}`;
          if (candidate !== normalized) stemCandidates.push(candidate);
        }
      }
    }
    if (stemCandidates.length > 0) {
      const { data: stemAlias } = await supabase
        .from("person_aliases")
        .select("person_id, alias_normalized")
        .in("alias_normalized", stemCandidates)
        .limit(1)
        .maybeSingle();
      if (stemAlias?.person_id) {
        console.log(`[people] "${trimmedName}" matched via stem "${stemAlias.alias_normalized}" → ${stemAlias.person_id}`);
        return stemAlias.person_id as string;
      }
    }
  }

  // 2. Fuzzy fallback — skip for ambiguous short single-word names to avoid
  // wrong-canon attachment (logged 06.05: "Сергей" in Литва-thought went to
  // Сергей Сафарян instead of Сергей Артёмов).
  const isAmbiguousShort = !trimmedName.includes(" ") && trimmedName.length < 8;
  if (!isAmbiguousShort) {
    const { data: similar, error: rpcError } = await supabase
      .rpc("find_similar_person", {
        search_name: trimmedName,
        min_similarity: 0.4,
      });

    if (!rpcError && similar && similar.length > 0) {
      console.log(
        `[people] "${trimmedName}" matched existing "${similar[0].name}" (sim=${similar[0].sim.toFixed(2)})`
      );
      return similar[0].id as string;
    }
  } else {
    console.log(`[people] "${trimmedName}" — ambiguous short name, skipping fuzzy fallback (will create orphan)`);
  }

  // 3. No match — create new person, populate role/org if provided
  const insertRow: Record<string, unknown> = { name: trimmedName, area, metadata: {} };
  if (role && role !== "null") insertRow.role = role;
  if (org && org !== "null") insertRow.organization = org;
  const { data: newPerson, error: insertError } = await supabase
    .from("people")
    .insert(insertRow)
    .select("id")
    .single();

  if (insertError) throw insertError;
  console.log(`[people] Created new person "${trimmedName}"${role ? ` role="${role}"` : ""}${org ? ` org="${org}"` : ""}`);
  return newPerson.id as string;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });

  if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractMetadata(text: string) {
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Extract metadata from this text. Return ONLY valid JSON:
{
  "type": "idea|task|reflection|note|question|event|decision|insight",
  "topic": "namespace/subtopic[-DD-MM]",
  "people": [{"name": "...", "role": "...|null", "org": "...|null"}],
  "sentiment": "positive|neutral|negative",
  "area": "work|personal|health|finance|learning|social",
  "deadline": "YYYY-MM-DD or YYYY-MM-DDTHH:mm or null",
  "document_date": "YYYY-MM-DD or null",
  "is_correction": true/false
}

Rules for "is_correction":
- true ONLY when the text is explicitly correcting, amending, or updating a previous statement: "поправка", "уточнение", "на самом деле", "correction", "не X а Y", "ошибся — правильно", "обновление к", "апдейт по"
- false for normal thoughts, even if they reference past events or add new information
- When in doubt, return false

Rules for "people":
- Each entry is an object: {"name": "Имя", "role": "роль или null", "org": "компания или null"}.
- "name" — full name as it appears, OR a short form / nickname / падеж that you saw. Don't invent the canonical form.
- "role" — extract from text only if EXPLICITLY stated ("Megh — head of franchising in Apparel", "Юра нанят как general assistant"). null if not in text.
- "org" — same: extract from text only if explicitly stated. null if just a name without affiliation.
- DO NOT include common profession nouns ("юрист", "адвокат", "manager") as standalone person entries.
- DO NOT include single Hebrew tokens shorter than 4 characters.
- DO NOT include organization/company names as person entries. Names containing "Ltd", "LLC", "Inc", "GmbH", "ООО", "ИП", "Corp", "Group", "бренд" or ending with known company suffixes are organizations, not people. Put them in "org" field of related person entries instead.

Rules for "topic":
${TOPIC_RULES}

Rules for "type":
- note: financial notifications, card transactions, receipts, bank alerts, expense reports — ALWAYS "note", even if a follow-up action is implied
- task: only explicit assignments, to-dos, "need to do X", "don't forget Y" — the text must contain a clear call to action
- event: meetings, trips, travel records (factual)
- All other types: use based on content meaning

Rules for "area":
- work: anything related to job, projects, colleagues, meetings, Dodo Brands
- personal: home, family, personal goals, hobbies
- health: exercise, sleep, diet, medical
- finance: money, budget, investments, expenses
- learning: courses, books, skills, education
- social: friends, events, networking

Rules for "deadline":
- ONLY for type "task": extract an explicit actionable deadline — "сделать до пятницы", "напомнить 5 апреля", "дедлайн 15 мая"
- Convert relative dates to absolute using today = ${new Date().toISOString().slice(0, 10)}
- For types note/reflection/event/decision/insight: ALWAYS return null. Documents, meeting notes, advisor logs, and financial records do NOT have deadlines
- A date mentioned in a document (issue date, signature date, period start/end) is NOT a deadline — put it in "document_date" instead
- If no actionable deadline is mentioned, return null

Rules for "document_date":
- The primary date of the document or event described in the text: issue date, signature date, meeting date, transaction date
- Examples: "полис от 14.05.2025" → "2025-05-14", "подписана 05.05.2026" → "2026-05-05", "встреча 8 мая" → "2026-05-08"
- If no document date is present, return null

Text: ${text}`,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`Metadata extraction failed: ${await res.text()}`);
  const data = await res.json();
  let parsed: { type?: string; topic?: string; people?: string[]; sentiment?: string; area?: string; deadline?: string | null; document_date?: string | null; is_correction?: boolean };
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    parsed = { type: "note", topic: "", people: [], sentiment: "neutral" };
  }
  parsed.topic = sanitizeTopic(parsed.topic);
  const warning = lintTopic(parsed.topic);
  if (warning) {
    const fixed = autocorrectTopic(parsed.topic, parsed.area);
    console.warn(`[topic][autocorrect] "${parsed.topic}" → "${fixed}" (${warning}) — content="${text.slice(0, 80)}"`);
    parsed.topic = fixed;
  }
  return parsed;
}

// (используется и authenticate ниже, и handleVoiceCall выше — поэтому тоже Deno.env)
function authenticate(req: Request): boolean {
  const expectedKey = Deno.env.get("MCP_ACCESS_KEY");
  if (!expectedKey) return false;

  const headerKey = req.headers.get("x-brain-key");
  if (headerKey === expectedKey) return true;

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey === expectedKey) return true;

  return false;
}

// --- MCP Tool Handlers ---

async function handleSearchThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      query: z.string(),
      threshold: z.coerce.number().default(0.5),
      limit: z.coerce.number().default(10),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      area: z.string().optional(),
      source: z.string().optional(),
    })
    .parse(params);

  const queryEmbedding = await generateEmbedding(input.query);

  // Fetch more results when filtering, so post-filter has enough candidates
  const fetchCount = (input.type || input.topic || input.person || input.area || input.source)
    ? input.limit * 3
    : input.limit;

  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: queryEmbedding,
    match_threshold: input.threshold,
    match_count: fetchCount,
  });

  if (error) throw new Error(error.message);

  let results = (data || []).map(
    (row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number; due_date: string | null }) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      similarity: row.similarity,
      due_date: row.due_date,
    })
  );

  // Post-filter by metadata fields
  if (input.type) results = results.filter((r: { metadata: Record<string, unknown> }) => r.metadata?.type === input.type);
  if (input.topic) results = results.filter((r: { metadata: Record<string, unknown> }) => String(r.metadata?.topic || "").toLowerCase().includes(input.topic!.toLowerCase()));
  if (input.person) results = results.filter((r: { metadata: Record<string, unknown> }) => Array.isArray(r.metadata?.people) && (r.metadata.people as string[]).includes(input.person!));
  if (input.area) results = results.filter((r: { metadata: Record<string, unknown> }) => r.metadata?.area === input.area);
  if (input.source) results = results.filter((r: { metadata: Record<string, unknown> }) => r.metadata?.source === input.source);

  return results.slice(0, input.limit);
}

async function handleListThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      limit: z.coerce.number().default(20),
      offset: z.coerce.number().default(0),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      days: z.coerce.number().optional(),
      area: z.string().optional(),
      source: z.string().optional(),
      deadline_before: z.string().optional(),
      deadline_after: z.string().optional(),
      overdue: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
      has_deadline: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
    })
    .parse(params);

  let query = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at, due_date")
    .order("created_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (input.type) {
    query = query.eq("metadata->>type", input.type);
  }
  if (input.topic) {
    query = query.ilike("metadata->>topic", `%${input.topic}%`);
  }
  if (input.person) {
    query = query.contains("metadata", { people: [input.person] });
  }
  if (input.days) {
    const since = new Date();
    since.setDate(since.getDate() - input.days);
    query = query.gte("created_at", since.toISOString());
  }
  if (input.area) {
    query = query.eq("metadata->>area", input.area);
  }
  if (input.source) {
    query = query.eq("metadata->>source", input.source);
  }
  if (input.deadline_before) {
    query = query.lte("due_date", input.deadline_before);
  }
  if (input.deadline_after) {
    query = query.gte("due_date", input.deadline_after);
  }
  if (input.overdue) {
    query = query.lt("due_date", new Date().toISOString())
      .or("metadata->>status.is.null,metadata->>status.neq.done");
  }
  if (input.has_deadline) {
    query = query.not("due_date", "is", null);
  }
  if ((input as Record<string, unknown>).status) {
    query = query.eq("metadata->>status", (input as Record<string, unknown>).status as string);
  } else if ((input as Record<string, unknown>).hide_done) {
    query = query.or("metadata->>status.is.null,metadata->>status.neq.done");
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function handleThoughtStats() {
  const { data, error } = await supabase
    .from("thoughts")
    .select("metadata, created_at, due_date");

  if (error) throw new Error(error.message);

  const rows = data || [];
  const typeCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  const peopleCounts: Record<string, number> = {};
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  let last7 = 0;
  let overdueCount = 0;
  let upcomingCount = 0;
  const now = new Date();
  const threeDaysLater = new Date();
  threeDaysLater.setDate(now.getDate() + 3);

  for (const row of rows) {
    const meta = row.metadata || {};
    if (meta.type) typeCounts[meta.type] = (typeCounts[meta.type] || 0) + 1;
    if (meta.topic) topicCounts[meta.topic] = (topicCounts[meta.topic] || 0) + 1;
    if (meta.people) {
      for (const p of meta.people) {
        peopleCounts[p] = (peopleCounts[p] || 0) + 1;
      }
    }
    if (new Date(row.created_at) >= sevenDaysAgo) last7++;
    if (row.due_date) {
      const due = new Date(row.due_date);
      const status = meta.status;
      if (due < now && status !== "done") overdueCount++;
      if (due >= now && due <= threeDaysLater && status !== "done") upcomingCount++;
    }
  }

  return {
    total: rows.length,
    types: typeCounts,
    top_topics: Object.entries(topicCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([t, c]) => ({ topic: t, count: c })),
    top_people: Object.entries(peopleCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([p, c]) => ({ person: p, count: c })),
    last_7_days: last7,
    overdue_tasks: overdueCount,
    upcoming_deadlines_3d: upcomingCount,
  };
}

async function handleCaptureThought(params: Record<string, unknown>) {
  const input = z
    .object({
      content: z.string().min(1),
      type: z.string().optional(),
      topic: z.string().optional(),
      source: z.string().optional(),
      project: z.string().optional(),
      deadline: z.string().optional(),
    })
    .parse(params);

  const [embedding, metadata] = await Promise.all([
    generateEmbedding(input.content),
    extractMetadata(input.content),
  ]);

  const isCorrection = (metadata as { is_correction?: boolean }).is_correction === true;
  delete (metadata as { is_correction?: unknown }).is_correction;

  // --- Correction auto-merge: append to original instead of creating new thought ---
  if (isCorrection && embedding) {
    try {
      const { data: candidates } = await supabase.rpc("match_thoughts", {
        query_embedding: embedding,
        match_threshold: 0.85,
        match_count: 3,
      });
      const original = (candidates || []).find(
        (r: { id: string; similarity: number }) => r.similarity >= 0.85
      );
      if (original) {
        const { data: orig } = await supabase
          .from("thoughts")
          .select("id, content, metadata, due_date")
          .eq("id", original.id)
          .single();
        if (orig) {
          const dd = String(new Date().getUTCDate()).padStart(2, "0");
          const mm = String(new Date().getUTCMonth() + 1).padStart(2, "0");
          const mergedContent = `${orig.content}\n\n[correction ${dd}-${mm}] ${input.content}`;
          const newEmbedding = await generateEmbedding(mergedContent);
          const corrections = (orig.metadata?.corrections as string[] || []);
          corrections.push(`${dd}-${mm}: ${input.content.slice(0, 200)}`);
          const updatedMeta = { ...orig.metadata, corrections };

          const { data: updated, error: upErr } = await supabase
            .from("thoughts")
            .update({
              content: mergedContent,
              embedding: newEmbedding,
              metadata: updatedMeta,
            })
            .eq("id", orig.id)
            .select("id, content, metadata, created_at, due_date");

          if (upErr) throw new Error(upErr.message);
          console.log(`[correction] Merged into ${orig.id}: "${input.content.slice(0, 60)}"`);
          return { success: true, merged_into: orig.id, thought: updated?.[0] };
        }
      }
    } catch (err) {
      console.warn(`[correction] Auto-merge failed, falling back to new thought:`, err);
    }
  }

  // --- Normal capture flow ---

  // Resolve due_date: explicit caller deadline > LLM-extracted deadline > null
  // document_date stays in metadata as-is (it's not a deadline)
  const dueDate = input.deadline || metadata.deadline || null;
  delete metadata.deadline;

  // Normalize metadata.people. LLM may return strings OR {name, role, org}
  // objects (post-v1.8.0 prompt). Keep richer entries for findOrCreatePerson
  // below, but rewrite metadata.people as string[] so the stored thought stays
  // backward-compatible with search/list/correlate consumers.
  type PersonEntry = { name: string; role?: string; org?: string };
  const rawPeople: unknown[] = (metadata as { people?: unknown[] }).people || [];
  const peopleEntries: PersonEntry[] = rawPeople
    .map((entry: unknown): PersonEntry | null => {
      if (typeof entry === "string") return { name: entry.trim() };
      if (entry && typeof entry === "object" && "name" in entry && typeof (entry as { name: unknown }).name === "string") {
        const e = entry as { name: string; role?: unknown; org?: unknown; organization?: unknown };
        return {
          name: e.name.trim(),
          role: typeof e.role === "string" && e.role.trim() ? e.role.trim() : undefined,
          org:
            typeof e.org === "string" && e.org.trim()
              ? e.org.trim()
              : typeof e.organization === "string" && e.organization.trim()
                ? e.organization.trim()
                : undefined,
        };
      }
      return null;
    })
    .filter((p): p is PersonEntry => p !== null && p.name.length >= 2);
  (metadata as { people: string[] }).people = peopleEntries.map((p) => p.name);

  // If project specified, resolve its ID
  let explicitProjectIds: string[] = [];
  if (input.project) {
    try {
      const { data: projData } = await supabase
        .from("projects")
        .select("id")
        .ilike("name", `%${input.project}%`)
        .limit(1);
      if (projData?.[0]?.id) explicitProjectIds.push(projData[0].id);
    } catch {
      // best-effort
    }
  }

  const { data, error } = await supabase
    .from("thoughts")
    .insert({
      content: input.content,
      embedding,
      due_date: dueDate,
      metadata: {
        ...metadata,
        ...(input.type && { type: input.type }),
        ...(input.topic && { topic: autocorrectTopic(input.topic, metadata.area) }),
        ...(explicitProjectIds.length > 0 && { linked_projects: explicitProjectIds }),
        source: input.source || "mcp",
      },
    })
    .select("id, content, metadata, created_at, due_date");

  if (error) throw new Error(error.message);

  // Find and link related thoughts + auto-link people & projects
  const thought = data?.[0];
  if (thought && embedding) {
    try {
      // 1. Related thoughts
      const { data: related } = await supabase.rpc("match_thoughts", {
        query_embedding: embedding,
        match_threshold: 0.7,
        match_count: 4,
      });
      const relatedIds = (related || [])
        .filter((r: { id: string; similarity: number }) => r.id !== thought.id && r.similarity >= 0.7)
        .slice(0, 3)
        .map((r: { id: string; similarity: number }) => r.id);

      // 2. Auto-link people from peopleEntries (already normalized above).
      const linkedPeopleIds: string[] = [];
      for (const p of peopleEntries) {
        try {
          const personId = await findOrCreatePerson(p.name, metadata.area || "work", p.role, p.org);
          if (personId) linkedPeopleIds.push(personId);
        } catch (err) {
          console.error(`[people] Failed to find/create "${p.name}":`, err);
        }
      }

      // 3. Auto-link projects: check if any active project name appears in content
      const linkedProjectIds: string[] = [];
      try {
        const { data: activeProjects } = await supabase
          .from("projects")
          .select("id, name")
          .eq("status", "active");
        for (const proj of activeProjects || []) {
          if (input.content.toLowerCase().includes(proj.name.toLowerCase())) {
            linkedProjectIds.push(proj.id);
          }
        }
      } catch {
        // best-effort
      }

      // Update thought metadata with all links
      const updatedMeta = {
        ...thought.metadata,
        ...(relatedIds.length > 0 && { related_to: relatedIds }),
        ...(linkedPeopleIds.length > 0 && { linked_people: linkedPeopleIds }),
        ...(linkedProjectIds.length > 0 && { linked_projects: linkedProjectIds }),
      };

      if (relatedIds.length > 0 || linkedPeopleIds.length > 0 || linkedProjectIds.length > 0) {
        await supabase
          .from("thoughts")
          .update({ metadata: updatedMeta })
          .eq("id", thought.id);
        thought.metadata = updatedMeta;
      }
    } catch {
      // Related thoughts linking is best-effort, don't fail the capture
    }
  }

  return { success: true, thought };
}

async function handleUpdateThought(params: Record<string, unknown>) {
  const input = z
    .object({
      id: z.string().uuid(),
      status: z.enum(["done", "in_progress", "open", "cancelled"]).optional(),
      content: z.string().min(1).optional(),
      topic: z.string().optional(),
      project: z.string().optional(),
      unlink_project: z.string().optional(),
      deadline: z.string().nullable().optional(),
    })
    .parse(params);

  // Fetch current thought
  const { data: current, error: fetchError } = await supabase
    .from("thoughts")
    .select("id, content, metadata")
    .eq("id", input.id)
    .single();

  if (fetchError || !current) throw new Error(`Thought not found: ${input.id}`);

  // Preserve existing links that should survive updates
  const currentMeta = current.metadata || {};
  const preservedFields: Record<string, unknown> = {
    linked_projects: currentMeta.linked_projects,
    linked_people: currentMeta.linked_people,
    related_to: currentMeta.related_to,
    source: currentMeta.source || "mcp",
    // Keep caller/user-set metadata when not explicitly overridden —
    // without this, extractMetadata(newContent) silently replaces them.
    ...(!input.topic && currentMeta.topic && { topic: currentMeta.topic }),
    ...(currentMeta.area && { area: currentMeta.area }),
    ...(currentMeta.document_date && { document_date: currentMeta.document_date }),
  };

  const updates: Record<string, unknown> = {};

  // Handle explicit deadline update (null removes it)
  if (input.deadline !== undefined) {
    updates.due_date = input.deadline;
  }

  // If unlink_project specified, resolve and remove from linked_projects
  if (input.unlink_project) {
    const currentLinks: string[] = preservedFields.linked_projects || [];
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.unlink_project);

    if (isUUID) {
      preservedFields.linked_projects = currentLinks.filter((pid: string) => pid !== input.unlink_project);
    } else {
      try {
        const { data: projData } = await supabase
          .from("projects")
          .select("id")
          .ilike("name", `%${input.unlink_project}%`)
          .limit(1);
        if (projData?.[0]?.id) {
          preservedFields.linked_projects = currentLinks.filter((pid: string) => pid !== projData[0].id);
        }
      } catch {
        // best-effort
      }
    }
    if (preservedFields.linked_projects?.length === 0) {
      preservedFields.linked_projects = undefined;
    }
  }

  // If project specified, resolve its ID and add to linked_projects
  if (input.project) {
    try {
      const { data: projData } = await supabase
        .from("projects")
        .select("id")
        .ilike("name", `%${input.project}%`)
        .limit(1);
      if (projData?.[0]?.id) {
        const existingProjects: string[] = currentMeta.linked_projects || [];
        if (!existingProjects.includes(projData[0].id)) {
          preservedFields.linked_projects = [...existingProjects, projData[0].id];
        }
      }
    } catch {
      // best-effort
    }
  }

  // Update metadata with new status
  if (input.status) {
    updates.metadata = {
      ...currentMeta,
      ...preservedFields,
      status: input.status,
      ...(input.status === "done" && { done_at: new Date().toISOString() }),
      ...(input.topic && { topic: autocorrectTopic(input.topic, currentMeta?.area as string | undefined) }),
    };
  }

  // If content changed — regenerate embedding, but preserve links
  if (input.content && input.content !== current.content) {
    const [newEmbedding, newMetadata] = await Promise.all([
      generateEmbedding(input.content),
      extractMetadata(input.content),
    ]);
    updates.content = input.content;
    updates.embedding = newEmbedding;
    // If content changed and user didn't set explicit deadline, use LLM-extracted one
    if (input.deadline === undefined && newMetadata.deadline) {
      updates.due_date = newMetadata.deadline;
    }
    delete newMetadata.deadline;
    updates.metadata = {
      ...currentMeta,
      ...newMetadata,
      ...preservedFields,
      ...(input.status && { status: input.status }),
      ...(input.status === "done" && { done_at: new Date().toISOString() }),
      ...(input.topic && { topic: autocorrectTopic(input.topic, currentMeta?.area as string | undefined) }),
    };
  }

  // Topic-only update (no content change, no status change)
  if (input.topic && !input.content && !input.status) {
    updates.metadata = {
      ...currentMeta,
      ...preservedFields,
      topic: autocorrectTopic(input.topic, currentMeta?.area as string | undefined),
    };
  }

  // Project link/unlink only update (no content, status, or topic change)
  if ((input.project || input.unlink_project) && !input.content && !input.status && !input.topic) {
    updates.metadata = {
      ...currentMeta,
      ...preservedFields,
    };
  }

  const { data, error } = await supabase
    .from("thoughts")
    .update(updates)
    .eq("id", input.id)
    .select("id, content, metadata, created_at, due_date");

  if (error) throw new Error(error.message);
  return { success: true, thought: data?.[0] };
}

async function handleDeleteThought(params: Record<string, unknown>) {
  const input = z
    .object({
      id: z.string().uuid(),
    })
    .parse(params);

  const { error } = await supabase
    .from("thoughts")
    .delete()
    .eq("id", input.id);

  if (error) throw new Error(error.message);
  return { success: true, deleted_id: input.id };
}

// --- Style profile handler ---

async function handleGetStyleProfile() {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, created_at")
    .eq("metadata->>source", "style_analysis")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return { found: false, message: "No style profile found. Capture one with topic 'writing_style_profile'." };
  return { found: true, profile: data[0] };
}

// --- People handlers ---

async function handleManagePerson(params: Record<string, unknown>) {
  const input = z
    .object({
      name: z.string().min(1),
      context: z.string().optional(),
      role: z.string().nullable().optional(),
      organization: z.string().nullable().optional(),
      area: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .parse(params);

  // Sanitize: treat literal string "null" as actual null (common LLM hallucination)
  const cleanOrg = input.organization === "null" ? null : input.organization;
  const cleanRole = input.role === "null" ? null : input.role;

  // Resolve via alias pipeline so "иван петров" finds existing "Иван Петров"
  const personId = await findOrCreatePerson(
    input.name,
    input.area || "work",
    cleanRole ?? undefined,
    cleanOrg ?? undefined,
  );
  if (!personId) throw new Error(`Name "${input.name}" was filtered as non-person`);

  // Update resolved card with any additional fields the caller provided
  const updatePayload: Record<string, unknown> = {};
  if (input.context !== undefined) updatePayload.context = input.context;
  if (cleanRole !== undefined) updatePayload.role = cleanRole;
  if (cleanOrg !== undefined) updatePayload.organization = cleanOrg;
  if (input.area !== undefined) updatePayload.area = input.area;
  if (input.metadata !== undefined) updatePayload.metadata = input.metadata;

  if (Object.keys(updatePayload).length > 0) {
    const { error: updateError } = await supabase
      .from("people")
      .update(updatePayload)
      .eq("id", personId);
    if (updateError) throw new Error(updateError.message);
  }

  const { data, error } = await supabase
    .from("people")
    .select()
    .eq("id", personId)
    .single();

  if (error) throw new Error(error.message);
  return { success: true, person: data };
}

async function handleDeletePerson(params: Record<string, unknown>) {
  const input = z
    .object({
      id: z.string().uuid(),
    })
    .parse(params);

  const { data, error } = await supabase
    .from("people")
    .delete()
    .eq("id", input.id)
    .select()
    .single();

  if (error) throw new Error(`Failed to delete person: ${error.message}`);
  return { success: true, deleted: data };
}

/**
 * Atomically merge orphan/duplicate person card into a canonical one.
 * Steps:
 *   1. Read both cards
 *   2. Merge non-null fields into target (target wins on conflicts; otherwise
 *      take richer value from source)
 *   3. Append source.context to target.context with a "[merged from <name>]"
 *      marker
 *   4. Add alias source.name → target.id (auto, source=merge) unless add_alias=false
 *   5. Rewrite thoughts.metadata.linked_people: replace source.id → target.id
 *   6. Delete source card
 *
 * Solves the manage_person upsert-bug — you can't rename "Вани" → "Ваня"
 * without creating a dup. Now: create canonical, merge_person source→canonical.
 */
async function handleMergePerson(params: Record<string, unknown>) {
  const input = z
    .object({
      source_id: z.string().uuid(),
      target_id: z.string().uuid(),
      add_alias: z.boolean().default(true),
    })
    .parse(params);

  if (input.source_id === input.target_id) {
    return { success: false, error: "source_id and target_id must differ" };
  }

  const [srcRes, tgtRes] = await Promise.all([
    supabase.from("people").select("*").eq("id", input.source_id).single(),
    supabase.from("people").select("*").eq("id", input.target_id).single(),
  ]);
  if (srcRes.error || !srcRes.data) {
    return { success: false, error: `source ${input.source_id} not found` };
  }
  if (tgtRes.error || !tgtRes.data) {
    return { success: false, error: `target ${input.target_id} not found` };
  }
  const src = srcRes.data;
  const tgt = tgtRes.data;

  // Compose merged context
  const mergeMarker = `\n\n[merged from "${src.name}" ${input.source_id}]`;
  const mergedContext = src.context && src.context !== tgt.context
    ? (tgt.context || "") + mergeMarker + (src.context ? ": " + src.context : "")
    : tgt.context;

  // Merge non-null fields (target wins; fill in target nulls from source)
  await supabase
    .from("people")
    .update({
      context: mergedContext,
      role: tgt.role || src.role,
      organization: tgt.organization || src.organization,
    })
    .eq("id", input.target_id);

  // Add alias source.name → target.id (idempotent — upsert on alias_normalized)
  let aliasAdded = false;
  if (input.add_alias) {
    const normalized = normalizeAlias(src.name);
    const { error: aliasErr } = await supabase
      .from("person_aliases")
      .upsert(
        {
          person_id: input.target_id,
          alias_raw: src.name,
          alias_normalized: normalized,
          source: "merge",
        },
        { onConflict: "alias_normalized" }
      );
    if (!aliasErr) aliasAdded = true;
  }

  // Rewrite linked_people in thoughts.metadata: source.id → target.id.
  // App-side scan + update — JSONB array element replace is awkward in PG.
  const { data: thoughtsToUpdate } = await supabase
    .from("thoughts")
    .select("id, metadata")
    .contains("metadata", { linked_people: [input.source_id] });

  let thoughtsUpdated = 0;
  for (const t of thoughtsToUpdate || []) {
    const lp = ((t as { metadata: { linked_people?: string[] } }).metadata.linked_people || []) as string[];
    if (!Array.isArray(lp) || !lp.includes(input.source_id)) continue;
    // De-dup if target_id already in array
    const newLp = Array.from(new Set(lp.map((id) => (id === input.source_id ? input.target_id : id))));
    const newMeta = { ...(t as { metadata: Record<string, unknown> }).metadata, linked_people: newLp };
    const { error: updErr } = await supabase
      .from("thoughts")
      .update({ metadata: newMeta })
      .eq("id", (t as { id: string }).id);
    if (!updErr) thoughtsUpdated++;
  }

  // Delete source
  const { error: delErr } = await supabase
    .from("people")
    .delete()
    .eq("id", input.source_id);
  if (delErr) {
    return {
      success: false,
      error: `Source data merged into target, but delete failed: ${delErr.message}. Source still exists at ${input.source_id}.`,
      thoughts_updated: thoughtsUpdated,
      alias_added: aliasAdded,
    };
  }

  return {
    success: true,
    merged_into: input.target_id,
    deleted_source: input.source_id,
    alias_added: aliasAdded,
    thoughts_updated: thoughtsUpdated,
  };
}

async function handleListPeople(params: Record<string, unknown>) {
  const input = z
    .object({
      search: z.string().optional(),
      role: z.string().optional(),
      area: z.string().optional(),
      organization: z.string().optional(),
      orphans_only: z.boolean().default(false),
      limit: z.number().default(50),
    })
    .parse(params);

  if (input.orphans_only) {
    const { data, error } = await supabase.rpc("find_orphan_people");
    if (error) throw new Error(error.message);
    return (data || []).slice(0, input.limit);
  }

  let query = supabase
    .from("people")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(input.limit);

  if (input.search) {
    query = query.or(`name.ilike.%${input.search}%,context.ilike.%${input.search}%,organization.ilike.%${input.search}%`);
  }
  if (input.role) {
    query = query.eq("role", input.role);
  }
  if (input.area) {
    query = query.eq("area", input.area);
  }
  if (input.organization) {
    query = query.ilike("organization", `%${input.organization}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function handleManageAlias(params: Record<string, unknown>) {
  const input = z
    .object({
      action: z.enum(["add", "remove"]),
      alias: z.string().min(1),
      person_id: z.string().uuid().optional(),
      source: z.enum(["manual", "nightly-dream", "merge"]).default("manual"),
    })
    .parse(params);

  const normalized = normalizeAlias(input.alias);

  if (input.action === "remove") {
    const { data, error } = await supabase
      .from("person_aliases")
      .delete()
      .eq("alias_normalized", normalized)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { success: false, message: `No alias found for "${input.alias}"` };
    return { success: true, removed: data };
  }

  // action === "add"
  if (!input.person_id) throw new Error("person_id is required for action=add");

  const { data: existing } = await supabase
    .from("person_aliases")
    .select("id, person_id, alias_raw")
    .eq("alias_normalized", normalized)
    .maybeSingle();

  if (existing && existing.person_id !== input.person_id) {
    throw new Error(
      `Alias "${input.alias}" (normalized "${normalized}") already maps to person ${existing.person_id} (raw "${existing.alias_raw}"). Remove it first or use a different alias.`
    );
  }
  if (existing && existing.person_id === input.person_id) {
    return { success: true, alias: existing, note: "already mapped, no change" };
  }

  const { data, error } = await supabase
    .from("person_aliases")
    .insert({
      person_id: input.person_id,
      alias_raw: input.alias.trim(),
      alias_normalized: normalized,
      source: input.source,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return { success: true, alias: data };
}

// --- Projects handlers ---

async function handleManageProject(params: Record<string, unknown>) {
  const input = z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(["active", "paused", "completed", "archived"]).optional(),
      area: z.string().optional(),
      deadline: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .parse(params);

  const { data, error } = await supabase
    .from("projects")
    .upsert(
      {
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.area !== undefined && { area: input.area }),
        ...(input.deadline !== undefined && { deadline: input.deadline }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
      },
      { onConflict: "name" }
    )
    .select();

  if (error) throw new Error(error.message);
  return { success: true, project: data?.[0] };
}

async function handleDeleteProject(params: Record<string, unknown>) {
  const input = z
    .object({
      id: z.string().uuid(),
    })
    .parse(params);

  const { data, error } = await supabase
    .from("projects")
    .delete()
    .eq("id", input.id)
    .select()
    .single();

  if (error) throw new Error(`Failed to delete project: ${error.message}`);
  return { success: true, deleted: data };
}

async function handleListProjects(params: Record<string, unknown>) {
  const input = z
    .object({
      status: z.string().optional(),
      area: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().default(20),
    })
    .parse(params);

  let query = supabase
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(input.limit);

  if (input.status) {
    query = query.eq("status", input.status);
  }
  if (input.area) {
    query = query.eq("area", input.area);
  }
  if (input.search) {
    query = query.or(`name.ilike.%${input.search}%,description.ilike.%${input.search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

// --- Skill Handlers ---

async function handleListSkills(params: Record<string, unknown>) {
  const input = z
    .object({
      category: z.string().optional(),
      client: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().default(20),
    })
    .parse(params);

  let query = supabase
    .from("skills")
    .select("id, name, description, category, client, trigger_patterns, tools_required, is_active, metadata, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(input.limit);

  if (input.category) query = query.eq("category", input.category);
  if (input.client) query = query.eq("client", input.client);
  if (input.search) {
    query = query.or(`name.ilike.%${input.search}%,description.ilike.%${input.search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function handleManageSkill(params: Record<string, unknown>) {
  const input = z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.string().optional(),
      client: z.string().optional(),
      trigger_patterns: z.array(z.string()).optional(),
      tools_required: z.array(z.string()).optional(),
      skill_prompt: z.string().optional(),
      is_active: z.boolean().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .parse(params);

  // Generate embedding from description + name + trigger_patterns
  const embeddingText = [
    input.description || "",
    input.name,
    ...(input.trigger_patterns || []),
  ].filter(Boolean).join(" | ");

  const embedding = embeddingText.trim()
    ? await generateEmbedding(embeddingText)
    : undefined;

  const { data, error } = await supabase
    .from("skills")
    .upsert(
      {
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.client !== undefined && { client: input.client }),
        ...(input.trigger_patterns !== undefined && { trigger_patterns: input.trigger_patterns }),
        ...(input.tools_required !== undefined && { tools_required: input.tools_required }),
        ...(input.skill_prompt !== undefined && { skill_prompt: input.skill_prompt }),
        ...(input.is_active !== undefined && { is_active: input.is_active }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        ...(embedding && { embedding }),
      },
      { onConflict: "name" }
    )
    .select();

  if (error) throw new Error(error.message);
  return { success: true, skill: data?.[0] };
}

async function handleImportSkill(params: Record<string, unknown>) {
  const input = z
    .object({
      url: z.string().optional(),
      text: z.string().optional(),
      override_name: z.string().optional(),
      override_category: z.string().optional(),
    })
    .parse(params);

  if (!input.url && !input.text) throw new Error("Either url or text is required");

  // Resolve content
  let content = input.text || "";
  if (input.url) {
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);
    content = await res.text();
  }
  if (!content.trim()) throw new Error("No content to import");

  // LLM extraction
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Parse this skill/agent description into structured JSON. Return ONLY valid JSON:
{
  "name": "snake_case_skill_name",
  "description": "One-sentence description of what this skill does",
  "category": "one of: management, development, communication, analysis, design, marketing, testing, support",
  "client": "target client or 'any'",
  "trigger_patterns": ["keyword or phrase that should trigger this skill"],
  "tools_required": ["list of MCP tools needed"],
  "skill_prompt": "the full prompt/instructions extracted verbatim or reconstructed"
}

If a field cannot be determined, use reasonable defaults.
${input.override_name ? `Name override: ${input.override_name}` : ""}
${input.override_category ? `Category override: ${input.override_category}` : ""}

Content to parse:
${content.slice(0, 8000)}`,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`LLM extraction failed: ${await res.text()}`);
  const llmData = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(llmData.choices[0].message.content);
  } catch {
    throw new Error("Failed to parse LLM response as JSON");
  }

  // Upsert via handleManageSkill
  const result = await handleManageSkill({
    name: input.override_name || parsed.name || "imported_skill",
    description: parsed.description,
    category: input.override_category || parsed.category,
    client: parsed.client || "any",
    trigger_patterns: parsed.trigger_patterns || [],
    tools_required: parsed.tools_required || [],
    skill_prompt: parsed.skill_prompt || content,
    metadata: { source_url: input.url || null, imported_at: new Date().toISOString() },
  });

  return { ...result, parsed_fields: parsed };
}

async function handleRouteTask(params: Record<string, unknown>) {
  const input = z
    .object({
      task: z.string().min(1),
      category: z.string().optional(),
      limit: z.number().default(3),
    })
    .parse(params);

  // Semantic search via embedding
  const queryEmbedding = await generateEmbedding(input.task);

  const { data: semanticMatches, error } = await supabase.rpc("match_skills", {
    query_embedding: queryEmbedding,
    match_threshold: 0.3,
    match_count: input.limit * 2,
  });

  if (error) throw new Error(error.message);

  // Keyword matching against trigger_patterns
  const taskLower = input.task.toLowerCase();

  const { data: allActive } = await supabase
    .from("skills")
    .select("id, name, description, category, client, trigger_patterns, tools_required, skill_prompt, metadata")
    .eq("is_active", true);

  const scoreMap = new Map<string, { skill: Record<string, unknown>; semantic: number; keyword: number }>();

  for (const m of semanticMatches || []) {
    scoreMap.set(m.id, { skill: m, semantic: m.similarity, keyword: 0 });
  }

  for (const skill of allActive || []) {
    const patterns: string[] = (skill.trigger_patterns as string[]) || [];
    let matchCount = 0;
    for (const pattern of patterns) {
      if (taskLower.includes(pattern.toLowerCase())) matchCount++;
    }
    if (matchCount > 0) {
      const existing = scoreMap.get(skill.id);
      if (existing) {
        existing.keyword = matchCount;
      } else {
        scoreMap.set(skill.id, { skill, semantic: 0, keyword: matchCount });
      }
    }
  }

  // Rank: 70% semantic + 30% keyword
  const maxKeyword = Math.max(...[...scoreMap.values()].map((v) => v.keyword), 1);
  let ranked = [...scoreMap.values()]
    .map((entry) => ({
      ...entry.skill,
      semantic_score: entry.semantic,
      keyword_score: entry.keyword,
      combined_score: entry.semantic * 0.7 + (entry.keyword / maxKeyword) * 0.3,
    }))
    .sort((a, b) => (b.combined_score as number) - (a.combined_score as number));

  if (input.category) {
    ranked = ranked.filter((s) => s.category === input.category);
  }

  return {
    task: input.task,
    matches: ranked.slice(0, input.limit),
    total_candidates: scoreMap.size,
  };
}

// --- Health Handlers ---

const HEALTH_NUMERIC_METRICS = [
  "steps", "distance_meters", "total_calories",
  "hr_min", "hr_max", "hr_avg", "resting_hr",
  "sleep_minutes", "vo2max",
  "active_minutes_moderate", "active_minutes_vigorous",
] as const;
const HEALTH_TOTAL_METRICS = new Set([
  "steps", "distance_meters", "total_calories", "sleep_minutes",
  "active_minutes_moderate", "active_minutes_vigorous",
]);

async function handleGetHealthSummary(params: Record<string, unknown>) {
  const input = z
    .object({
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    })
    .parse(params);

  const end = input.end_date || new Date().toISOString().slice(0, 10);
  const startDefault = new Date();
  startDefault.setDate(startDefault.getDate() - 6);
  const start = input.start_date || startDefault.toISOString().slice(0, 10);

  const [{ data: daily, error: dailyErr }, { data: workouts, error: woErr }] = await Promise.all([
    supabase
      .from("health_metrics_daily")
      .select("date, steps, distance_meters, total_calories, hr_min, hr_max, hr_avg, resting_hr, sleep_minutes, vo2max, active_minutes_moderate, active_minutes_vigorous")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true }),
    supabase
      .from("health_workouts")
      .select("started_at, duration_minutes, exercise_type, total_calories, distance_meters")
      .gte("started_at", `${start}T00:00:00Z`)
      .lte("started_at", `${end}T23:59:59Z`),
  ]);
  if (dailyErr) throw new Error(dailyErr.message);
  if (woErr) throw new Error(woErr.message);

  const rows = (daily || []) as Array<Record<string, number | string | null>>;
  const averages: Record<string, number | null> = {};
  const totals: Record<string, number> = {};
  for (const metric of HEALTH_NUMERIC_METRICS) {
    const values = rows
      .map((r) => r[metric])
      .filter((v): v is number => typeof v === "number");
    averages[metric] = values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
      : null;
    if (HEALTH_TOTAL_METRICS.has(metric)) {
      totals[`${metric}_total`] = Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
    }
  }

  const wos = (workouts || []) as Array<{ exercise_type?: string | null; duration_minutes?: number | null }>;
  const byType: Record<string, number> = {};
  let durationTotal = 0;
  for (const w of wos) {
    const t = w.exercise_type || "unknown";
    byType[t] = (byType[t] || 0) + 1;
    if (typeof w.duration_minutes === "number") durationTotal += w.duration_minutes;
  }

  return {
    period: { start_date: start, end_date: end, days_with_data: rows.length },
    averages,
    totals,
    workouts: {
      count: wos.length,
      total_duration_minutes: durationTotal,
      by_type: byType,
    },
  };
}

async function handleGetHealthTrend(params: Record<string, unknown>) {
  const input = z
    .object({
      metric: z.string(),
      weeks: z.coerce.number().default(4),
    })
    .parse(params);

  if (!HEALTH_NUMERIC_METRICS.includes(input.metric as typeof HEALTH_NUMERIC_METRICS[number])) {
    throw new Error(`Unknown metric '${input.metric}'. Allowed: ${HEALTH_NUMERIC_METRICS.join(", ")}`);
  }

  const start = new Date();
  start.setDate(start.getDate() - input.weeks * 7 + 1);
  const startStr = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("health_metrics_daily")
    .select(`date, ${input.metric}`)
    .gte("date", startStr)
    .order("date", { ascending: true });
  if (error) throw new Error(error.message);

  const series = ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    date: row.date as string,
    value: (row[input.metric] as number | null) ?? null,
  }));

  const numericValues = series
    .map((p) => p.value)
    .filter((v): v is number => typeof v === "number");
  const stats = numericValues.length
    ? {
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
        avg: Math.round((numericValues.reduce((a, b) => a + b, 0) / numericValues.length) * 100) / 100,
        count: numericValues.length,
      }
    : { min: null, max: null, avg: null, count: 0 };

  return {
    metric: input.metric,
    weeks: input.weeks,
    start_date: startStr,
    series,
    stats,
  };
}

/**
 * Find days where a health metric satisfies a condition, then return thoughts
 * captured on those days. This is the core "joins" feature of OpenBrain Health:
 * surface reflections/notes/decisions from days with poor sleep, low activity,
 * elevated resting HR, etc.
 *
 * Day boundaries are interpreted in the *server's* timezone (UTC by default for
 * Supabase edge runtime). For Israel-local correlation the user's thoughts already
 * live in `created_at` UTC and the join uses `created_at::date == health date`.
 * Off-by-one risk for thoughts captured around midnight UTC, accepted for now.
 */
async function handleCorrelateHealthThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      metric: z.string(),
      operator: z.enum(["<", "<=", ">", ">=", "==", "!="]),
      threshold: z.coerce.number(),
      days_lookback: z.coerce.number().default(30),
      thoughts_per_day_limit: z.coerce.number().default(10),
      type: z.string().optional(),
      area: z.string().optional(),
    })
    .parse(params);

  if (!HEALTH_NUMERIC_METRICS.includes(input.metric as typeof HEALTH_NUMERIC_METRICS[number])) {
    throw new Error(`Unknown metric '${input.metric}'. Allowed: ${HEALTH_NUMERIC_METRICS.join(", ")}`);
  }

  const start = new Date();
  start.setDate(start.getDate() - input.days_lookback + 1);
  const startStr = start.toISOString().slice(0, 10);

  // 1. Pull all health rows in window with non-null metric
  const { data: rows, error } = await supabase
    .from("health_metrics_daily")
    .select(`date, ${input.metric}`)
    .gte("date", startStr)
    .not(input.metric, "is", null)
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  // 2. Apply condition client-side (operators don't all map cleanly to PostgREST)
  const compare = (val: number) => {
    switch (input.operator) {
      case "<": return val < input.threshold;
      case "<=": return val <= input.threshold;
      case ">": return val > input.threshold;
      case ">=": return val >= input.threshold;
      case "==": return val === input.threshold;
      case "!=": return val !== input.threshold;
    }
  };
  const matchingDays = ((rows || []) as Array<Record<string, unknown>>)
    .map((r) => ({ date: r.date as string, value: r[input.metric] as number }))
    .filter((r) => typeof r.value === "number" && compare(r.value));

  if (matchingDays.length === 0) {
    return {
      condition: { metric: input.metric, operator: input.operator, threshold: input.threshold },
      window: { days_lookback: input.days_lookback, start_date: startStr },
      matching_days: [],
      total_thoughts: 0,
      days: [],
    };
  }

  // 3. For each matching day, fetch thoughts whose created_at falls on that calendar date.
  //    Done in a single query with `or` over date ranges to avoid N round-trips.
  const dayClauses = matchingDays.map((d) => {
    const dayStart = `${d.date}T00:00:00Z`;
    const dayEnd = `${d.date}T23:59:59.999Z`;
    return `and(created_at.gte.${dayStart},created_at.lte.${dayEnd})`;
  });

  let q = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at, due_date")
    .or(dayClauses.join(","))
    .order("created_at", { ascending: false });
  if (input.type) q = q.eq("metadata->>type", input.type);
  if (input.area) q = q.eq("metadata->>area", input.area);

  const { data: thoughts, error: thoughtsErr } = await q;
  if (thoughtsErr) throw new Error(thoughtsErr.message);

  // 4. Group thoughts by day, cap per-day count
  const byDate = new Map<string, Array<Record<string, unknown>>>();
  for (const t of (thoughts || []) as Array<{ created_at: string; [k: string]: unknown }>) {
    const date = t.created_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    const arr = byDate.get(date)!;
    if (arr.length < input.thoughts_per_day_limit) arr.push(t);
  }

  const days = matchingDays.map((d) => ({
    date: d.date,
    [input.metric]: d.value,
    thought_count: byDate.get(d.date)?.length ?? 0,
    thoughts: byDate.get(d.date) ?? [],
  }));

  return {
    condition: { metric: input.metric, operator: input.operator, threshold: input.threshold },
    window: { days_lookback: input.days_lookback, start_date: startStr },
    matching_days: matchingDays.length,
    total_thoughts: thoughts?.length ?? 0,
    days,
  };
}

// --- MCP Protocol ---

// ── voice_call ────────────────────────────────────────────────────────────
// Создать заявку на голосовой звонок и сразу запустить его через Vapi.
// MCP-эквивалент Telegram-команды /call. Возвращает call_task_id и vapi_call_id.

const USER_DEFAULT_CONTEXT_FOR_CALL = Deno.env.get("USER_DEFAULT_CONTEXT") || "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";

async function handleVoiceCall(params: Record<string, unknown>) {
  const input = z.object({
    task: z.string().min(1, "task description required"),
    phone: z.string().optional(),
  }).parse(params);

  const intent = await parseIntent(input.task, USER_DEFAULT_CONTEXT_FOR_CALL);
  if (input.phone) intent.target_phone = input.phone;
  if (!intent.target_phone) {
    return {
      ok: false,
      error: "target_phone не определён. Укажи телефон явно через параметр phone, либо назови известную организацию (Леумит, Клалит, Маккаби, Меухедет).",
      intent,
    };
  }

  const { data: callTask, error: insertErr } = await supabase
    .from("call_tasks")
    .insert({
      user_id: "mcp",
      original_request: input.task,
      parsed_intent: intent,
      status: "confirmed",
    })
    .select()
    .single();
  if (insertErr || !callTask) throw new Error(`Failed to create call_task: ${insertErr?.message ?? ""}`);

  await supabase.from("call_events").insert({
    call_task_id: callTask.id,
    event_type: "created_via_mcp",
    payload: { intent, source: "voice_call" },
  });

  // Дёргаем trigger_call. Используем тот же MCP_ACCESS_KEY (auth для внутренних вызовов).
  const triggerResp = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/voice-trigger-call?key=${encodeURIComponent(MCP_ACCESS_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_task_id: callTask.id }),
    },
  );
  if (!triggerResp.ok) {
    const errText = await triggerResp.text();
    return { ok: false, call_task_id: callTask.id, intent, error: `trigger_call ${triggerResp.status}: ${errText}` };
  }
  const triggerJson = await triggerResp.json();
  return {
    ok: true,
    call_task_id: callTask.id,
    vapi_call_id: triggerJson.vapi_call_id,
    intent,
    note: "Звонок поставлен в очередь Vapi. Отчёт прилетит в Telegram после окончания.",
  };
}

const TOOLS = [
  {
    name: "search_thoughts",
    description: "Search thoughts using semantic similarity. Use this to find relevant memories by meaning. Supports post-filtering by type, topic, person, area, source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        threshold: { type: "number", description: "Similarity threshold 0-1, default 0.5" },
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
    description: "Add or remove a canonical-name alias mapping. Use to fix recurring short-form duplicates ('Соловьёв' → Дмитрий Соловьев), Russian morphology ('Ильёй' → Илья Зомба), and transliteration variants ('Akshya' / 'Aakshya'). Aliases are checked BEFORE fuzzy matching in the ingest pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"], description: "add maps alias→person; remove deletes by normalized alias" },
        alias: { type: "string", description: "Raw alias as it appears in input text, e.g. 'Соловьёв' or 'Akshya'. Normalized internally (lowercase, ё→е, trim)." },
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
    description: "Запустить голосовой звонок через Vapi от твоего имени. Принимает свободное описание задачи (на русском), парсит intent через Claude, создаёт call_task и сразу инициирует исходящий звонок. Telegram-эквивалент: /call <task>. Отчёт о звонке (статус, transcript, recording) прилетит в Telegram-бот после окончания, и summary автоматически попадёт в Open Brain как note. Использовать когда пользователь просит позвонить куда-либо: 'позвони в Леумит и запиши Марка', 'позвони в кафе и забронируй стол на 4 человек', 'узнай у магазина X есть ли товар Y'.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Свободный текст задачи на русском. Пример: 'позвони в Леумит и запиши Марка к ортопеду в Беер-Шеве, желательно в четверг или пятницу после 16:00'" },
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

// ─── Manage wiki entity ───

function slugifyEntity(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9а-яё\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function handleManageWikiEntity(params: Record<string, unknown>) {
  const input = z
    .object({
      action: z.enum(["add", "list", "remove", "add_alias", "remove_alias"]),
      entity_type: z.enum(["person", "country", "company", "topic"]).optional(),
      canonical: z.string().optional(),
      slug: z.string().optional(),
      file_path: z.string().optional(),
      id: z.string().uuid().optional(),
      search: z.string().optional(),
      filter_type: z.string().optional(),
      limit: z.number().default(50),
      entity: z.string().optional(),
      alias: z.string().optional(),
    })
    .parse(params);

  // ── LIST ──
  if (input.action === "list") {
    let query = supabase
      .from("wiki_entities")
      .select("id, entity_type, canonical, slug, file_path, status, thoughts_count, last_compiled_at")
      .order("canonical", { ascending: true })
      .limit(input.limit);

    if (input.filter_type) query = query.eq("entity_type", input.filter_type);
    if (input.search) {
      query = query.or(`canonical.ilike.%${input.search}%,slug.ilike.%${input.search}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Also load alias counts per entity
    const entities = data || [];
    if (entities.length > 0) {
      for (const ent of entities) {
        const { count } = await supabase
          .from("entity_aliases")
          .select("id", { count: "exact", head: true })
          .eq("entity_type", ent.entity_type)
          .eq("canonical", ent.canonical);
        (ent as any).alias_count = count || 0;
      }
    }

    return { entities, total: entities.length };
  }

  // ── ADD ──
  if (input.action === "add") {
    if (!input.entity_type) throw new Error("entity_type required for add");
    if (!input.canonical) throw new Error("canonical required for add");

    const slug = input.slug || slugifyEntity(input.canonical);
    const typeFolder = input.entity_type === "person" ? "people"
      : input.entity_type === "company" ? "companies"
      : input.entity_type === "country" ? "countries"
      : "topics";
    const filePath = input.file_path || `entities/${typeFolder}/${slug}.md`;

    // Check for existing
    const { data: existing } = await supabase
      .from("wiki_entities")
      .select("id, canonical, slug")
      .eq("entity_type", input.entity_type)
      .eq("canonical", input.canonical)
      .maybeSingle();

    if (existing) {
      return { success: true, note: "already exists", entity: existing };
    }

    const { data, error } = await supabase
      .from("wiki_entities")
      .insert({
        entity_type: input.entity_type,
        canonical: input.canonical,
        slug,
        file_path: filePath,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Auto-add canonical as first alias (for non-person types)
    if (input.entity_type !== "person") {
      const normalized = input.canonical.trim().toLowerCase().replace(/ё/g, "е");
      await supabase.from("entity_aliases").insert({
        entity_type: input.entity_type,
        canonical: input.canonical,
        alias: input.canonical,
        alias_normalized: normalized,
      });
    }

    return { success: true, entity: data };
  }

  // ── REMOVE ──
  if (input.action === "remove") {
    if (!input.id) throw new Error("id (UUID) required for remove");

    // Get entity info first for alias cleanup
    const { data: ent, error: fetchErr } = await supabase
      .from("wiki_entities")
      .select("id, entity_type, canonical")
      .eq("id", input.id)
      .single();

    if (fetchErr) throw new Error(`Entity not found: ${fetchErr.message}`);

    // Delete aliases (no FK cascade)
    await supabase
      .from("entity_aliases")
      .delete()
      .eq("entity_type", ent.entity_type)
      .eq("canonical", ent.canonical);

    // Delete artifacts (has FK cascade, but explicit is clearer)
    await supabase
      .from("artifacts")
      .delete()
      .eq("entity_id", ent.id);

    // Delete entity
    const { error } = await supabase
      .from("wiki_entities")
      .delete()
      .eq("id", input.id);

    if (error) throw new Error(error.message);
    return { success: true, deleted: ent };
  }

  // ── ADD_ALIAS ──
  if (input.action === "add_alias") {
    if (!input.entity) throw new Error("entity required: canonical or slug");
    if (!input.alias) throw new Error("alias required");

    // Resolve entity
    const { data: ent } = await supabase
      .from("wiki_entities")
      .select("id, entity_type, canonical")
      .or(`canonical.ilike.%${input.entity}%,slug.ilike.%${input.entity}%`)
      .limit(1)
      .maybeSingle();

    if (!ent) throw new Error(`Wiki entity not found: "${input.entity}"`);

    const normalized = input.alias.trim().toLowerCase().replace(/ё/g, "е");

    // Check if alias already exists
    const { data: existing } = await supabase
      .from("entity_aliases")
      .select("id, canonical")
      .eq("entity_type", ent.entity_type)
      .eq("alias_normalized", normalized)
      .maybeSingle();

    if (existing) {
      if (existing.canonical === ent.canonical) {
        return { success: true, note: "already mapped", entity: ent.canonical };
      }
      throw new Error(`Alias "${input.alias}" already mapped to "${existing.canonical}". Remove it first.`);
    }

    const { data, error } = await supabase
      .from("entity_aliases")
      .insert({
        entity_type: ent.entity_type,
        canonical: ent.canonical,
        alias: input.alias.trim(),
        alias_normalized: normalized,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return { success: true, alias: data, entity: ent.canonical };
  }

  // ── REMOVE_ALIAS ──
  if (input.action === "remove_alias") {
    if (!input.entity) throw new Error("entity required: canonical or slug");
    if (!input.alias) throw new Error("alias required");

    const { data: ent } = await supabase
      .from("wiki_entities")
      .select("id, entity_type, canonical")
      .or(`canonical.ilike.%${input.entity}%,slug.ilike.%${input.entity}%`)
      .limit(1)
      .maybeSingle();

    if (!ent) throw new Error(`Wiki entity not found: "${input.entity}"`);

    const normalized = input.alias.trim().toLowerCase().replace(/ё/g, "е");

    const { data, error } = await supabase
      .from("entity_aliases")
      .delete()
      .eq("entity_type", ent.entity_type)
      .eq("canonical", ent.canonical)
      .eq("alias_normalized", normalized)
      .select();

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      return { success: false, note: `Alias "${input.alias}" not found for ${ent.canonical}` };
    }
    return { success: true, deleted: data[0], entity: ent.canonical };
  }

  throw new Error(`Unknown action: ${input.action}`);
}

// ─── Manage artifact ───

async function handleManageArtifact(params: Record<string, unknown>) {
  const input = z
    .object({
      action: z.enum(["add", "remove", "list"]),
      entity: z.string().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
      artifact_type: z.enum(["document", "spreadsheet", "presentation", "pdf", "email", "link", "other"]).default("document"),
      description: z.string().optional(),
      artifact_id: z.string().uuid().optional(),
    })
    .parse(params);

  if (input.action === "list") {
    if (input.entity) {
      // Find entity first, then get its artifacts
      const { data: entityData } = await supabase
        .from("wiki_entities")
        .select("id, canonical, slug")
        .or(`canonical.ilike.%${input.entity}%,slug.ilike.%${input.entity}%`)
        .limit(1)
        .maybeSingle();

      if (!entityData) return { artifacts: [], message: `Wiki entity "${input.entity}" not found` };

      const { data, error } = await supabase
        .from("artifacts")
        .select("id, title, url, artifact_type, description, created_at")
        .eq("entity_id", entityData.id)
        .order("created_at", { ascending: false });

      if (error) throw new Error(error.message);
      return { entity: entityData.canonical, slug: entityData.slug, artifacts: data || [] };
    }

    // No entity filter — list all with entity info
    const { data, error } = await supabase
      .from("artifacts")
      .select("id, title, url, artifact_type, description, created_at, entity_id")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);

    // Enrich with entity names
    if (data && data.length > 0) {
      const entityIds = [...new Set(data.map((a: any) => a.entity_id))];
      const { data: entities } = await supabase
        .from("wiki_entities")
        .select("id, canonical, slug")
        .in("id", entityIds);
      const entityMap = new Map((entities || []).map((e: any) => [e.id, e]));
      return {
        artifacts: data.map((a: any) => ({
          ...a,
          entity: entityMap.get(a.entity_id)?.canonical,
          entity_slug: entityMap.get(a.entity_id)?.slug,
        })),
      };
    }
    return { artifacts: [] };
  }

  if (input.action === "remove") {
    if (!input.artifact_id) throw new Error("artifact_id required for remove");
    const { data, error } = await supabase
      .from("artifacts")
      .delete()
      .eq("id", input.artifact_id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return { success: true, deleted: data };
  }

  // action === "add"
  if (!input.entity) throw new Error("entity required: canonical name or slug of wiki entity");
  if (!input.title) throw new Error("title required");
  if (!input.url) throw new Error("url required");

  // Resolve entity
  const { data: entityData } = await supabase
    .from("wiki_entities")
    .select("id, canonical, slug")
    .or(`canonical.ilike.%${input.entity}%,slug.ilike.%${input.entity}%`)
    .limit(1)
    .maybeSingle();

  if (!entityData) throw new Error(`Wiki entity not found: "${input.entity}". Create it first via wiki_entities table.`);

  const { data, error } = await supabase
    .from("artifacts")
    .insert({
      entity_id: entityData.id,
      title: input.title,
      url: input.url,
      artifact_type: input.artifact_type,
      description: input.description || null,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return { success: true, artifact: data, entity: entityData.canonical };
}

// ─── Compile wiki ───

async function handleCompileWiki(params: Record<string, unknown>) {
  const input = z
    .object({
      entity: z.string().optional(),
      force: z.boolean().optional(),
    })
    .parse(params);

  const compileUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/compile-wiki`;
  const key = Deno.env.get("MCP_ACCESS_KEY") || "";

  const body: Record<string, unknown> = {};
  if (input.entity) {
    body.entity_filter = input.entity;
    body.force = input.force !== undefined ? input.force : true;
  } else {
    body.force = input.force || false;
  }

  const resp = await fetch(`${compileUrl}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`compile-wiki returned ${resp.status}: ${text}`);
  }

  return await resp.json();
}

// Handle MCP JSON-RPC requests
async function handleMcpRequest(body: Record<string, unknown>) {
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

function sseEncode(event: string, data: string): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

// --- Main HTTP handler ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-brain-key, mcp-session-id",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Auth check
  if (!authenticate(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop(); // last segment

  // --- SSE transport: GET /sse — open event stream with endpoint discovery ---
  if (req.method === "GET" && path === "sse") {
    const host = url.hostname;
    const key = url.searchParams.get("key") || "";
    const messagesUrl = `https://${host}/functions/v1/open-brain-mcp/messages?key=${encodeURIComponent(key)}`;

    let keepAliveTimer: number;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseEncode("endpoint", messagesUrl));
        // Keep-alive ping every 30s to prevent timeout
        keepAliveTimer = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          } catch {
            clearInterval(keepAliveTimer);
          }
        }, 30_000);
      },
      cancel() {
        clearInterval(keepAliveTimer);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...CORS_HEADERS,
      },
    });
  }

  // --- SSE transport: POST /messages — JSON-RPC, response in POST body ---
  // Serverless-compatible: no cross-request state needed
  if (req.method === "POST" && path === "messages") {
    try {
      const body = await req.json();
      const result = await handleMcpRequest(body);
      if (!result) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : "Unknown"}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // Health check
  if (path === "health" || req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", server: "open-brain-mcp" }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // MCP endpoint — handle POST with JSON-RPC (Streamable HTTP transport)
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Handle batch requests
      if (Array.isArray(body)) {
        const results = [];
        for (const item of body) {
          const result = await handleMcpRequest(item);
          if (result) results.push(result);
        }
        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      // Single request
      const result = await handleMcpRequest(body);
      if (!result) {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : "Unknown"}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // DELETE — close session (no-op)
  if (req.method === "DELETE") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  return new Response("Method not allowed", { status: 405 });
});
