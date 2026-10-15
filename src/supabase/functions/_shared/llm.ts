// Unified LLM caller — routes between Anthropic (Claude) and OpenRouter (Qwen, GPT, etc.)
// Use TASK_MODEL for cheap structured tasks, SYNTH_MODEL for quality text generation.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";

export const SYNTH_MODEL = "claude-sonnet-4-6";                 // wiki synthesis, daily brief
// TASK_MODEL: исходный "qwen/qwen3-235b-a22b" OpenRouter снял 09.10.2026 (404),
// и всё, что шло через него, — capture календаря/почты, разбор Inbox, интенты
// звонков, шаги Plaud-ингеста — молча падало. Прямой преемник 2507 в тот же день
// отвечал 429 у всех провайдеров (туда переехали все), поэтому — рекомендованная
// OpenRouter замена.
export const TASK_MODEL = "qwen/qwen3.7-plus";                 // classification, parsing, lint
export const MINI_MODEL = "openai/gpt-4o-mini";                // metadata extraction (already cheap)

export interface LLMResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
  // "max_tokens" means the model was cut off mid-generation and `text` is
  // incomplete — callers that persist the output must not treat it as final.
  stop_reason?: string;
}

// Price per 1M tokens — for cost tracking
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  [SYNTH_MODEL]:  { input: 3,    output: 15   },
  [TASK_MODEL]:   { input: 0.32, output: 1.28 },
  [MINI_MODEL]:   { input: 0.15, output: 0.60 },
};

function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-");
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  maxRetries: number,
  apiKeyOverride?: string,
): Promise<LLMResponse> {
  const apiKey = apiKeyOverride || ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
      const delay = Math.max(retryAfter * 1000, (2 ** attempt) * 15_000);
      console.log(`Rate limited, waiting ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries + 1})`);
      await resp.text();
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API: ${resp.status} — ${errText}`);
    }

    const data = await resp.json();
    return {
      text: data.content?.[0]?.text || "",
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      model,
      stop_reason: data.stop_reason,
    };
  }
  throw new Error("Anthropic API: max retries exceeded on 429");
}

async function callOpenRouter(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  maxRetries: number,
): Promise<LLMResponse> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not configured");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // qwen3.7-plus по умолчанию рассуждает: на capture-промпте 79 с thinking
        // съели весь max_tokens, content пришёл пустым. Для структурных задач
        // рассуждение не нужно — выключаем.
        ...(model === TASK_MODEL ? { reasoning: { enabled: false } } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (resp.status === 429) {
      const delay = (2 ** attempt) * 5_000;
      console.log(`OpenRouter rate limited, waiting ${Math.round(delay / 1000)}s`);
      await resp.text();
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenRouter API: ${resp.status} — ${errText}`);
    }

    const data = await resp.json();
    return {
      text: data.choices?.[0]?.message?.content || "",
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      model,
    };
  }
  throw new Error("OpenRouter API: max retries exceeded on 429");
}

export async function callLLM(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  maxRetries?: number;
  // Per-caller Anthropic key override — lets separate features (e.g. wiki vs
  // speaker diarization) bill against distinct API keys for token tracking in
  // the Anthropic console. Ignored for non-Anthropic models.
  apiKeyOverride?: string;
}): Promise<LLMResponse> {
  const maxTokens = opts.maxTokens ?? 2048;
  const maxRetries = opts.maxRetries ?? 3;

  if (isAnthropicModel(opts.model)) {
    return callAnthropic(opts.model, opts.system, opts.user, maxTokens, maxRetries, opts.apiKeyOverride);
  }
  return callOpenRouter(opts.model, opts.system, opts.user, maxTokens, maxRetries);
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = MODEL_PRICES[model] || { input: 1, output: 3 };
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
}
