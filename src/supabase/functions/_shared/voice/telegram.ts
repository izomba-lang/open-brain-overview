// Тонкая обёртка над Telegram Bot API для voice agent сценариев.
// Существующий telegram-callback-webhook использует свой fetch напрямую;
// здесь — отдельный slim helper для trigger_call и vapi_webhook.

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

export interface InlineButton {
  text: string;
  callback_data: string;
}

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram ${method} ${res.status}: ${errText}`);
  }
  return await res.json();
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  buttons?: InlineButton[][],
): Promise<unknown> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  return await tg("sendMessage", body);
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text ?? "" });
}
