import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TOPIC_RULES, lintTopic, autocorrectTopic } from "../_shared/topic_prompt.ts";

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Generate embedding via OpenRouter
async function generateEmbedding(text: string): Promise<number[]> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
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

// Extract metadata via OpenRouter (gpt-4o-mini)
async function extractMetadata(text: string) {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Extract metadata from this text. Return ONLY valid JSON:
{
  "type": "idea|task|reflection|note|question|event|decision|insight",
  "topic": "namespace/subtopic[-DD-MM]",
  "people": ["names mentioned"],
  "sentiment": "positive|neutral|negative",
  "area": "work|personal|health|finance|learning|social"
}

Rules for "topic":
${TOPIC_RULES}

Rules for "type":
- note: financial notifications, card transactions, receipts, bank alerts, expense reports — ALWAYS "note", even if a follow-up action is implied
- task: only explicit assignments, to-dos, "need to do X", "don't forget Y" — the text must contain a clear call to action
- event: meetings, trips, travel records (factual)
- All other types: use based on content meaning

Rules for "area":
- work: anything related to job, projects, colleagues, meetings, Dodo Brands
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

  let parsed: { type?: string; topic?: string; people?: string[]; sentiment?: string; area?: string };
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    parsed = { type: "note", topic: "", people: [], sentiment: "neutral" };
  }
  const warning = lintTopic(parsed.topic);
  if (warning) {
    const fixed = autocorrectTopic(parsed.topic, parsed.area);
    console.warn(`[topic][autocorrect] "${parsed.topic}" → "${fixed}" (${warning}) — content="${text.slice(0, 80)}"`);
    parsed.topic = fixed;
  }
  return parsed;
}

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

    // Generate embedding + extract metadata in parallel
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(text),
      extractMetadata(text),
    ]);

    // Insert into thoughts table (content + metadata JSONB + embedding)
    const { error } = await supabase.from("thoughts").insert({
      content: text,
      embedding,
      metadata: {
        ...metadata,
        source: "slack",
        slack_ts: event.ts,
        slack_channel: event.channel,
      },
    });

    if (error) {
      console.error("DB insert error:", error);
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
