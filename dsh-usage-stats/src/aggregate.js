/** DSH-specific aggregation. No ZCode storage or third-party DSH plugin code. */
export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
export const BREAKDOWN_FIELDS = [...TOKEN_FIELDS, 'unclassifiedTokens'];
export const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const dayFormatters = new Map();
export function localDay(time, timeZone) {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(time);
}
export const shiftDay = (day, offset) => new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

function emptyDay(date) {
  return { date, tokens: 0, turns: 0, tools: 0, models: new Map(), tokenBreakdown: { unclassifiedTokens: 0 } };
}

export function addDayTokenBreakdown(target, day) {
  // Legacy records only have the total. Keep it in the unclassified bucket.
  const breakdown = day.tokenBreakdown ?? { unclassifiedTokens: day.tokens };
  for (const field of BREAKDOWN_FIELDS) {
    if (breakdown[field] !== undefined) target[field] = (target[field] ?? 0) + breakdown[field];
  }
}

function addUsageBreakdown(breakdown, usage, tokens, splitTotal) {
  if (splitTotal > tokens) {
    breakdown.unclassifiedTokens += tokens;
    return;
  }
  // Some adapters omit zero cache fields. An exact reported total can establish those zeros.
  const complete = usage.totalTokens === splitTotal && TOKEN_FIELDS.some(field => usage[field] !== undefined);
  for (const field of TOKEN_FIELDS) {
    const amount = usage[field] ?? (complete ? 0 : undefined);
    if (amount !== undefined) breakdown[field] = (breakdown[field] ?? 0) + amount;
  }
  breakdown.unclassifiedTokens += tokens - splitTotal;
}

export function foldSession(events, { inheritedEventCount = 0, timeZone = 'Asia/Shanghai', onUsage } = {}) {
  const days = new Map();
  const seen = new Set();
  let start = Infinity, end = -Infinity, missingUsage = 0, invalidUsage = 0;
  for (let index = inheritedEventCount; index < events.length; index++) {
    const event = events[index];
    if (!event || !validNumber(event.time) || !Number.isSafeInteger(event.seq) || seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (['user/message', 'assistant/message', 'turn/start', 'turn/end', 'tool/call', 'tool/result'].includes(event.type)) {
      start = Math.min(start, event.time); end = Math.max(end, event.time);
    }
    if (!['assistant/message', 'turn/start', 'tool/call'].includes(event.type)) continue;
    const date = localDay(event.time, timeZone);
    let day = days.get(date);
    if (!day) days.set(date, day = emptyDay(date));
    if (event.type === 'turn/start') { day.turns++; continue; }
    if (event.type === 'tool/call') { day.tools++; continue; }
    const usage = event.data?.usage;
    if (!usage) { missingUsage++; continue; }
    if (TOKEN_FIELDS.some(key => usage[key] !== undefined && !validNumber(usage[key])) ||
      (usage.totalTokens !== undefined && !validNumber(usage.totalTokens))) { invalidUsage++; continue; }
    if (usage.totalTokens === undefined && !TOKEN_FIELDS.some(key => validNumber(usage[key]))) { missingUsage++; continue; }
    const splitTotal = TOKEN_FIELDS.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
    const tokens = usage.totalTokens ?? splitTotal;
    addUsageBreakdown(day.tokenBreakdown, usage, tokens, splitTotal);
    const source = event.data?.message?.source;
    const model = typeof source?.model === 'string' ? source.model : '未知模型';
    const provider = typeof source?.provider === 'string' ? source.provider : 'unknown';
    const key = JSON.stringify([provider, model]);
    onUsage?.(event, key, tokens);
    const bucket = day.models.get(key) ?? { key, model, provider, tokens: 0 };
    bucket.tokens += tokens; day.models.set(key, bucket); day.tokens += tokens;
  }
  return { days: [...days.values()].map(day => ({ ...day, models: [...day.models.values()] })),
    durationMs: Number.isFinite(start) ? Math.max(0, end - start) : 0, missingUsage, invalidUsage };
}

export function summarizeSessions(folds, { now = Date.now(), timeZone = 'Asia/Shanghai', skippedSessions = 0 } = {}) {
  const map = new Map();
  let longestSessionMs = 0, missingUsage = 0, invalidUsage = 0;
  for (const fold of folds) {
    longestSessionMs = Math.max(longestSessionMs, fold.durationMs);
    missingUsage += fold.missingUsage; invalidUsage += fold.invalidUsage;
    for (const row of fold.days) {
      let day = map.get(row.date);
      if (!day) map.set(row.date, day = emptyDay(row.date));
      day.tokens += row.tokens; day.turns += row.turns; day.tools += row.tools;
      addDayTokenBreakdown(day.tokenBreakdown, row);
      for (const model of row.models) {
        const target = day.models.get(model.key) ?? { ...model, tokens: 0 };
        target.tokens += model.tokens; day.models.set(model.key, target);
      }
    }
  }
  const days = [...map.values()].sort((a,b) => a.date.localeCompare(b.date))
    .map(day => ({ ...day, models: [...day.models.values()].sort((a,b) => b.tokens-a.tokens) }));
  const today = localDay(now, timeZone);
  const active = days.filter(day => day.tokens > 0 && day.date <= today).map(day => day.date);
  let longestStreakDays = 0, run = 0, previous;
  for (const day of active) { run = previous && shiftDay(previous, 1) === day ? run + 1 : 1; previous = day; longestStreakDays = Math.max(run, longestStreakDays); }
  const currentStreakDays = previous && (previous === today || previous === shiftDay(today, -1)) ? run : 0;
  return { ok: true, generatedAt: now, timeZone, today, days,
    summary: { totalTokens: days.reduce((sum,d) => sum+d.tokens, 0), peakDayTokens: Math.max(0,...days.map(d=>d.tokens)), longestSessionMs, currentStreakDays, longestStreakDays },
    coverage: { sessions: folds.length, skippedSessions, missingUsage, invalidUsage } };
}
