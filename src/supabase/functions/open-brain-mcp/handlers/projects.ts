import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";

// --- Projects handlers ---

export async function handleManageProject(params: Record<string, unknown>) {
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

export async function handleDeleteProject(params: Record<string, unknown>) {
  const input = z
    .object({
      id: z.string().uuid(),
    })
    .parse(params);

  const { data, error } = await supabase
    .from("projects")
    .delete()
    .eq("id", input.id)
    .select()
    .single();

  if (error) throw new Error(`Failed to delete project: ${error.message}`);
  return { success: true, deleted: data };
}

export async function handleListProjects(params: Record<string, unknown>) {
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
