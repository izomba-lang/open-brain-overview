// Normalization for LLM-extracted "people" arrays.
//
// The open-brain-mcp prompt asks for {name, role, org} objects (since v1.8.0);
// the other prompts ask for plain strings, but gpt-4o-mini occasionally mimics
// the object shape anyway. Everything written to thoughts.metadata.people MUST
// be a plain string — a raw object renders as "[object Object]" in
// thought_stats / search / wiki.

export type PersonEntry = { name: string; role?: string; org?: string };

// Pronouns the extractor sometimes emits as standalone "people" (the speaker
// referring to themselves / others). These are never names. The length>=2 gate
// below already drops "я"/"Я", but two-letter pronouns ("Мы", "Он", "Их") slip
// through — this set catches them regardless of length. Lowercase keys; matched
// case-insensitively. Keep it to pronouns only — don't over-filter real names.
const PRONOUN_STOPWORDS = new Set<string>([
  // RU personal
  "я", "ты", "он", "она", "оно", "мы", "вы", "они",
  // RU oblique / object forms
  "меня", "мне", "мной", "мною", "тебя", "тебе", "тобой", "тобою",
  "его", "него", "ему", "нему", "им", "ним",
  "её", "ее", "неё", "нее", "ей", "ней", "ею",
  "нас", "нам", "нами", "вас", "вам", "вами", "их", "них", "ими", "ними",
  // RU reflexive
  "себя", "себе", "собой", "собою",
  // EN
  "i", "me", "you", "he", "she", "it", "we", "they", "him", "her", "them", "us",
]);

function isPronoun(name: string): boolean {
  return PRONOUN_STOPWORDS.has(name.toLowerCase());
}

// LLM sometimes returns the literal string "null" instead of JSON null.
function cleanField(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.toLowerCase() !== "null" ? s : undefined;
}

export function normalizePersonEntries(raw: unknown): PersonEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: unknown): PersonEntry | null => {
      if (typeof entry === "string") return { name: entry.trim() };
      if (entry && typeof entry === "object" && "name" in entry && typeof (entry as { name: unknown }).name === "string") {
        const e = entry as { name: string; role?: unknown; org?: unknown; organization?: unknown };
        return {
          name: e.name.trim(),
          role: cleanField(e.role),
          org: cleanField(e.org) ?? cleanField(e.organization),
        };
      }
      return null;
    })
    .filter((p): p is PersonEntry => p !== null && p.name.length >= 2 && !isPronoun(p.name));
}

export function normalizePeopleNames(raw: unknown): string[] {
  return normalizePersonEntries(raw).map((p) => p.name);
}
