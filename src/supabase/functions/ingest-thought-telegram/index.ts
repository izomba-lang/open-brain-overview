import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_ALLOWED_USER_ID = Deno.env.get("TELEGRAM_ALLOWED_USER_ID") || "";

async function generateEmbedding(text: string): Promise<number[]> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractMetadata(text: string) {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: `Extract metadata from this text. Return ONLY valid JSON:\n{"type": "idea|task|reflection|note|question|event|decision|insight", "topic": "brief topic", "people": ["names mentioned"], "sentiment": "positive|neutral|negative", "area": "work|personal|health|finance|learning|social"}\nRules for area: work=job/projects/colleagues, personal=home/family/hobbies, health=exercise/sleep/diet, finance=money/budget, learning=courses/books/skills, social=friends/events/networking\n\nText: ${text}` }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`Metadata extraction failed: ${await res.text()}`);
  const data = await res.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { return { type: "note", topic: "general", people: [], sentiment: "neutral" }; }
}

async function transcribeVoice(fileId: string): Promise<string> {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) throw new Error("GROQ_API_KEY not configured");

  const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!fileInfoRes.ok) throw new Error(`getFile failed: ${await fileInfoRes.text()}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;

  const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!audioRes.ok) throw new Error(`Audio download failed`);
  const audioBuffer = await audioRes.arrayBuffer();

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", "whisper-large-v3-turbo");

  const transcribeRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey}` },
    body: formData,
  });
  if (!transcribeRes.ok) throw new Error(`Transcription failed: ${await transcribeRes.text()}`);
  const transcribeData = await transcribeRes.json();
  return transcribeData.text?.trim() || "";
}

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Style profile ─────────────────────────────────────────────────────────

async function fetchStyleProfile(): Promise<string> {
  const { data } = await supabase
    .from("thoughts")
    .select("content")
    .eq("metadata->>source", "style_analysis")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.content || "";
}

// ── Brain query functions ──────────────────────────────────────────────────

async function searchThoughts(query: string, limit = 8): Promise<any[]> {
  const embedding = await generateEmbedding(query);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: limit,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return data || [];
}

async function listOpenTasks(): Promise<any[]> {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .eq("metadata->>type", "task")
    .not("metadata->>status", "eq", "done")
    .not("metadata->>status", "eq", "cancelled")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(`List tasks failed: ${error.message}`);
  return data || [];
}

async function askBrain(question: string): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const [relevantThoughts, openTasks, styleProfile] = await Promise.all([
    searchThoughts(question, 8),
    listOpenTasks(),
    fetchStyleProfile(),
  ]);

  const context = relevantThoughts.length > 0
    ? relevantThoughts.map((t, i) => `[${i + 1}] ${t.content}`).join("\n")
    : "(нет релевантных записей)";

  const tasks = openTasks.length > 0
    ? openTasks.map(t => `- ${t.content}`).join("\n")
    : "(нет открытых задач)";

  const styleInstruction = styleProfile
    ? `\n\nСтилистика ответа — пиши в стиле пользователя:\n${styleProfile}\n`
    : "";

  const prompt = `Ты помощник с доступом к личной базе знаний пользователя. Отвечай кратко и по делу на русском языке.${styleInstruction}

Релевантные записи из базы знаний:
${context}

Открытые задачи:
${tasks}

Вопрос: ${question}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    }),
  });
  if (!res.ok) throw new Error(`AI response failed: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function generateTodayPlan(): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const [openTasks, styleProfile] = await Promise.all([
    listOpenTasks(),
    fetchStyleProfile(),
  ]);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentThoughts } = await supabase
    .from("thoughts")
    .select("content, metadata, created_at")
    .gte("created_at", since)
    .not("metadata->>type", "eq", "task")
    .order("created_at", { ascending: false })
    .limit(15);

  const tasksText = openTasks.length > 0
    ? openTasks.map(t => `- ${t.content}`).join("\n")
    : "(нет открытых задач)";

  const recentText = recentThoughts && recentThoughts.length > 0
    ? recentThoughts.map(t => `- ${t.content}`).join("\n")
    : "(нет)";

  const today = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });

  const styleInstruction = styleProfile
    ? `\nПиши в стиле пользователя:\n${styleProfile}\n`
    : "";

  const prompt = `Сегодня ${today}. Составь краткий план дня для пользователя на основе его задач и недавних мыслей.
Выдели 3-5 приоритетов. Будь конкретным. Отвечай на русском.${styleInstruction}

Открытые задачи:
${tasksText}

Недавние мысли (за 7 дней):
${recentText}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Plan generation failed: ${await res.text()}`);
  const data = await res.json();
  return `📅 <b>${today}</b>\n\n` + data.choices[0].message.content;
}

// ── Intent detection ───────────────────────────────────────────────────────

