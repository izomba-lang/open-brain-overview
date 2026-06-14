import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared Supabase service-role client for all MCP handlers.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
