import { localDay, summarizeSessions } from './aggregate.js';
import { createLedger, readSessionUsage, saveSessionUsage } from './ledger.js';

/** Source removal never removes a saved summary. The host supplies a durable ledger. */
export function createCollector(persistence, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now, ledger } = {}) {
  if (!ledger) {
    const records = new Map();
    ledger = createLedger({ get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => { records.set(id, value); } }, timeZone);
  }
  let pending, cached, closed = false;
  async function scan() {
    const snapshots = await persistence.list();
    const present = new Set(); let skippedSessions = 0, conflictingSessions = 0;
    for (const snapshot of snapshots) {
      const id = snapshot.header.id; present.add(id);
      const existing = ledger.table.get(id);
      if (existing && snapshot.revision !== undefined && existing.revision === snapshot.revision &&
        existing.usageFingerprints !== undefined &&
        existing.fold.days.every(day => day.tokenBreakdown !== undefined)) continue;
      const revision = snapshot.revision;
      let candidate;
      try {
        candidate = await readSessionUsage(persistence, id, ledger.timeZone);
        if (typeof persistence.stat === 'function') {
          const current = await persistence.stat(id);
          if (!current) { present.delete(id); continue; }
          if (current.revision !== revision) { skippedSessions++; continue; }
        }
      } catch { skippedSessions++; continue; }
      const saved = await ledger.run(() => {
        // A purge may have saved this session while its older snapshot was read.
        if (ledger.table.get(id) !== existing) return 'superseded';
        return saveSessionUsage(ledger, id, { ...candidate, ...(revision === undefined ? {} : { revision }) });
      });
      if (saved === 'conflict') conflictingSessions++;
    }
    const generatedAt = now(), generation = ledger.generation;
    if (generation === undefined || cached?.generation !== generation ||
        cached.snapshot.today !== localDay(generatedAt, ledger.timeZone) ||
        cached.present.size !== present.size || [...present].some(id => !cached.present.has(id))) {
      const entries = [...ledger.table.entries()];
      const snapshot = summarizeSessions(entries.map(([, value]) => value.fold), { now: generatedAt, timeZone: ledger.timeZone });
      snapshot.coverage.retainedSessions = entries.filter(([id]) => !present.has(id)).length;
      cached = { generation, snapshot, present };
    }
    return { ...cached.snapshot, generatedAt,
      coverage: { ...cached.snapshot.coverage, skippedSessions, conflictingSessions } };
  }
  function collect() {
    if (closed) return Promise.reject(new Error('Usage collector is closed'));
    return pending ??= scan().finally(() => { pending = undefined; });
  }
  collect.close = async () => {
    closed = true;
    await pending?.catch(() => {});
  };
  return collect;
}
