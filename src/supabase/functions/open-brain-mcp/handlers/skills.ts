import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";
import { generateEmbedding } from "../../_shared/ingest.ts";

// --- Skill Handlers ---

export async function handleListSkills(params: Record<string, unknown>) {
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

export async function handleManageSkill(params: Record<string, unknown>) {
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

export async function handleImportSkill(params: Record<string, unknown>) {
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

export async function handleRouteTask(params: Record<string, unknown>) {
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
    ranked = ranked.filter((s) => (s as { category?: string }).category === input.category);
  }

  return {
    task: input.task,
    matches: ranked.slice(0, input.limit),
    total_candidates: scoreMap.size,
  };
}
