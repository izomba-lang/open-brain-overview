import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// --- Helpers ---

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
  "topic": "brief topic (max 50 chars)",
  "people": ["names mentioned"],
  "sentiment": "positive|neutral|negative",
  "area": "work|personal|health|finance|learning|social"
}

Rules for "area":
- work: anything related to job, projects, colleagues, meetings
- personal: home, family, personal goals, hobbies
- health: exercise, sleep, diet, medical
- finance: money, budget, investments, expenses
- learning: courses, books, skills, education
- social: friends, events, networking

Text: ${text}`,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`Metadata extraction failed: ${await res.text()}`);
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { type: "note", topic: "general", people: [], sentiment: "neutral" };
  }
}

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
      threshold: z.number().default(0.5),
      limit: z.number().default(10),
    })
    .parse(params);

  const queryEmbedding = await generateEmbedding(input.query);

  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: queryEmbedding,
    match_threshold: input.threshold,
    match_count: input.limit,
  });

  if (error) throw new Error(error.message);

  const results = (data || []).map(
    (row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number }) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      similarity: row.similarity,
    })
  );

  return results;
}

async function handleListThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      limit: z.number().default(20),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      days: z.number().optional(),
      area: z.string().optional(),
      source: z.string().optional(),
    })
    .parse(params);

  let query = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(input.limit);

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
    .select("metadata, created_at");

  if (error) throw new Error(error.message);

  const rows = data || [];
  const typeCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  const peopleCounts: Record<string, number> = {};
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  let last7 = 0;

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
    })
    .parse(params);

  const [embedding, metadata] = await Promise.all([
    generateEmbedding(input.content),
    extractMetadata(input.content),
  ]);

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
      metadata: {
        ...metadata,
        ...(input.type && { type: input.type }),
        ...(input.topic && { topic: input.topic }),
        ...(explicitProjectIds.length > 0 && { linked_projects: explicitProjectIds }),
        source: input.source || "mcp",
      },
    })
    .select("id, content, metadata, created_at");

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

      // 2. Auto-link people: upsert each extracted person into people table
      const extractedPeople: string[] = metadata.people || [];
      const linkedPeopleIds: string[] = [];
      for (const personName of extractedPeople) {
        if (!personName || personName.length < 2) continue;
        try {
          const { data: personData } = await supabase
            .from("people")
            .upsert(
              { name: personName, area: metadata.area || "work" },
              { onConflict: "name", ignoreDuplicates: true }
            )
            .select("id");
          if (personData?.[0]?.id) linkedPeopleIds.push(personData[0].id);
        } catch {
          // best-effort, skip if fails
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

      // 4. Suggest best skill for actionable thoughts (tasks, questions)
      let suggestedSkill: string | null = null;
      const actionableTypes = ["task", "question", "decision"];
      if (actionableTypes.includes(metadata.type || input.type || "")) {
        try {
          const { data: matchedSkills } = await supabase.rpc("match_skills", {
            query_embedding: embedding,
            match_threshold: 0.35,
            match_count: 1,
          });
          if (matchedSkills?.[0]) {
            suggestedSkill = matchedSkills[0].name;
          }
        } catch {
          // best-effort
        }
      }

      // Update thought metadata with all links
      const updatedMeta = {
        ...thought.metadata,
        ...(relatedIds.length > 0 && { related_to: relatedIds }),
        ...(linkedPeopleIds.length > 0 && { linked_people: linkedPeopleIds }),
        ...(linkedProjectIds.length > 0 && { linked_projects: linkedProjectIds }),
        ...(suggestedSkill && { suggested_skill: suggestedSkill }),
      };

      if (relatedIds.length > 0 || linkedPeopleIds.length > 0 || linkedProjectIds.length > 0 || suggestedSkill) {
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
  const preservedFields = {
    linked_projects: currentMeta.linked_projects,
    linked_people: currentMeta.linked_people,
    related_to: currentMeta.related_to,
    source: currentMeta.source || "mcp",
  };

  const updates: Record<string, unknown> = {};

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
      ...(input.topic && { topic: input.topic }),
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
    updates.metadata = {
      ...currentMeta,
      ...newMetadata,
      ...preservedFields,
      ...(input.status && { status: input.status }),
      ...(input.status === "done" && { done_at: new Date().toISOString() }),
      ...(input.topic && { topic: input.topic }),
    };
  }

  // Topic-only update (no content change, no status change)
  if (input.topic && !input.content && !input.status) {
    updates.metadata = {
      ...currentMeta,
      ...preservedFields,
      topic: input.topic,
    };
  }

  // Project-only update (no content, status, or topic change)
  if (input.project && !input.content && !input.status && !input.topic) {
    updates.metadata = {
      ...currentMeta,
      ...preservedFields,
    };
  }

  const { data, error } = await supabase
    .from("thoughts")
    .update(updates)
    .eq("id", input.id)
    .select("id, content, metadata, created_at");

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

// --- Skill handlers ---

async function handleRouteTask(params: Record<string, unknown>) {
  const input = z
    .object({
      task: z.string().min(1),
      category: z.string().optional(),
      limit: z.number().default(3),
    })
    .parse(params);

  const taskEmbedding = await generateEmbedding(input.task);

  // 1. Semantic match against skills
  const { data: skills, error: skillsError } = await supabase.rpc("match_skills", {
    query_embedding: taskEmbedding,
    match_threshold: 0.4,
    match_count: input.limit,
  });

  if (skillsError) throw new Error(skillsError.message);

  // 2. Also check trigger_patterns for keyword matches
  const words = input.task.toLowerCase().split(/\s+/);
  const { data: allSkills } = await supabase
    .from("skills")
    .select("id, name, description, client, skill_prompt, tools_required, category, trigger_patterns")
    .eq("is_active", true);

  const patternMatches = (allSkills || []).filter((s: { trigger_patterns: string[] }) =>
    s.trigger_patterns.some((p: string) => words.some((w: string) => w.includes(p.toLowerCase())))
  );

  // 3. Merge results: semantic first, then pattern matches not already included
  const seenIds = new Set((skills || []).map((s: { id: string }) => s.id));
  const merged = [...(skills || [])];
  for (const pm of patternMatches) {
    if (!seenIds.has(pm.id)) {
      merged.push({ ...pm, similarity: 0.0 });
    }
  }

  // 4. Get relevant context from thoughts
  const { data: contextThoughts } = await supabase.rpc("match_thoughts", {
    query_embedding: taskEmbedding,
    match_threshold: 0.5,
    match_count: 5,
  });

  return {
    recommended_skill: merged[0] || null,
    alternatives: merged.slice(1),
    relevant_context: (contextThoughts || []).map(
      (t: { id: string; content: string; metadata: Record<string, unknown>; similarity: number }) => ({
        id: t.id,
        content: t.content.substring(0, 200),
        type: t.metadata?.type,
        similarity: t.similarity,
      })
    ),
  };
}

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
    .select("id, name, description, client, category, trigger_patterns, tools_required, is_active, created_at")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.category) query = query.eq("category", input.category);
  if (input.client) query = query.eq("client", input.client);
  if (input.search) query = query.or(`name.ilike.%${input.search}%,description.ilike.%${input.search}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function handleManageSkill(params: Record<string, unknown>) {
  const input = z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      trigger_patterns: z.array(z.string()).optional(),
      client: z.string().optional(),
      skill_prompt: z.string().optional(),
      tools_required: z.array(z.string()).optional(),
      category: z.string().optional(),
      is_active: z.boolean().optional(),
    })
    .parse(params);

  // Generate embedding from name + description for semantic matching
  const textForEmbedding = `${input.name}. ${input.description || ""} ${(input.trigger_patterns || []).join(" ")}`;
  const embedding = await generateEmbedding(textForEmbedding);

  const { data, error } = await supabase
    .from("skills")
    .upsert(
      {
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.trigger_patterns !== undefined && { trigger_patterns: input.trigger_patterns }),
        ...(input.client !== undefined && { client: input.client }),
        ...(input.skill_prompt !== undefined && { skill_prompt: input.skill_prompt }),
        ...(input.tools_required !== undefined && { tools_required: input.tools_required }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.is_active !== undefined && { is_active: input.is_active }),
        embedding,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "name" }
    )
    .select();

  if (error) throw new Error(error.message);
  return { success: true, skill: data?.[0] };
}

