// _shared/alert.ts — ops alerting + job_runs audit helpers (Phase 4).
//
// Nightly jobs used to fail silently. These helpers give every job a row in the
// `job_runs` table (start/finish) and ping the owner in Telegram on failure.
//
//   const runId = await startJobRun(supabase, "compile-wiki");
//   try { ...; await finishJobRun(supabase, { runId, job: "compile-wiki", status: "success" }); }
//   catch (e) { await finishJobRun(supabase, { runId, job: "compile-wiki", status: "error", error: String(e) }); }
//
// sendOpsAlert never throws and never blocks a job — alerting must not be able to
// take a job down. The same goes for job_runs writes (best-effort, logged on fail).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
// The owner's Telegram chat id doubles as the ops alert destination — same id
// speaker-review already uses as chat_id.
const OPS_CHAT_ID = Deno.env.get("TELEGRAM_ALLOWED_USER_ID") || "";

/** Send an ops alert to the owner's Telegram. Swallows all errors. */
export async function sendOpsAlert(source: string, message: string): Promise<void> {
  try {
    if (!BOT_TOKEN || !OPS_CHAT_ID) {
      console.error(`[alert] not configured (BOT_TOKEN/OPS_CHAT_ID missing); would send: [${source}] ${message}`);
      return;
    }
    const text = `⚠️ [${source}] ${message}`.slice(0, 4000);
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: Number(OPS_CHAT_ID), text }),
    });
    if (!r.ok) console.error(`[alert] sendMessage non-200:`, r.status, await r.text());
  } catch (e) {
    console.error("[alert] sendOpsAlert threw:", e);
  }
}

/**
 * Record the start of a job run. Returns the row id (to pass to finishJobRun),
 * or null if the insert failed — finishJobRun tolerates a null id by inserting a
 * fresh terminal row, so a job never dies because audit logging hiccuped.
 */
export async function startJobRun(
  supabase: SupabaseClient,
  job: string,
  details?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("job_runs")
      .insert({ job, status: "running", details: details ?? null })
      .select("id")
      .single();
    if (error) {
      console.error(`[alert] startJobRun(${job}) insert failed:`, error);
      return null;
    }
    return (data as { id: string }).id;
  } catch (e) {
    console.error(`[alert] startJobRun(${job}) threw:`, e);
    return null;
  }
}

/**
 * Close out a job run with its terminal status. On a non-success status it also
 * fires sendOpsAlert (unless opts.alert === false). Best-effort: never throws.
 */
export async function finishJobRun(
  supabase: SupabaseClient,
  opts: {
    runId: string | null;
    job: string;
    status: "success" | "partial" | "error";
    error?: string;
    details?: Record<string, unknown>;
    alert?: boolean;
  },
): Promise<void> {
  const { runId, job, status, error, details } = opts;
  const finished_at = new Date().toISOString();
  try {
    if (runId) {
      const patch: Record<string, unknown> = { status, finished_at };
      if (error !== undefined) patch.error = error.slice(0, 8000);
      if (details !== undefined) patch.details = details;
      const { error: upErr } = await supabase.from("job_runs").update(patch).eq("id", runId);
      if (upErr) console.error(`[alert] finishJobRun(${job}) update failed:`, upErr);
    } else {
      // startJobRun failed (or was skipped) — still leave a terminal record.
      const { error: insErr } = await supabase.from("job_runs").insert({
        job,
        status,
        finished_at,
        error: error?.slice(0, 8000) ?? null,
        details: details ?? null,
      });
      if (insErr) console.error(`[alert] finishJobRun(${job}) insert failed:`, insErr);
    }
  } catch (e) {
    console.error(`[alert] finishJobRun(${job}) threw:`, e);
  }

  if (status !== "success" && opts.alert !== false) {
    await sendOpsAlert(job, error ? `${status}: ${error}` : status);
  }
}
