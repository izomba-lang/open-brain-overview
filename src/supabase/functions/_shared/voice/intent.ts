import { callLLM, TASK_MODEL } from "../llm.ts";

export interface ParsedIntent {
  goal: string;
  target_org: string;
  target_phone: string | null;
  context: string[];
  constraints: string[];
  success_criteria: string;
  needs_clarification: string[];
  estimated_difficulty: "low" | "medium" | "high";
  language: "he" | "en" | "ru";
}

// Мини-справочник распространённых израильских номеров.
// Проверять перед реальным звонком — могут поменяться.
export const KNOWN_NUMBERS: Record<string, string> = {
  leumit: "*507",
  clalit: "*2700",
  maccabi: "*3555",
  meuhedet: "*3833",
};

const PARSE_PROMPT = `Ты — парсер задач для голосового агента, который звонит на иврите от имени пользователя в Израиле.
Получи запрос пользователя и верни СТРОГО JSON без дополнительного текста:

{
  "goal": "одна фраза на русском, что нужно сделать",
  "target_org": "название организации",
  "target_phone": "телефон, если указан в запросе или известен (для распространённых организаций — куфат холим и пр.); иначе null",
  "context": ["список фактов, которые понадобятся в разговоре: имена, даты рождения, teudat zehut, адреса"],
  "constraints": ["ограничения: даты, время, локация, бюджет"],
  "success_criteria": "как понять, что задача решена",
  "needs_clarification": ["список вопросов к юзеру, если данных не хватает; пусто если всё ок"],
  "estimated_difficulty": "low | medium | high",
  "language": "he | en | ru"
}

Если в запросе явно не указаны teudat zehut, даты рождения и т.п. — НЕ выдумывай, добавляй в needs_clarification.

Правила для language (ВАЖНО):
- Если пользователь явно говорит «на русском» / «по-русски» / «русским языком» → "ru"
- Если «in English» / «по-английски» / «на английском» → "en"
- Иначе по умолчанию для звонков в Израиле → "he"
- Если есть имя контактного лица в иврите (Леумит, Клалит, типичные израильские конторы, врачи), но юзер просит «по-русски» — всё равно "ru" (юзер знает, что делает).

Не используй markdown, не оборачивай в \`\`\`.`;

export async function parseIntent(
  userText: string,
  defaultContext?: string,
): Promise<ParsedIntent> {
  const userBlock = defaultContext
    ? `Запрос: ${userText}\n\nИзвестный контекст про пользователя (используй где уместно):\n${defaultContext}`
    : `Запрос: ${userText}`;

  const result = await callLLM({
    model: TASK_MODEL,
    system: PARSE_PROMPT,
    user: userBlock,
    maxTokens: 1024,
  });

  const intent = JSON.parse(result.text.trim()) as ParsedIntent;

  if (!intent.target_phone) {
    const key = (intent.target_org || "").toLowerCase();
    for (const [name, num] of Object.entries(KNOWN_NUMBERS)) {
      if (key.includes(name)) {
        intent.target_phone = num;
        break;
      }
    }
  }
  return intent;
}
