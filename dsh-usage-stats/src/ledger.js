import { hash } from 'node:crypto';
import { TOKEN_FIELDS, foldSession, validNumber } from './aggregate.js';

// Both bundles share one domain and queue through the host facility.
const SLOT = Symbol.for('dsh-local.usage-ledger.v1');
export const LEDGER_NAME = 'usage_stats_local';
export class UsageConflict extends Error {}
const number = value => { if (!validNumber(value)) throw new Error('Invalid usage number'); };
export const recordSchema = { parse(value) {
  if (!value || typeof value !== 'object' || !value.fold || !Array.isArray(value.fold.days)) throw new Error('Invalid usage record');
  if (value.revision !== undefined && typeof value.revision !== 'string' && typeof value.revision !== 'number') throw new Error('Invalid revision');
  const fingerprints = value.usageFingerprints;
  if (fingerprints !== undefined && (typeof fingerprints !== 'string' || fingerprints.length % 64 !== 0 || /[^0-9a-f]/.test(fingerprints))) {
    throw new Error('Invalid usage fingerprints');
  }
  for (const key of ['durationMs', 'missingUsage', 'invalidUsage']) number(value.fold[key]);
  for (const day of value.fold.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.models)) throw new Error('Invalid usage day');
    for (const key of ['tokens', 'turns', 'tools']) number(day[key]);
    const breakdown = day.tokenBreakdown;
    if (breakdown !== undefined) {
      if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) throw new Error('Invalid token breakdown');
      number(breakdown.unclassifiedTokens);
      for (const field of TOKEN_FIELDS) if (breakdown[field] !== undefined) number(breakdown[field]);
    }
    for (const model of day.models) {
      if (typeof model.provider !== 'string' || typeof model.model !== 'string' || model.key !== JSON.stringify([model.provider, model.model])) throw new Error('Invalid usage model');
      number(model.tokens);
    }
  }
  return value;
} };
const zoneSchema = { parse(value) {
  if (typeof value !== 'string') throw new Error('Invalid usage timezone');
  new Intl.DateTimeFormat('en-CA', { timeZone: value });
  return value;
} };

export function createLedger(table, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let tail = Promise.resolve();
  let generation = 0, writing = 0;
  async function change(method, args) {
    writing++;
    try { return await method.apply(table, args); }
    finally { generation++; writing--; }
  }
  const trackedTable = {
    get: id => table.get(id),
    entries: () => table.entries(),
    put: (...args) => change(table.put, args),
    ...(typeof table.delete === 'function' && { delete: (...args) => change(table.delete, args) }),
  };
  return { table: trackedTable, timeZone,
    get generation() { return writing ? undefined : generation; },
    run(job) { const result = tail.then(job); tail = result.catch(() => {}); return result; },
    drain: () => tail,
  };
}

export async function acquireLedger(facility) {
  let state = facility[SLOT];
  if (state?.closing) { await state.closing; return acquireLedger(facility); }
  if (!state) {
    state = { refs: 0 };
    facility[SLOT] = state;
    state.ready = (async () => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const domain = await facility.open({ name: LEDGER_NAME, version: 1, layout: 'per-record',
        global: { schema: zoneSchema, initial: zone }, tables: { sessions: { valueSchema: recordSchema } } });
      try {
        await domain.global.set(domain.global.get());
        return { domain, ledger: createLedger(domain.table('sessions'), domain.global.get()) };
      } catch (error) { await domain.close(); throw error; }
    })();
  }
  state.refs++;
  let opened;
  try { opened = await state.ready; }
  catch (error) { if (--state.refs === 0 && facility[SLOT] === state) delete facility[SLOT]; throw error; }
  let released = false;
  return { ledger: opened.ledger, async release() {
    if (released) return;
    released = true;
    if (--state.refs !== 0) return;
    state.closing = (async () => { await opened.ledger.drain(); await opened.domain.close(); })();
    try { await state.closing; }
    finally { if (facility[SLOT] === state) delete facility[SLOT]; }
  } };
}

