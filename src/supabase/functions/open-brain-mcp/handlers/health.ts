import { z } from "https://esm.sh/zod@3.23.8";
import { supabase } from "../client.ts";

// --- Health Handlers ---

const HEALTH_NUMERIC_METRICS = [
  "steps", "distance_meters", "total_calories",
  "hr_min", "hr_max", "hr_avg", "resting_hr",
  "sleep_minutes", "vo2max",
  "active_minutes_moderate", "active_minutes_vigorous",
] as const;
const HEALTH_TOTAL_METRICS = new Set([
  "steps", "distance_meters", "total_calories", "sleep_minutes",
  "active_minutes_moderate", "active_minutes_vigorous",
]);

export async function handleGetHealthSummary(params: Record<string, unknown>) {
  const input = z
    .object({
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    })
    .parse(params);

  const end = input.end_date || new Date().toISOString().slice(0, 10);
  const startDefault = new Date();
  startDefault.setDate(startDefault.getDate() - 6);
  const start = input.start_date || startDefault.toISOString().slice(0, 10);

  const [{ data: daily, error: dailyErr }, { data: workouts, error: woErr }] = await Promise.all([
    supabase
      .from("health_metrics_daily")
      .select("date, steps, distance_meters, total_calories, hr_min, hr_max, hr_avg, resting_hr, sleep_minutes, vo2max, active_minutes_moderate, active_minutes_vigorous")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true }),
    supabase
      .from("health_workouts")
      .select("started_at, duration_minutes, exercise_type, total_calories, distance_meters")
      .gte("started_at", `${start}T00:00:00Z`)
      .lte("started_at", `${end}T23:59:59Z`),
  ]);
  if (dailyErr) throw new Error(dailyErr.message);
  if (woErr) throw new Error(woErr.message);

  const rows = (daily || []) as Array<Record<string, number | string | null>>;
  const averages: Record<string, number | null> = {};
  const totals: Record<string, number> = {};
  for (const metric of HEALTH_NUMERIC_METRICS) {
    const values = rows
      .map((r) => r[metric])
      .filter((v): v is number => typeof v === "number");
    averages[metric] = values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
      : null;
    if (HEALTH_TOTAL_METRICS.has(metric)) {
      totals[`${metric}_total`] = Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
    }
  }

  const wos = (workouts || []) as Array<{ exercise_type?: string | null; duration_minutes?: number | null }>;
  const byType: Record<string, number> = {};
  let durationTotal = 0;
  for (const w of wos) {
    const t = w.exercise_type || "unknown";
    byType[t] = (byType[t] || 0) + 1;
    if (typeof w.duration_minutes === "number") durationTotal += w.duration_minutes;
  }

  return {
    period: { start_date: start, end_date: end, days_with_data: rows.length },
    averages,
    totals,
    workouts: {
      count: wos.length,
      total_duration_minutes: durationTotal,
      by_type: byType,
    },
  };
}

export async function handleGetHealthTrend(params: Record<string, unknown>) {
  const input = z
    .object({
      metric: z.string(),
      weeks: z.coerce.number().default(4),
    })
    .parse(params);

  if (!HEALTH_NUMERIC_METRICS.includes(input.metric as typeof HEALTH_NUMERIC_METRICS[number])) {
    throw new Error(`Unknown metric '${input.metric}'. Allowed: ${HEALTH_NUMERIC_METRICS.join(", ")}`);
  }

  const start = new Date();
  start.setDate(start.getDate() - input.weeks * 7 + 1);
  const startStr = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("health_metrics_daily")
    .select(`date, ${input.metric}`)
    .gte("date", startStr)
    .order("date", { ascending: true });
  if (error) throw new Error(error.message);

  const series = ((data || []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    date: row.date as string,
    value: (row[input.metric] as number | null) ?? null,
  }));

  const numericValues = series
    .map((p) => p.value)
    .filter((v): v is number => typeof v === "number");
  const stats = numericValues.length
    ? {
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
        avg: Math.round((numericValues.reduce((a, b) => a + b, 0) / numericValues.length) * 100) / 100,
        count: numericValues.length,
      }
    : { min: null, max: null, avg: null, count: 0 };

  return {
    metric: input.metric,
    weeks: input.weeks,
    start_date: startStr,
    series,
    stats,
  };
}

