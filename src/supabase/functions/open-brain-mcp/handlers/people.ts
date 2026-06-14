import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";

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
    // -ский/-цкий style: Невскому→Невский, Невским→Невский, Невского→Невский
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
 * Alias map handles short forms ("Соколов"), morphology ("Андреем"),
 * and transliteration variants ("Akshay"/"Aakshay") that fuzzy match misses.
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
 *      (multi-word OR ≥ 8 chars). Short single-word first names
 *      are too ambiguous for fuzzy fallback — they'd attach to whatever
 *      person with that name happens to be first in the table, regardless
 *      of context. In that case we create a fresh orphan, which nightly-dream
 *      can then merge + alias when context is clearer.
 *   3. Create new person card (with role/org if provided).
 */
export async function findOrCreatePerson(
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
  // Handles inflected forms: "Невскому"→"невский", "Петрова"→"петров"
  // Applied per-word so "Александру Невскому" tries stems of each word
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
  // wrong-canon attachment (a bare first name in one note attached to the
  // wrong full-name card that shared that first name).
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

// --- People handlers ---

export async function handleManagePerson(params: Record<string, unknown>) {
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

export async function handleDeletePerson(params: Record<string, unknown>) {
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
export async function handleMergePerson(params: Record<string, unknown>) {
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
  // Single batch UPDATE via the merge_linked_people SQL RPC (replaces + de-dups
  // the array element inside jsonb) — replaces the old per-thought scan+update
  // loop. If the rewrite fails, abort BEFORE deleting source so we never leave
  // thoughts pointing at a deleted person.
  const { data: rewritten, error: rewriteErr } = await supabase.rpc("merge_linked_people", {
    p_source: input.source_id,
    p_target: input.target_id,
  });
  if (rewriteErr) {
    return {
      success: false,
      error: `Context/alias merged into target, but linked_people rewrite failed: ${rewriteErr.message}. Source ${input.source_id} NOT deleted.`,
      alias_added: aliasAdded,
    };
  }
  const thoughtsUpdated = (rewritten as number) ?? 0;

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

export async function handleListPeople(params: Record<string, unknown>) {
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

export async function handleManageAlias(params: Record<string, unknown>) {
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
