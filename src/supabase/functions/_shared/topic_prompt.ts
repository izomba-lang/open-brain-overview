// Single source of truth for topic-extraction rules used across ingest points
// (open-brain-mcp capture_thought, ingest-thought Slack, telegram-callback-webhook).
//
// Goal: every thought lands with topic = "namespace/subtopic[-DD-MM]" so that
// Stage-4 nightly normalisation has nothing left to do.
//
// User-specific vocabulary (namespaces + examples) lives in topic_config.ts,
// which is gitignored so a public repo link never leaks personal buckets.
// Copy topic_config.example.ts → topic_config.ts to bootstrap.

import { ACTIVE_NAMESPACES, TOPIC_EXAMPLES } from "./topic_config.ts";

export const TOPIC_RULES = `Format topic as "namespace/subtopic[-DD-MM]" (kebab-case, Cyrillic OK).
- namespace — broad bucket. Reuse an existing namespace ONLY when the entry is genuinely about that project/area; otherwise create a new one in kebab-case.
- A business-project namespace (a country/company/deal bucket) is reserved for that specific project. A personal/household errand that merely shares a keyword does NOT belong there: e.g. picking up a printed t-shirt is a personal errand → "personal/...", NOT a clothing-business deal namespace. Match by the actual subject of the task, not by a lexical overlap with a project name.
- If area is personal/health and no clearly-matching personal namespace exists, use "personal" (or a personal sub-bucket like "personal/быт") rather than forcing the entry into a work project.
- subtopic — the MAIN concrete entity of the entry: the person, company, project, or object the action is about (e.g. a surname, a bank, a document). NOT a generic action word.
  - "Познакомить Карабукаева с Мандрыкой" → subtopic "карабукаев-мандрыка", NOT "знакомство".
  - "Отправить резюме Арине Князевой" → subtopic "резюме-князева" or "князева", NOT "резюме".
  - "Письмо в банк по дивидендам" → subtopic "дивиденды-банк", NOT "письмо".
- NEVER leave subtopic empty and NEVER use a bare verb ("вопросы", "резюме", "письмо", "звонок", "встреча") as the whole subtopic — always anchor it to the named entity. If there is a person/company name in the text, it MUST appear in the subtopic.
- date suffix DD-MM — append when the entry is tied to a specific day or event; omit for evergreen notes.
- NEVER return "general", "note", "task", "thought", "idea" as the whole topic.
- ALWAYS include "/" — a topic without slash is invalid.

Active namespaces (hint, not enum — extend when needed): ${ACTIVE_NAMESPACES.join(", ")}.

Examples:
${TOPIC_EXAMPLES.join("\n")}`;

// Strip XML/HTML tags, tool-call fragments, and other markup that LLMs
// occasionally leak into topic strings (e.g. "<function_calls>", "<result>").
// Run BEFORE lintTopic / autocorrectTopic.
const MARKUP_RE = /<\/?[a-zA-Z_:][\w.:_-]*(?:\s[^>]*)?\/?>/g;
const TOOL_FRAGMENT_RE = /\bantml:[a-z_]+\b/g;

export function sanitizeTopic(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(MARKUP_RE, "")
    .replace(TOOL_FRAGMENT_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Soft linter — caller decides what to do with the warning.
// Returns null if topic is OK, or a string describing the problem otherwise.
export function lintTopic(topic: string | undefined | null): string | null {
  if (!topic) return "topic is empty";
  const t = topic.trim().toLowerCase();
  if (!t.includes("/")) return `topic "${topic}" missing namespace separator "/"`;
  const placeholders = ["general", "general/general", "note", "task", "thought", "idea"];
  if (placeholders.includes(t)) return `topic "${topic}" is a placeholder`;
  return null;
}

// Hard autocorrect: rewrite a malformed topic into a valid namespace/subtopic-DD-MM
// form so the soft-linter passes. Used on ingest after LLM extraction.
//   - empty / null / pure placeholder      → "разное/без-темы-DD-MM"
//   - no slash                              → "{area}/{slug}-DD-MM" (or "разное" if no area)
//   - slash present, spaces inside subtopic → spaces collapsed to dashes
// Always returns a topic that satisfies lintTopic() === null.
const KNOWN_AREAS = new Set(["work", "personal", "health", "finance", "learning", "social"]);
const PLACEHOLDERS = new Set(["general", "note", "task", "thought", "idea", "общее", "разное"]);

// Stop-words dropped when deriving a slug from raw content, so the slug keeps
// the meaningful tokens (verbs + named entities) rather than prepositions/fillers.
const SLUG_STOP = new Set([
  "и", "в", "во", "на", "по", "с", "со", "к", "ко", "о", "об", "от", "для", "за",
  "из", "у", "до", "не", "а", "но", "же", "бы", "ли", "это", "что", "как",
  "нужно", "надо", "важно", "пожалуйста", "тоже", "также", "ещё", "еще",
]);

// Build a readable kebab slug from free-form content — used as a fallback when the
// LLM returns no usable subtopic, so the topic still carries the entities/action
// ("познакомить-карабукаева-с-мандрыкой") instead of a blank "без-темы".
export function slugFromContent(content: string | undefined | null, maxWords = 5): string {
  if (!content) return "";
  const words = content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !SLUG_STOP.has(w));
  return words.slice(0, maxWords).join("-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

export function autocorrectTopic(
  topic: string | undefined | null,
  area: string | undefined | null,
  content?: string | null,
  now: Date = new Date()
): string {
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dateSuffix = `${dd}-${mm}`;
  const ns = area && KNOWN_AREAS.has(area) ? area : "разное";

  // When there is no usable topic, derive a slug from the content rather than
  // falling back to the opaque "без-темы".
  const blankFallback = () => {
    const slug = slugFromContent(content);
    return slug ? `${ns}/${slug}-${dateSuffix}` : `${ns}/без-темы-${dateSuffix}`;
  };

  const raw = (topic ?? "").trim();
  if (!raw) return blankFallback();
  if (PLACEHOLDERS.has(raw.toLowerCase())) return blankFallback();

  if (!raw.includes("/")) {
    const slug = raw.toLowerCase().replace(/\s+/g, "-");
    return `${ns}/${slug}-${dateSuffix}`;
  }

  // has slash — collapse internal whitespace in subtopic; replace placeholder namespace
  const [head, ...tail] = raw.split("/");
  const cleanNs = PLACEHOLDERS.has(head.toLowerCase()) ? ns : head;
  const sub = tail.join("/").replace(/\s+/g, "-");
  return `${cleanNs}/${sub}`;
}
