// User-specific topic vocabulary — TEMPLATE.
//
// Copy this file to `topic_config.ts` (same directory) and replace the
// placeholders with your own namespaces and examples. `topic_config.ts` is
// gitignored, so your real buckets (deals, locations, people, projects) never
// enter version control or a shared repo link.
//
//   cp topic_config.example.ts topic_config.ts
//
// `topic_prompt.ts` imports from `./topic_config.ts` to build the extraction
// prompt. If `topic_config.ts` is missing, deploy/build will fail with a clear
// import error — that's the reminder to create it.

// Broad buckets the LLM should reuse before inventing a new one.
// Keep these generic and non-identifying if the repo is public.
export const ACTIVE_NAMESPACES: string[] = [
  "work",
  "personal",
  "health",
  "finance",
  "learning",
  "travel",
  "open-brain",
  "project-alpha",
  "project-beta",
];

// Few-shot examples shown to the topic extractor. Mix valid (✅) and invalid (❌).
export const TOPIC_EXAMPLES: string[] = [
  `✅ "project-alpha/kickoff-26-04"`,
  `✅ "travel/flight-change-26-04"`,
  `✅ "work/quarterly-review-26-04"`,
  `✅ "open-brain/skills-system" (evergreen, no date)`,
  `❌ "some-deal" — no namespace, no slash`,
  `❌ "project-alpha" — no slash`,
  `❌ "general" / "note" / "task" — meaningless`,
];
