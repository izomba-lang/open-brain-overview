// Single source of truth for topic-extraction rules used across ingest points
// (open-brain-mcp capture_thought, ingest-thought Slack, telegram-callback-webhook).
//
// Goal: every thought lands with topic = "namespace/subtopic[-DD-MM]" so that
// Stage-4 nightly normalisation has nothing left to do.

export const TOPIC_RULES = `Format topic as "namespace/subtopic[-DD-MM]" (kebab-case, Cyrillic OK).
- namespace — broad bucket. Reuse existing namespace if any fits; otherwise create a new one in kebab-case.
- subtopic — main entity / event / person / project mentioned, kebab-case.
- date suffix DD-MM — append when the entry is tied to a specific day or event; omit for evergreen notes.
- NEVER return "general", "note", "task", "thought", "idea" as the whole topic.
- ALWAYS include "/" — a topic without slash is invalid.

Active namespaces (hint, not enum — extend when needed): система, hungary, hr, apparel-barcelona-morocco, travel, health, open-brain, channel-strategy, dubai, india, costin, regulation, preferences, advisor, corporate, zlatoust-2, strategy, finance, legal, product, marketing.

Examples:
✅ "apparel-barcelona-morocco/galadari-чат-26-04"
✅ "hungary/ntak-blocker-26-04"
✅ "travel/elal-flight-change-26-04"
✅ "channel-strategy/methodology-реук-26-04"
✅ "open-brain/skills-system" (evergreen, no date)
❌ "apparel-deal" — no namespace, no slash
❌ "hungary-ntak" — no slash
❌ "general" / "note" / "task" — meaningless`;

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

export function autocorrectTopic(
  topic: string | undefined | null,
  area: string | undefined | null,
  now: Date = new Date()
): string {
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dateSuffix = `${dd}-${mm}`;
  const ns = area && KNOWN_AREAS.has(area) ? area : "разное";

  const raw = (topic ?? "").trim();
  if (!raw) return `${ns}/без-темы-${dateSuffix}`;
  if (PLACEHOLDERS.has(raw.toLowerCase())) return `${ns}/без-темы-${dateSuffix}`;

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
