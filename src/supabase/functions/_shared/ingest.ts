// Shared embedding + metadata extraction for all ingest pipelines.
// Callers: ingest-thought, ingest-thought-plaud, telegram-callback-webhook, open-brain-mcp

import { TOPIC_RULES, sanitizeTopic, lintTopic, autocorrectTopic, reconcileTopicArea } from "./topic_prompt.ts";

export { normalizePeopleNames, normalizePersonEntries } from "./people.ts";

const EMBED_CHAR_LIMIT = 24_000;
const TIMEOUT_MS = 30_000;

function withTimeout(ms: number): [AbortController, ReturnType<typeof setTimeout>] {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return [ctrl, timer];
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  let input = text;
  if (text.length > EMBED_CHAR_LIMIT) {
    console.warn(`[embed] truncated ${text.length} → ${EMBED_CHAR_LIMIT} chars`);
    input = text.slice(0, EMBED_CHAR_LIMIT);
  }

  const [ctrl, timer] = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw new Error("Embedding timed out after 30s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface ExtractMetadataOpts {
  /** Override the full user-message prompt. When provided, `text` is NOT auto-embedded. */
  promptContent?: string;
  /** Returned as-is on JSON parse failure. Defaults to a basic note skeleton. */
  defaults?: Record<string, unknown>;
}

const DEFAULT_DEFAULTS: Record<string, unknown> = {
  type: "note",
  topic: "",
  people: [],
  sentiment: "neutral",
};

const defaultPromptFn = (text: string) => `Extract metadata from this text. Return ONLY valid JSON:
{
  "type": "idea|task|reflection|note|question|event|decision|insight",
  "topic": "namespace/subtopic[-DD-MM]",
  "people": ["names mentioned"],
  "sentiment": "positive|neutral|negative",
  "area": "work|personal|health|finance|learning|social"
}

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

Text: ${text}`;

export async function extractMetadata(
  text: string,
  opts?: ExtractMetadataOpts,
): Promise<Record<string, unknown>> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const content = opts?.promptContent ?? defaultPromptFn(text);
  const defaults = opts?.defaults ?? { ...DEFAULT_DEFAULTS };

  const [ctrl, timer] = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content }],
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Metadata extraction failed: ${await res.text()}`);
    const data = await res.json();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.choices[0].message.content);
    } catch {
      return { ...defaults };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaults };

    // Topic lint + autocorrect for single-thought responses.
    // Responses with an {items} key are multi-item lists — callers handle per-item linting.
    if (!parsed.items) {
      parsed.topic = sanitizeTopic(parsed.topic as string | undefined);
      const warning = lintTopic(parsed.topic as string | undefined);
      if (warning) {
        const fixed = autocorrectTopic(
          parsed.topic as string | undefined,
          parsed.area as string | undefined,
          text,
        );
        console.warn(`[topic][autocorrect] "${parsed.topic}" → "${fixed}" (${warning})`);
        parsed.topic = fixed;
      }
      // Align an area-word namespace with the real area (fixes "personal/<person>"
      // on work tasks). Runs even when the topic passed lint above.
      if (typeof parsed.topic === "string") {
        const aligned = reconcileTopicArea(parsed.topic, parsed.area as string | undefined);
        if (aligned !== parsed.topic) {
          console.warn(`[topic][reconcile] "${parsed.topic}" → "${aligned}" (area=${parsed.area})`);
          parsed.topic = aligned;
        }
      }
    }

    return parsed;
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw new Error("Metadata extraction timed out after 30s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface SafeIngestResult {
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  degraded: boolean;
}

/**
 * Resilient prep for ingest pipelines. Runs embedding + metadata extraction and
 * catches each failure INDEPENDENTLY, so a transient OpenRouter outage never
 * loses the underlying thought. On any failure → `degraded: true` and the failed
 * half falls back (embedding → null; metadata → `opts.defaults`). Callers are
 * expected to persist the thought anyway, stamping `needs_reprocess: true`, so
 * the `reprocess-pending` cron can backfill the embedding/metadata later.
 */
export async function safeIngestPrep(
  text: string,
  opts?: ExtractMetadataOpts & { source?: string },
): Promise<SafeIngestResult> {
  const [embRes, metaRes] = await Promise.allSettled([
    generateEmbedding(text),
    extractMetadata(text, opts),
  ]);

  let degraded = false;

  let embedding: number[] | null = null;
  if (embRes.status === "fulfilled") {
    embedding = embRes.value;
  } else {
    degraded = true;
    console.error(`[ingest][degraded] embedding failed (source=${opts?.source ?? "?"}): ${String(embRes.reason)}`);
  }

  let metadata: Record<string, unknown>;
  if (metaRes.status === "fulfilled") {
    metadata = metaRes.value;
  } else {
    degraded = true;
    metadata = { ...(opts?.defaults ?? DEFAULT_DEFAULTS) };
    console.error(`[ingest][degraded] metadata failed (source=${opts?.source ?? "?"}): ${String(metaRes.reason)}`);
  }

  return { embedding, metadata, degraded };
}
