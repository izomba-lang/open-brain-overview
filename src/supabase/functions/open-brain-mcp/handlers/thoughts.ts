import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";
import { TOPIC_RULES, autocorrectTopic } from "../../_shared/topic_prompt.ts";
import { normalizePersonEntries, normalizePeopleNames } from "../../_shared/people.ts";
import { generateEmbedding, extractMetadata } from "../../_shared/ingest.ts";
import { findOrCreatePerson, normalizeAlias } from "./people.ts";

// Max content length per hit in search_thoughts results. Long thoughts (meeting
// summaries, nightly-dream logs) can be 10k+ chars and blow the tool's token
// budget when several are returned. The full text is always available via
// list_thoughts or by id.
const SEARCH_CONTENT_LIMIT = 4000;

// Build MCP-specific metadata prompt (people as objects with role/org; deadline + document_date).
function buildMcpMetaPrompt(text: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Extract metadata from this text. Return ONLY valid JSON:
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
- work: anything related to job, projects, colleagues, meetings, your employer
- personal: home, family, personal goals, hobbies
- health: exercise, sleep, diet, medical
- finance: money, budget, investments, expenses
- learning: courses, books, skills, education
- social: friends, events, networking

Rules for "deadline":
- ONLY for type "task": extract an explicit actionable deadline — "сделать до пятницы", "напомнить 5 апреля", "дедлайн 15 мая"
- Convert relative dates to absolute using today = ${today}
- For types note/reflection/event/decision/insight: ALWAYS return null. Documents, meeting notes, advisor logs, and financial records do NOT have deadlines
- A date mentioned in a document (issue date, signature date, period start/end) is NOT a deadline — put it in "document_date" instead
- If no actionable deadline is mentioned, return null

Rules for "document_date":
- The primary date of the document or event described in the text: issue date, signature date, meeting date, transaction date
- Examples: "полис от 14.05.2025" → "2025-05-14", "подписана 05.05.2026" → "2026-05-05", "встреча 8 мая" → "2026-05-08"
- If no document date is present, return null

Text: ${text}`;
}

// --- MCP Tool Handlers ---

export async function handleSearchThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      query: z.string(),
      threshold: z.coerce.number().default(0.3),
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

  // Hybrid search: BM25 + vector + RRF + Ebbinghaus decay
  const { data, error } = await supabase.rpc("hybrid_match_thoughts", {
    query_embedding: queryEmbedding,
    query_text: input.query,
    match_threshold: input.threshold,
    match_count: fetchCount,
    rrf_k: 60,
    decay_half_life_days: 90,
  });

  if (error) {
    // Fallback to legacy vector-only search if hybrid RPC not yet deployed
    console.warn("[search] hybrid_match_thoughts failed, falling back to match_thoughts:", error.message);
    const { data: fallbackData, error: fallbackErr } = await supabase.rpc("match_thoughts", {
      query_embedding: queryEmbedding,
      match_threshold: Math.max(input.threshold, 0.5),
      match_count: fetchCount,
    });
    if (fallbackErr) throw new Error(fallbackErr.message);
    const fallbackResults = (fallbackData || []).map(
      (row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number; due_date: string | null }) => ({
        id: row.id, content: row.content, metadata: row.metadata,
        similarity: row.similarity, text_rank: 0, combined_score: row.similarity, due_date: row.due_date,
      })
    );
    return applyFiltersAndTrackAccess(fallbackResults, input);
  }

  let results = (data || []).map(
    (row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number; text_rank: number; combined_score: number; due_date: string | null }) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      similarity: row.similarity,
      text_rank: row.text_rank,
      combined_score: row.combined_score,
      due_date: row.due_date,
    })
  );

  return applyFiltersAndTrackAccess(results, input);
}

async function applyFiltersAndTrackAccess(
  results: Array<{ id: string; content: string; metadata: Record<string, unknown>; similarity: number; text_rank?: number; combined_score?: number; due_date: string | null }>,
  input: { limit: number; type?: string; topic?: string; person?: string; area?: string; source?: string },
) {
  if (input.type) results = results.filter((r) => r.metadata?.type === input.type);
  if (input.topic) results = results.filter((r) => String(r.metadata?.topic || "").toLowerCase().includes(input.topic!.toLowerCase()));
  if (input.person) results = results.filter((r) => Array.isArray(r.metadata?.people) && (r.metadata.people as string[]).includes(input.person!));
  if (input.area) results = results.filter((r) => r.metadata?.area === input.area);
  if (input.source) results = results.filter((r) => r.metadata?.source === input.source);

  const final = results.slice(0, input.limit);

  // Decay tracking: bump last_accessed and access_count for returned thoughts (fire-and-forget)
  if (final.length > 0) {
    const ids = final.map((r) => r.id);
    // PostgREST builders are thenable but lazy and have no `.catch` — calling
    // `.catch` on them throws synchronously, which previously meant
    // increment_access_count never actually fired. Use the two-arg `.then`
    // form so each request is dispatched and both outcomes are ignored.
    supabase
      .from("thoughts")
      .update({ last_accessed: new Date().toISOString() })
      .in("id", ids)
      .then(
        () => {
          supabase.rpc("increment_access_count", { thought_ids: ids }).then(() => {}, () => {});
        },
        () => {},
      );
  }

  // Truncate long content in the returned payload (full text stays available via
  // list_thoughts or by id). IDs for access-tracking above use the untruncated rows.
  return final.map((r) => {
    if (typeof r.content === "string" && r.content.length > SEARCH_CONTENT_LIMIT) {
      return {
        ...r,
        content: r.content.slice(0, SEARCH_CONTENT_LIMIT) +
          `\n\n[truncated — ${r.content.length} chars total; fetch full text by id via list_thoughts/get_transcript]`,
      };
    }
    return r;
  });
}

export async function handleListThoughts(params: Record<string, unknown>) {
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

// Build a normalized-name → canonical-name map from the people directory and
// their aliases, so top_people collapses "Илья"/"Илья Z."/"Ильи" into one
// canonical person instead of counting each raw metadata.people string apart.
// Only explicit links collapse (a person's own name, or an alias row added by
// merge_person/manage_alias) — ambiguous bare names stay as-is, so this never
// guesses identity. Read-only; no rewrite of stored strings.
async function buildPersonCanonicalMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const idToName = new Map<string, string>();

  const { data: people } = await supabase.from("people").select("id, name");
  for (const p of people || []) {
    if (!p.name) continue;
    idToName.set(p.id, p.name);
    map.set(normalizeAlias(p.name), p.name);
  }

  const { data: aliases } = await supabase
    .from("person_aliases")
    .select("alias_normalized, person_id");
  for (const a of aliases || []) {
    const canonical = idToName.get(a.person_id);
    if (canonical && a.alias_normalized) map.set(a.alias_normalized, canonical);
  }
  return map;
}

export async function handleThoughtStats() {
  const { data, error } = await supabase
    .from("thoughts")
    .select("metadata, created_at, due_date");

  if (error) throw new Error(error.message);

  const canonicalMap = await buildPersonCanonicalMap();
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
      // Direct REST writers can bypass ingest normalization — never count raw objects as "[object Object]"
      for (const name of normalizePeopleNames(meta.people)) {
        // Collapse aliases/variants onto the canonical person name when known.
        const canonical = canonicalMap.get(normalizeAlias(name)) || name;
        peopleCounts[canonical] = (peopleCounts[canonical] || 0) + 1;
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

export async function handleCaptureThought(params: Record<string, unknown>) {
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
    extractMetadata(input.content, { promptContent: buildMcpMetaPrompt(input.content) }),
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
  const peopleEntries = normalizePersonEntries((metadata as { people?: unknown[] }).people);
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
        ...(input.topic && { topic: autocorrectTopic(input.topic, metadata.area as string | undefined) }),
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
          const personId = await findOrCreatePerson(p.name, (metadata.area as string | undefined) || "work", p.role, p.org);
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

export async function handleUpdateThought(params: Record<string, unknown>) {
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
    const currentLinks: string[] = (preservedFields.linked_projects as string[] | undefined) || [];
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
    if ((preservedFields.linked_projects as string[] | undefined)?.length === 0) {
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
      extractMetadata(input.content, { promptContent: buildMcpMetaPrompt(input.content) }),
    ]);
    // extractMetadata returns people as {name, role, org} objects — store plain names,
    // otherwise stats/search render the entry as "[object Object]"
    (newMetadata as { people?: unknown }).people = normalizePeopleNames(newMetadata.people);
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

export async function handleDeleteThought(params: Record<string, unknown>) {
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

export async function handleGetStyleProfile() {
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

// --- Transcript handler ---

export async function handleGetTranscript(args: Record<string, unknown>) {
  const plaudId = typeof args.plaud_id === "string" ? args.plaud_id.trim() : "";
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = typeof args.limit === "number" ? args.limit : 5;

  // Exact fetch by recording id → verbatim transcript, PAGINATED (transcripts can
  // be 100k+ chars — returning the whole thing blows the tool's token limit).
  if (plaudId) {
    const { data, error } = await supabase
      .from("raw_transcripts")
      .select("plaud_id, thought_id, title, transcript, language, duration_ms, created_at")
      .eq("plaud_id", plaudId)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { found: false, plaud_id: plaudId };

    const full = (data.transcript as string) || "";
    const total = full.length;
    const offset = Math.max(0, typeof args.offset === "number" ? args.offset : 0);
    const chars = Math.min(20000, Math.max(1000, typeof args.chars === "number" ? args.chars : 14000));
    let end = Math.min(total, offset + chars);
    // Snap end FORWARD to the next line boundary so we finish the current turn —
    // but only if it's near (else a very long turn would never paginate). Never
    // snap backward (that could return an almost-empty slice on a long turn).
    if (end < total) {
      const nl = full.indexOf("\n", end);
      if (nl !== -1 && nl - end <= 6000) end = nl + 1;
    }
    const slice = full.slice(offset, end);
    return {
      found: true,
      plaud_id: data.plaud_id,
      thought_id: data.thought_id,
      title: data.title,
      language: data.language,
      duration_ms: data.duration_ms,
      total_chars: total,
      offset,
      returned_chars: slice.length,
      has_more: end < total,
      next_offset: end < total ? end : null,
      transcript: slice,
    };
  }

  // Full-text search (RU + EN) → ranked snippets.
  if (query) {
    const { data, error } = await supabase.rpc("search_transcripts", { q: query, match_count: limit });
    if (error) return { error: error.message };
    return { query, matches: data || [] };
  }

  // Neither → list recent transcripts (metadata only).
  const { data, error } = await supabase
    .from("raw_transcripts")
    .select("plaud_id, thought_id, title, language, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { error: error.message };
  return { recent: data || [] };
}