/**
 * Find days where a health metric satisfies a condition, then return thoughts
 * captured on those days. This is the core "joins" feature of OpenBrain Health:
 * surface reflections/notes/decisions from days with poor sleep, low activity,
 * elevated resting HR, etc.
 *
 * Day boundaries are interpreted in the *server's* timezone (UTC by default for
 * Supabase edge runtime). For Israel-local correlation the user's thoughts already
 * live in `created_at` UTC and the join uses `created_at::date == health date`.
 * Off-by-one risk for thoughts captured around midnight UTC, accepted for now.
 */
export async function handleCorrelateHealthThoughts(params: Record<string, unknown>) {
  const input = z
    .object({
      metric: z.string(),
      operator: z.enum(["<", "<=", ">", ">=", "==", "!="]),
      threshold: z.coerce.number(),
      days_lookback: z.coerce.number().default(30),
      thoughts_per_day_limit: z.coerce.number().default(10),
      type: z.string().optional(),
      area: z.string().optional(),
    })
    .parse(params);

  if (!HEALTH_NUMERIC_METRICS.includes(input.metric as typeof HEALTH_NUMERIC_METRICS[number])) {
    throw new Error(`Unknown metric '${input.metric}'. Allowed: ${HEALTH_NUMERIC_METRICS.join(", ")}`);
  }

  const start = new Date();
  start.setDate(start.getDate() - input.days_lookback + 1);
  const startStr = start.toISOString().slice(0, 10);

  // 1. Pull all health rows in window with non-null metric
  const { data: rows, error } = await supabase
    .from("health_metrics_daily")
    .select(`date, ${input.metric}`)
    .gte("date", startStr)
    .not(input.metric, "is", null)
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  // 2. Apply condition client-side (operators don't all map cleanly to PostgREST)
  const compare = (val: number) => {
    switch (input.operator) {
      case "<": return val < input.threshold;
      case "<=": return val <= input.threshold;
      case ">": return val > input.threshold;
      case ">=": return val >= input.threshold;
      case "==": return val === input.threshold;
      case "!=": return val !== input.threshold;
    }
  };
  const matchingDays = ((rows || []) as unknown as Array<Record<string, unknown>>)
    .map((r) => ({ date: r.date as string, value: r[input.metric] as number }))
    .filter((r) => typeof r.value === "number" && compare(r.value));

  if (matchingDays.length === 0) {
    return {
      condition: { metric: input.metric, operator: input.operator, threshold: input.threshold },
      window: { days_lookback: input.days_lookback, start_date: startStr },
      matching_days: [],
      total_thoughts: 0,
      days: [],
    };
  }

  // 3. For each matching day, fetch thoughts whose created_at falls on that calendar date.
  //    Done in a single query with `or` over date ranges to avoid N round-trips.
  const dayClauses = matchingDays.map((d) => {
    const dayStart = `${d.date}T00:00:00Z`;
    const dayEnd = `${d.date}T23:59:59.999Z`;
    return `and(created_at.gte.${dayStart},created_at.lte.${dayEnd})`;
  });

  let q = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at, due_date")
    .or(dayClauses.join(","))
    .order("created_at", { ascending: false });
  if (input.type) q = q.eq("metadata->>type", input.type);
  if (input.area) q = q.eq("metadata->>area", input.area);

  const { data: thoughts, error: thoughtsErr } = await q;
  if (thoughtsErr) throw new Error(thoughtsErr.message);

  // 4. Group thoughts by day, cap per-day count
  const byDate = new Map<string, Array<Record<string, unknown>>>();
  for (const t of (thoughts || []) as Array<{ created_at: string; [k: string]: unknown }>) {
    const date = t.created_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    const arr = byDate.get(date)!;
    if (arr.length < input.thoughts_per_day_limit) arr.push(t);
  }

  const days = matchingDays.map((d) => ({
    date: d.date,
    [input.metric]: d.value,
    thought_count: byDate.get(d.date)?.length ?? 0,
    thoughts: byDate.get(d.date) ?? [],
  }));

  return {
    condition: { metric: input.metric, operator: input.operator, threshold: input.threshold },
    window: { days_lookback: input.days_lookback, start_date: startStr },
    matching_days: matchingDays.length,
    total_thoughts: thoughts?.length ?? 0,
    days,
  };
}
