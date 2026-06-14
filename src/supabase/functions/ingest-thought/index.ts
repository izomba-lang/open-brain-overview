import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeIngestPrep } from "../_shared/ingest.ts";
import { normalizePeopleNames } from "../_shared/people.ts";

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Filter corporate card transaction alerts (Alaan, etc.)
function isCardTransactionAlert(text: string): boolean {
  const lower = text.toLowerCase();
  // Direct card service keywords
  if (lower.includes("alaan") || lower.includes("расходы по карте") || lower.includes("card alert")) return true;
  // Amount + currency pattern near merchant name (e.g. "Novotel 1091.07 PLN")
  const cardPattern = /\d+[.,]\d{2}\s*(pln|usd|ils|eur|aed|gbp|czk|huf|chf|sek|nok|dkk|try)/i;
  if (cardPattern.test(text) && /\d{4}/.test(text)) return true; // has amount+currency and a 4-digit card suffix
  return false;
}

// Main handler
Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    // Handle Slack URL verification challenge
    if (body.type === "url_verification" && body.challenge) {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only process event_callback
    if (body.type !== "event_callback" || !body.event) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = body.event;

    // Filter: only capture channel
    const captureChannel = Deno.env.get("SLACK_CAPTURE_CHANNEL");
    if (!captureChannel || event.channel !== captureChannel) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Filter: ignore bots
    if (event.bot_id) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Filter: ignore subtypes (channel_join, etc.)
    if (event.subtype) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Must have text
    const text = event.text?.trim();
    if (!text) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Filter out corporate card transaction alerts
    if (isCardTransactionAlert(text)) {
      console.log("Filtered card transaction alert, skipping");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Graceful degradation: if OpenRouter is down, store the message anyway
    // (embedding:null + needs_reprocess) instead of losing it; reprocess-pending
    // cron backfills the embedding/metadata later.
    const { embedding, metadata, degraded } = await safeIngestPrep(text, { source: "slack" });

    // Insert into thoughts table (content + metadata JSONB + embedding)
    const { error } = await supabase.from("thoughts").insert({
      content: text,
      embedding,
      metadata: {
        ...metadata,
        people: normalizePeopleNames(metadata.people),
        source: "slack",
        slack_ts: event.ts,
        slack_channel: event.channel,
        ...(degraded ? { needs_reprocess: true } : {}),
      },
    });

    if (error) {
      // Honesty: we still return 200 to Slack (to stop redelivery), but the
      // message would otherwise be lost silently. Log the FULL text so it can be
      // recovered by hand from the function logs.
      console.error("[slack] DB insert failed — message NOT saved:", JSON.stringify(error), "| text:", text);
    }

    // Always return 200 to Slack to prevent redelivery
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