export function summarizeSessionUsage(events, inheritedEventCount, timeZone) {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) {
    throw new Error('Invalid inherited prefix');
  }
  const fingerprints = [];
  const fold = foldSession(events, { inheritedEventCount, timeZone, onUsage(event, modelKey, tokens) {
    // Fixed-width hashes allow exact prefix checks without storing conversation content.
    const identity = [event.seq, event.time, event.data.message?.id, modelKey, tokens,
      event.data.usage.totalTokens, ...TOKEN_FIELDS.map(field => event.data.usage[field])];
    fingerprints.push(hash('sha256', JSON.stringify(identity)));
  } });
  return { fold, usageFingerprints: fingerprints.join('') };
}

export async function readSessionUsage(persistence, id, timeZone) {
  const reader = await persistence.open(id, 'read');
  try {
    const { events } = await reader.read();
    return summarizeSessionUsage(events, reader.inheritedEventCount ?? 0, timeZone);
  } finally { await reader.close(); }
}

export function verifySessionUsage(summary, source) {
  if (summary.fold.invalidUsage > 0) {
    throw new UsageConflict(`${source}有 ${summary.fold.invalidUsage} 条异常用量，日志已保留，请核对后重试`);
  }
  return summary;
}

function coversFold(fold, baseline) {
  const days = new Map(fold.days.map(day => [day.date, day]));
  for (const previous of baseline.days) {
    const next = days.get(previous.date);
    if ((next?.tokens ?? 0) < previous.tokens) return false;
    const models = new Map(next?.models.map(model => [model.key, model.tokens]));
    if (previous.models.some(model => (models.get(model.key) ?? 0) < model.tokens)) return false;
    if (TOKEN_FIELDS.some(field => (next?.tokenBreakdown?.[field] ?? 0) < (previous.tokenBreakdown?.[field] ?? 0))) return false;
  }
  return true;
}

function compareUsage(existing, candidate) {
  if (!existing) return 'replace';
  const before = existing.usageFingerprints;
  const after = candidate.usageFingerprints;
  // Legacy records have aggregate evidence only. Upgrade them when a source
  // supplies all recorded totals and splits. A smaller source cannot prove coverage.
  if ((before === undefined || after.startsWith(before)) && coversFold(candidate.fold, existing.fold)) return 'replace';
  if (before?.startsWith(after) && coversFold(existing.fold, candidate.fold)) return 'covered';
  return 'conflict';
}

export async function saveSessionUsage(ledger, id, candidate) {
  const decision = compareUsage(ledger.table.get(id), candidate);
  if (decision === 'replace') {
    await ledger.table.put(id, recordSchema.parse(candidate));
    return 'saved';
  }
  return decision;
}

// Called while the purger holds its write claim and leases. Check all sources
// before saving any summary, so disagreement leaves the entire group intact.
export async function preserveSessionUsage(ledger, persistence, { id, revision, missing }, readCopies) {
  let candidate;
  if (!missing) {
    const summary = verifySessionUsage(await readSessionUsage(persistence, id, ledger.timeZone), '会话主日志');
    candidate = { ...summary, ...(revision === undefined ? {} : { revision }) };
  }
  for await (const copy of readCopies?.(ledger.timeZone) ?? []) {
    verifySessionUsage(copy, '会话副本');
    const decision = compareUsage(candidate, copy);
    if (decision === 'conflict') throw new UsageConflict('会话日志与副本的用量历史有分歧，请核对副本后重试');
    if (decision === 'replace' && candidate?.usageFingerprints !== copy.usageFingerprints) candidate = copy;
  }
  return ledger.run(async () => {
    if (missing && !ledger.table.get(id)) throw new UsageConflict('主日志不存在，也没有已保存的用量摘要，请先核对副本用量');
    if (!candidate || await saveSessionUsage(ledger, id, candidate) === 'conflict') {
      throw new UsageConflict('日志用量与已保存的摘要有分歧，请核对用量后重试');
    }
  });
}
