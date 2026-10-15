-- find_similar_person: подстрочное совпадение → совпадение по целым словам.
--
-- Инцидент 03.09.2026. Новое имя «Карина Петрова» ушло в fuzzy-фоллбэк
-- findOrCreatePerson и совпало с существующей карточкой «Арина»: условие
-- `ns.norm ILIKE '%' || p.normalized_name || '%'` истинно, потому что
-- «карина петрова» содержит подстроку «арина». manage_person затем
-- перезаписал контекст, роль и организацию чужой карточки.
--
-- Триграммная ветка (similarity > min_similarity) тут ни при чём:
-- similarity('арина','карина петрова') ≈ 0.2, ниже порога 0.4.
-- Виновата ровно подстрока без границ слова — тот же класс ошибки, что
-- _shared/text_match.ts чинит для привязки сущностей вики («Чад» в «пощады»).
--
-- Заменяем обе ILIKE-ветки на вхождение по целым словам в любую сторону:
-- «Смирнов» ↔ «Пётр Смирнов» и «Иванов» ↔ «Иван Иванов» продолжают
-- совпадать, «Арина» ↔ «Карина Петрова» — больше нет.
-- Сигнатура не меняется, вызывающий код (findOrCreatePerson,
-- open-brain-mcp/handlers/people.ts) работает как есть.

CREATE OR REPLACE FUNCTION find_similar_person(
  search_name text,
  min_similarity float DEFAULT 0.4
)
RETURNS TABLE(id uuid, name text, sim float)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ns AS (SELECT normalize_person_name(search_name) AS norm)
  SELECT p.id, p.name,
         CASE WHEN p.normalized_name = ns.norm THEN 1.0
              ELSE similarity(p.normalized_name, ns.norm)
         END AS sim
  FROM people p, ns
  WHERE
    p.normalized_name = ns.norm
    OR similarity(p.normalized_name, ns.norm) > min_similarity
    -- Вхождение по целым словам вместо ILIKE '%...%'.
    -- regexp_split_to_array по \s+ — на случай сдвоенных пробелов в имени:
    -- normalize_person_name их не схлопывает.
    OR regexp_split_to_array(p.normalized_name, '\s+')
       <@ regexp_split_to_array(ns.norm, '\s+')
    OR regexp_split_to_array(ns.norm, '\s+')
       <@ regexp_split_to_array(p.normalized_name, '\s+')
  ORDER BY sim DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION find_similar_person(text, float) TO service_role;
