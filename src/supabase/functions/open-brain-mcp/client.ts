import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared Supabase service-role client for all MCP handlers.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
// Supabase forbids setting secrets prefixed with SUPABASE_, and the auto-injected
// SUPABASE_SERVICE_ROLE_KEY can be absent under the new API-key system. Prefer a
// manually-set SERVICE_ROLE_KEY, fall back to the auto-injected one.
const supabaseServiceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
