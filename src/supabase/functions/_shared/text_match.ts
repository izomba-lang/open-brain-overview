// Word-boundary matching for entity-name attribution.
//
// compile-wiki привязывает thoughts к странам/компаниям/топикам через DB-side
// `ilike '%term%'` (быстрый грубый префильтр), но подстрочное совпадение даёт
// ложные срабатывания: «Чад» в «пощады», «Газ» в «Газпром», «go» в «google».
// matchesWholeWord — JS-фильтр поверх ilike: совпадение считается только если
// термин не граничит с буквой/цифрой ни слева, ни справа.
//
// Границу определяем через unicode-классы \p{L}\p{N} (флаг u), а не \b: \b в JS
// опирается на \w = латиница и неверно работает на границах кириллицы.
// Регистронезависимо (флаг i). Спецсимволы термина экранируются, поэтому
// термин с точкой («Acme.») безопасен.

const BOUNDARY = "[\\p{L}\\p{N}_]";

export function matchesWholeWord(content: string, term: string): boolean {
  const t = (term || "").trim();
  if (!t || !content) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<!${BOUNDARY})${escaped}(?!${BOUNDARY})`, "iu");
  return re.test(content);
}
