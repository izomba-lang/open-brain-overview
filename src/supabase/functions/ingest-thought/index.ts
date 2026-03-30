import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
