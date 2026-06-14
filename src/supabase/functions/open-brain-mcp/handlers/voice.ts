import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";
import { parseIntent } from "../../_shared/voice/intent.ts";

// ── voice_call ────────────────────────────────────────────────────────────
// Создать заявку на голосовой звонок и сразу запустить его через Vapi.
// MCP-эквивалент Telegram-команды /call. Возвращает call_task_id и vapi_call_id.

const USER_DEFAULT_CONTEXT_FOR_CALL = Deno.env.get("USER_DEFAULT_CONTEXT") || "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";

export async function handleVoiceCall(params: Record<string, unknown>) {
  const input = z.object({
    task: z.string().min(1, "task description required"),
    phone: z.string().optional(),
  }).parse(params);

  const intent = await parseIntent(input.task, USER_DEFAULT_CONTEXT_FOR_CALL);
  if (input.phone) intent.target_phone = input.phone;
  if (!intent.target_phone) {
    return {
      ok: false,
      error: "target_phone не определён. Укажи телефон явно через параметр phone, либо назови известную организацию (Леумит, Клалит, Маккаби, Меухедет).",
      intent,
    };
  }

  const { data: callTask, error: insertErr } = await supabase
    .from("call_tasks")
    .insert({
      user_id: "mcp",
      original_request: input.task,
      parsed_intent: intent,
      status: "confirmed",
    })
    .select()
    .single();
  if (insertErr || !callTask) throw new Error(`Failed to create call_task: ${insertErr?.message ?? ""}`);

  await supabase.from("call_events").insert({
    call_task_id: callTask.id,
    event_type: "created_via_mcp",
    payload: { intent, source: "voice_call" },
  });

  // Дёргаем trigger_call. Используем тот же MCP_ACCESS_KEY (auth для внутренних вызовов).
  const triggerResp = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/voice-trigger-call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
      body: JSON.stringify({ call_task_id: callTask.id }),
    },
  );
  if (!triggerResp.ok) {
    const errText = await triggerResp.text();
    return { ok: false, call_task_id: callTask.id, intent, error: `trigger_call ${triggerResp.status}: ${errText}` };
  }
  const triggerJson = await triggerResp.json();
  return {
    ok: true,
    call_task_id: callTask.id,
    vapi_call_id: triggerJson.vapi_call_id,
    intent,
    note: "Звонок поставлен в очередь Vapi. Отчёт прилетит в Telegram после окончания.",
  };
}