function isQuestionIntent(text: string): boolean {
  if (text.endsWith("?")) return true;
  if (text.startsWith("?")) return true;
  const questionPrefixes = [
    "что ", "как ", "когда ", "где ", "почему ", "зачем ", "кто ",
    "какой ", "какая ", "какие ", "каков", "сколько ",
    "расскажи", "покажи", "найди", "найдите", "помоги",
    "объясни", "напомни", "есть ли", "были ли", "есть у",
  ];
  const lower = text.toLowerCase();
  return questionPrefixes.some(p => lower.startsWith(p));
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const message = body.message;

    if (!message) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const chatId = message.chat.id;
    const userId = String(message.from.id);

    if (TELEGRAM_ALLOWED_USER_ID && userId !== TELEGRAM_ALLOWED_USER_ID) {
      await sendTelegramMessage(chatId, "Sorry, this bot is private.");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    let text = "";
    let source = "telegram";

    // Handle voice messages
    if (message.voice) {
      await sendTelegramMessage(chatId, "🎤 Транскрибирую...");
      try {
        text = await transcribeVoice(message.voice.file_id);
      } catch (err) {
        console.error("Transcription error:", err);
        await sendTelegramMessage(chatId, "❌ Не удалось распознать голос. Попробуй ещё раз.");
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (!text) {
        await sendTelegramMessage(chatId, "❌ Голосовое сообщение пустое или не распознано.");
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      source = "telegram_voice";
    } else if (message.text || message.caption) {
      text = (message.text || message.caption).trim();
    } else {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ── Forwarded message detection ───────────────────────────────────────

    const isForwarded = !!(message.forward_date || message.forward_from || message.forward_from_chat);
    if (isForwarded) source = "telegram_forward";

    // ── Commands ──────────────────────────────────────────────────────────

    if (text === "/start") {
      await sendTelegramMessage(chatId,
        "🧠 <b>Open Brain подключён!</b>\n\n" +
        "Просто пиши мысли — я запомню.\n" +
        "Задай вопрос — отвечу из базы знаний.\n\n" +
        "Команды:\n" +
        "/today — план на сегодня\n" +
        "/tasks — открытые задачи\n" +
        "/help — помощь"
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (text === "/today") {
      await sendTelegramMessage(chatId, "⏳ Составляю план дня...");
      try {
        const plan = await generateTodayPlan();
        await sendTelegramMessage(chatId, plan);
      } catch (err) {
        console.error("Today plan error:", err);
        await sendTelegramMessage(chatId, "❌ Не удалось составить план. Попробуй позже.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (text === "/tasks") {
      try {
        const tasks = await listOpenTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(chatId, "✅ Нет открытых задач!");
        } else {
          const taskList = tasks.map((t, i) => `${i + 1}. ${t.content}`).join("\n");
          await sendTelegramMessage(chatId, `📋 <b>Открытые задачи (${tasks.length}):</b>\n\n${taskList}`);
        }
      } catch (err) {
        console.error("Tasks list error:", err);
        await sendTelegramMessage(chatId, "❌ Не удалось загрузить задачи.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (text === "/help") {
      await sendTelegramMessage(chatId,
        "🧠 <b>Open Brain — справка</b>\n\n" +
        "<b>Сохранить мысль:</b> просто напиши текст или голосовое\n" +
        "<b>Задать вопрос:</b> напиши вопрос (со знаком ? или начни с «как/что/найди»)\n\n" +
        "<b>Команды:</b>\n" +
        "/today — план дня на основе задач\n" +
        "/tasks — список открытых задач\n" +
        "/start — приветствие\n" +
        "/help — эта справка"
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Ignore unknown commands
    if (text.startsWith("/")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Ignore automated briefing messages
    if (text.startsWith("☀️") || text.startsWith("📊")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ── Question mode (query brain) ───────────────────────────────────────

    if (!isForwarded && isQuestionIntent(text)) {
      await sendTelegramMessage(chatId, "🔍 Ищу в базе знаний...");
      try {
        const answer = await askBrain(text);
        await sendTelegramMessage(chatId, answer);
      } catch (err) {
        console.error("Ask brain error:", err);
        await sendTelegramMessage(chatId, "❌ Не удалось получить ответ. Попробуй ещё раз.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ── Save mode (capture thought) ───────────────────────────────────────

    const [embedding, metadata] = await Promise.all([
      generateEmbedding(text),
      extractMetadata(text),
    ]);

    const { error } = await supabase.from("thoughts").insert({
      content: text,
      embedding,
      metadata: {
        ...metadata,
        source,
        is_forwarded: isForwarded,
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
      },
    });

    if (error) {
      console.error("DB insert error:", error);
      await sendTelegramMessage(chatId, "Error saving thought. Try again.");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const typeEmoji: Record<string, string> = { idea: "💡", task: "✅", reflection: "🪞", note: "📝", question: "❓" };
    const emoji = typeEmoji[metadata.type] || "📝";
    const voiceLabel = source === "telegram_voice" ? ` <i>(голос)</i>` : "";
    const forwardLabel = isForwarded ? ` <i>(переслано)</i>` : "";
    await sendTelegramMessage(chatId, `${emoji} Сохранено!${voiceLabel}${forwardLabel} <b>${metadata.topic}</b>`);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
});