// --- Import skill handler ---

async function parseSkillFromText(rawText: string) {
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
          role: "system",
          content: `You convert external agent/skill descriptions into Open Brain skill format.

Open Brain is a personal AI memory system with these MCP tools:
- search_thoughts: semantic search in user's memory
- list_thoughts: browse recent thoughts with filters (type, topic, person, days, area)
- thought_stats: memory statistics
- capture_thought: save a new thought/note/task
- update_thought: update status or content
- delete_thought: delete a thought
- list_people / manage_person: people directory
- list_projects / manage_project: projects/goals registry
- get_style_profile: user's writing style for text generation
- route_task / list_skills / manage_skill: skill routing system

Your job: read the external agent description and produce a JSON object that adapts it into an Open Brain skill. The skill_prompt should reference the Open Brain MCP tools above where relevant.

Return ONLY valid JSON:
{
  "name": "kebab-case-name (max 40 chars)",
  "description": "What this skill does, in Russian, 1-2 sentences",
  "trigger_patterns": ["keyword1", "keyword2", ...] (8-15 keywords in Russian AND English that would trigger this skill),
  "client": "any",
  "skill_prompt": "Step-by-step instructions for an AI assistant to execute this skill using Open Brain MCP tools. In Russian. Reference specific tool names.",
  "tools_required": ["tool1", "tool2"] (from the Open Brain tools list above),
  "category": "management|development|communication|analysis|design|marketing|testing|support"
}`,
        },
        {
          role: "user",
          content: rawText.substring(0, 8000),
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`Skill parsing failed: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices[0].message.content;

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  return JSON.parse(jsonMatch[1]!.trim());
}

async function handleImportSkill(params: Record<string, unknown>) {
  const input = z
    .object({
      url: z.string().url().optional(),
      text: z.string().optional(),
      override_name: z.string().optional(),
      override_category: z.string().optional(),
    })
    .refine((d) => d.url || d.text, { message: "Provide either url or text" })
    .parse(params);

  // 1. Get raw text
  let rawText: string;
  if (input.url) {
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
    rawText = await res.text();
  } else {
    rawText = input.text!;
  }

  if (rawText.length < 50) throw new Error("Content too short to parse as a skill");

  // 2. Parse with GPT-4o-mini
  const parsed = await parseSkillFromText(rawText);

  // 3. Apply overrides
  if (input.override_name) parsed.name = input.override_name;
  if (input.override_category) parsed.category = input.override_category;

  // 4. Save via manage_skill (reuse existing handler)
  const result = await handleManageSkill({
    name: parsed.name,
    description: parsed.description,
    trigger_patterns: parsed.trigger_patterns,
    client: parsed.client || "any",
    skill_prompt: parsed.skill_prompt,
    tools_required: parsed.tools_required,
    category: parsed.category,
  });

  return {
    ...result,
    imported_from: input.url || "(raw text)",
    parsed_fields: {
      name: parsed.name,
      category: parsed.category,
      trigger_count: parsed.trigger_patterns?.length || 0,
      tools_count: parsed.tools_required?.length || 0,
    },
  };
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
      role: z.string().optional(),
      organization: z.string().optional(),
      area: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .parse(params);

  const { data, error } = await supabase
    .from("people")
    .upsert(
      {
        name: input.name,
        ...(input.context !== undefined && { context: input.context }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.organization !== undefined && { organization: input.organization }),
        ...(input.area !== undefined && { area: input.area }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
      },
      { onConflict: "name" }
    )
    .select();

  if (error) throw new Error(error.message);
  return { success: true, person: data?.[0] };
}

async function handleListPeople(params: Record<string, unknown>) {
  const input = z
    .object({
      search: z.string().optional(),
      role: z.string().optional(),
      area: z.string().optional(),
      organization: z.string().optional(),
      limit: z.number().default(50),
    })
    .parse(params);

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

// --- MCP Protocol ---

const TOOLS = [
  {
    name: "search_thoughts",
    description: "Search thoughts using semantic similarity. Use this to find relevant memories by meaning.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        threshold: { type: "number", description: "Similarity threshold 0-1, default 0.5" },
        limit: { type: "number", description: "Max results, default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description: "Browse recent thoughts with optional filters by type, topic, person, time range, area, or source.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results, default 20" },
        type: { type: "string", description: "Filter: idea, task, reflection, note, question, event, decision, insight" },
        topic: { type: "string", description: "Filter by topic (partial match)" },
        person: { type: "string", description: "Filter by person mentioned" },
        days: { type: "number", description: "Only last N days" },
        area: { type: "string", description: "Filter by area: work, personal, health, finance, learning, social" },
        source: { type: "string", description: "Filter by source: mcp, slack, telegram, google-calendar, gmail, granola" },
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
      },
      required: ["content"],
    },
  },
  {
    name: "update_thought",
    description: "Update a thought: mark as done/in_progress/open/cancelled, change content, set topic, or link to a project. Existing project links, people links, and related thoughts are always preserved even when content changes. Requires the thought's id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID of the thought to update" },
        status: { type: "string", description: "New status: done, in_progress, open, cancelled" },
        content: { type: "string", description: "New content (re-embeds automatically if changed)" },
        topic: { type: "string", description: "Override topic (survives content re-extraction)" },
        project: { type: "string", description: "Link to project by name (adds to existing links, does not replace)" },
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
    name: "list_people",
    description: "List people in the directory. Search by name, filter by role, area, or organization.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search in name, context, organization" },
        role: { type: "string", description: "Filter by role: colleague, friend, family, client, etc." },
        area: { type: "string", description: "Filter by area: work, personal, social, etc." },
        organization: { type: "string", description: "Filter by organization (partial match)" },
        limit: { type: "number", description: "Max results, default 50" },
      },
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
    name: "route_task",
    description: "Find the best skill to handle a task. Returns recommended skill with prompt, alternatives, and relevant context from memory. Use this when you have a task and want to know the best approach or tool to handle it.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Description of the task to route" },
        category: { type: "string", description: "Optional filter: management, development, communication, analysis" },
        limit: { type: "number", description: "Max skill matches, default 3" },
      },
      required: ["task"],
    },
  },
  {
    name: "list_skills",
    description: "Browse available skills. Filter by category (management, development, communication, analysis), client (claude-code, cursor, claude-desktop), or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter: management, development, communication, analysis" },
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
        trigger_patterns: { type: "array", items: { type: "string" }, description: "Keywords that trigger this skill" },
        client: { type: "string", description: "Best client: claude-code, cursor, claude-desktop, any" },
        skill_prompt: { type: "string", description: "System prompt to use when executing this skill" },
        tools_required: { type: "array", items: { type: "string" }, description: "MCP tools this skill needs" },
        category: { type: "string", description: "Category: management, development, communication, analysis" },
        is_active: { type: "boolean", description: "Enable/disable the skill" },
      },
      required: ["name"],
    },
  },
  {
    name: "import_skill",
    description: "Import a skill from an external source (URL to markdown file or raw text). Automatically parses the agent description, adapts it to Open Brain MCP tools, generates trigger patterns, and saves to the skill registry. Supports any agent/skill format — markdown, plain text, structured prompts.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch the skill/agent description from (e.g. raw GitHub markdown)" },
        text: { type: "string", description: "Raw text of the skill/agent description (alternative to URL)" },
        override_name: { type: "string", description: "Override the auto-generated skill name" },
        override_category: { type: "string", description: "Override category: management, development, communication, analysis, design, marketing, testing, support" },
      },
    },
  },
  {
    name: "get_style_profile",
    description: "Get the user's writing style profile. ALWAYS call this before drafting messages, emails, or any text on behalf of the user. Returns tone, structure, vocabulary and formatting rules to match the user's personal writing style.",
    inputSchema: { type: "object", properties: {} },
  },
];

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
        serverInfo: { name: "open-brain-mcp", version: "3.0.0" },
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
        case "list_people":
          result = await handleListPeople(toolArgs);
          break;
        case "manage_project":
          result = await handleManageProject(toolArgs);
          break;
        case "list_projects":
          result = await handleListProjects(toolArgs);
          break;
        case "route_task":
          result = await handleRouteTask(toolArgs);
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
        case "get_style_profile":
          result = await handleGetStyleProfile();
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

  // Health check
  if (path === "health" || req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", server: "open-brain-mcp" }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // MCP endpoint — handle POST with JSON-RPC
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
