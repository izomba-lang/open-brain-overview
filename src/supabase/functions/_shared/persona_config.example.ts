// User persona for prompts (wiki compiler, daily brief) — TEMPLATE.
//
// Copy to persona_config.ts (gitignored) and fill in your details:
//   cp persona_config.example.ts persona_config.ts
//
// Keeps your name / title / employer out of the committed (public) repo while
// still letting prompts address you correctly at runtime.

export const USER_NAME = "Alex Doe";
export const USER_TITLE = "Head of Something";
export const USER_EMPLOYER = "Acme Corp";
// GitHub repo the wiki compiler commits to.
export const WIKI_REPO = "brain-wiki";

// Per-language form of the user's name for the voice caller greeting.
// Russian wants genitive ("Alex'а"), English possessive ("Alex's"), etc.
export const USER_NAME_BY_LANG: Record<string, string> = {
  ru: "Alex'а",
  he: "Alex",
  en: "Alex's",
};
