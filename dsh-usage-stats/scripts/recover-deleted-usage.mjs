// One-time recovery from existing local, unseeded v4 copies. Run with the
// desktop's Electron Node runtime so native storage modules can load from asar.
// Creates a NEW ledger only; never overwrites an already initialized ledger.
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { foldSession } from '../src/aggregate.js';
import { acquireLedger, recordSchema } from '../src/ledger.js';

const args = process.argv.slice(2);
const option = key => { const index = args.indexOf(key); if (index < 0 || !args[index + 1]) throw Error('Missing ' + key); return path.resolve(args[index + 1]); };
const source = option('--source'), target = option('--target');
const deleted = JSON.parse(await readFile(path.join(target, 'storages/archive_manager_local.json'), 'utf8')).tables.deleted;
const ids = new Set(Object.entries(deleted).filter(([, value]) => value.purgedAt).map(([id]) => id));
async function* logs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* logs(file);
    else if (/^session\.v4\.jsonl(?:\.zstd)?$/.test(entry.name)) yield file;
  }
}
for await (const file of logs(path.join(target, 'sessions'))) {
  if (ids.has(path.basename(path.dirname(file)))) throw Error('A marked session still has a live log; refusing offline recovery');
}
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const records = new Map(), recovered = [];
for await (const file of logs(source)) {
  const id = path.basename(path.dirname(file)); if (!ids.has(id)) continue;
  if (records.has(id)) throw Error('Multiple source copies for ' + id);
  const raw = await readFile(file);
  // The bundled Electron zlib can stop after the first concatenated zstd frame
  // (the header). Use Node 24's complete decompressor for offline copies.
  const decoded = !file.endsWith('.zstd') ? raw : process.versions.electron
    ? execFileSync('node', ['-e', 'process.stdout.write(require("node:zlib").zstdDecompressSync(require("node:fs").readFileSync(0)))'], { input: raw, maxBuffer: 512 * 1024 * 1024, windowsHide: true })
    : zstdDecompressSync(raw);
  const rows = decoded.toString('utf8').trim().split('\n').map(JSON.parse);
  const header = rows.shift();
  if (header.id !== id || header.version !== 4 || header.isSeeded !== false) throw Error('Only matching, unseeded v4 copies are supported');
  if (!rows.length) throw Error('Empty source copy; refusing to initialize recovery');
  if (rows.some((e, i) => e.seq !== i || !Number.isSafeInteger(e.time) || e.time < 0 || e.time > deleted[id].purgedAt)) throw Error('Unexpected sequence/time in source copy');
  const fold = foldSession(rows, { timeZone: zone });
  if (fold.invalidUsage) throw Error('Invalid usage in source copy');
  records.set(id, recordSchema.parse({ fold }));
  recovered.push({ id, source: file, sha256: createHash('sha256').update(raw).digest('hex'),
    lastEvent: Math.max(0, ...rows.map(e => e.time)), tokens: fold.days.reduce((sum, day) => sum + day.tokens, 0) });
}
if (!records.size) throw Error('No matching deleted session copies found');
const report = { recoveredAt: new Date().toISOString(), timeZone: zone, target, source,
  sourceSnapshotOnly: true, recovered, totalTokens: recovered.reduce((sum, item) => sum + item.tokens, 0) };
if (args.includes('--apply')) {
  const ledgerPath = path.join(target, 'storages/usage_stats_local');
  try { await access(ledgerPath); if (!args.includes('--repair-empty')) throw Error('Ledger already exists; refusing to overwrite an active ledger'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runtime = 'D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/';
  const { JsonStorageBackend } = await import(pathToFileURL(runtime + 'dsh-storage-json/lib/index.js').href);
  const { DomainFacility } = await import(pathToFileURL(runtime + 'dsh-storage-domain/lib/index.js').href);
  const backend = new JsonStorageBackend(path.join(target, 'storages'));
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} } }, { backend: 'json' });
  const handle = await acquireLedger(facility);
  try {
    if (args.includes('--repair-empty')) for (const [id, old] of handle.ledger.table.entries()) {
      if (!records.has(id) || old.fold.days.length || old.fold.durationMs || old.fold.missingUsage || old.fold.invalidUsage) throw Error('Repair only accepts empty records from a failed initialization');
    }
    for (const [id, record] of records) await handle.ledger.table.put(id, record);
  }
  finally { await handle.release(); await backend.close(); }
  // Reopen through the host's validating domain API to verify persistence.
  const checkBackend = new JsonStorageBackend(path.join(target, 'storages'));
  const checkFacility = new DomainFacility({ storage: { backend: { get: () => checkBackend } }, emit() {}, logger: { warn() {} } }, { backend: 'json' });
  const check = await acquireLedger(checkFacility);
  try { for (const [id, record] of records) if (JSON.stringify(check.ledger.table.get(id)) !== JSON.stringify(record)) throw Error('Recovery readback mismatch'); }
  finally { await check.release(); await checkBackend.close(); }
  await writeFile(path.resolve(import.meta.dirname, '../qa/deleted-usage-recovery.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ applied: args.includes('--apply'), sessions: records.size, totalTokens: report.totalTokens, sourceSnapshotOnly: true }));
