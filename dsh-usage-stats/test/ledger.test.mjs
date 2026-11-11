import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireLedger, createLedger, preserveSessionUsage, recordSchema, summarizeSessionUsage } from '../src/ledger.js';
import { foldSession } from '../src/aggregate.js';
import { createCollector } from '../src/collector.js';
import { heatmap, windowData } from '../src/client/model.js';
import { storageFixture } from './helpers/storage.mjs';

const now = Date.parse('2026-11-09T12:00:00+08:00');
const event = (seq, tokens) => ({ seq, time: now, type: 'assistant/message', data: {
  usage: { inputTokens: tokens - 50, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 5, totalTokens: tokens },
  message: { content: 'private conversation', source: { provider: 'test', model: 'model' } },
} });
function source() {
  let present = true, revision = '1', events = [event(0, 100)], cut = 0;
  return { persistence: {
    list: async () => present ? [{ header: { id: 's' }, revision }] : [],
    open: async () => { if (!present) throw Error('missing'); return { inheritedEventCount: cut, read: async () => ({ events }), close: async () => {} }; },
  }, remove: () => { present = false; }, restore: () => { present = true; },
  update: () => { revision = '2'; events = [...events, event(1, 50)]; },
  rewind: () => { revision = 'backup'; events = events.slice(0, 1); },
  replaceLast: (tokens, time) => { revision = 'diverged'; events = [events[0], { ...event(1, tokens), time }]; },
  fork: () => { events = [event(0, 900), event(1, 100)]; cut = 1; } };
}

test('删除并重新打开持久化后，摘要、日期、模型和热力图保持一致', async () => {
  const storage = storageFixture(), src = source();
  let handle = await acquireLedger(storage.facility);
  const before = await createCollector(src.persistence, { ledger: handle.ledger, now: () => now })();
  src.remove(); await handle.release();
  handle = await acquireLedger(storage.facility);
  const collect = createCollector(src.persistence, { ledger: handle.ledger, now: () => now });
  const after = await collect();
  assert.deepEqual(after.summary, before.summary); assert.deepEqual(after.days, before.days);
  assert.deepEqual(windowData(after, 30), windowData(before, 30));
  for (const mode of ['daily', 'weekly', 'cumulative']) assert.deepEqual(heatmap(after, mode), heatmap(before, mode));
  assert.equal(after.coverage.retainedSessions, 1);
  assert.deepEqual((await collect()).summary, after.summary);
  assert(!storage.disk.get('s').includes('private conversation'));
  await handle.release();
});

test('未打开统计页也可在删除前记录最后用量；重复保存、恢复和更新不重计', async () => {
  const storage = storageFixture(), src = source(), handle = await acquireLedger(storage.facility);
  src.update();
  await preserveSessionUsage(handle.ledger, src.persistence, { id: 's', revision: '2' });
  await preserveSessionUsage(handle.ledger, src.persistence, { id: 's', revision: '2' });
  src.remove();
  const collect = createCollector(src.persistence, { ledger: handle.ledger, now: () => now });
  const deleted = await collect();
  assert.equal(deleted.summary.totalTokens, 150);
  assert.deepEqual(deleted.days[0].tokenBreakdown, {
    inputTokens: 50, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10, unclassifiedTokens: 0,
  });
  src.restore(); assert.equal((await collect()).summary.totalTokens, 150);
  assert.equal((await collect()).coverage.retainedSessions, 0);
  await handle.release();
});

test('旧备份无法通过统计刷新或再次删除覆盖已有用量', async () => {
  const src = source();
  const handle = await acquireLedger(storageFixture().facility);
  try {
    const ledger = handle.ledger;
    const collect = createCollector(src.persistence, { ledger, now: () => now });
    src.update();
    await preserveSessionUsage(ledger, src.persistence, { id: 's', revision: '2' });
    const saved = ledger.table.get('s');
    src.rewind();
    const old = await collect();
    assert.equal(old.summary.totalTokens, 150);
    assert.equal(old.coverage.conflictingSessions, 0);
    await preserveSessionUsage(ledger, src.persistence, { id: 's', revision: 'backup' });
    assert.deepEqual(ledger.table.get('s'), saved);
    src.remove();
    assert.equal((await collect()).summary.totalTokens, 150);
  } finally { await handle.release(); }
});

test('旧副本续聊产生新用量时提示冲突并拒绝删除，累计相同也检查事件身份', async () => {
  const src = source();
  const handle = await acquireLedger(storageFixture().facility);
  try {
    const ledger = handle.ledger;
    const collect = createCollector(src.persistence, { ledger, now: () => now });
    src.update();
    await collect();
    const saved = ledger.table.get('s');
    for (const [tokens, time] of [[75, now + 86400000], [50, now + 1000]]) {
      src.replaceLast(tokens, time);
      const refreshed = await collect();
      assert.equal(refreshed.summary.totalTokens, 150);
      assert.equal(refreshed.coverage.conflictingSessions, 1);
      await assert.rejects(preserveSessionUsage(ledger, src.persistence, { id: 's', revision: 'diverged' }), /有分歧/);
      assert.deepEqual(ledger.table.get('s'), saved);
    }
  } finally { await handle.release(); }
});

test('主日志缺失时验证副本，兼容的较新副本补齐用量，冲突副本保留摘要', async () => {
  const src = source();
  const handle = await acquireLedger(storageFixture().facility);
  try {
    const { ledger } = handle;
    const newer = [event(0, 100), event(1, 50)];
    const divergent = [event(0, 100), event(1, 75)];
    const copies = (...logs) => async function* (zone) {
      for (const log of logs) yield summarizeSessionUsage(log, 0, zone);
    };
    const missing = { id: 's', missing: true };
    await preserveSessionUsage(ledger, src.persistence, { id: 's', revision: '1' });
    src.remove();
    const saved = ledger.table.get('s');
    await assert.rejects(preserveSessionUsage(ledger, src.persistence, missing, copies(newer, divergent)), /副本的用量历史有分歧/);
    assert.deepEqual(ledger.table.get('s'), saved);
    await preserveSessionUsage(ledger, src.persistence, missing, copies(newer, [event(0, 100)]));
    assert.equal(ledger.table.get('s').revision, undefined);
    assert.equal((await createCollector(src.persistence, { ledger, now: () => now })()).summary.totalTokens, 150);
  } finally { await handle.release(); }
});

test('旧格式摘要无法证明较短的副本已覆盖时拒绝删除', async () => {
  const storage = storageFixture();
  storage.disk.set('s', JSON.stringify({ fold: foldSession([event(0, 100), event(1, 50)]) }));
  const handle = await acquireLedger(storage.facility);
  try {
    const src = source();
    await assert.rejects(preserveSessionUsage(handle.ledger, src.persistence, { id: 's' }), /有分歧/);
    assert.equal(handle.ledger.table.get('s').fold.days[0].tokens, 150);
  } finally { await handle.release(); }
});

test('升级重读同 revision 的旧摘要，已删除旧摘要只保留总量', async () => {
  const storage = storageFixture();
  const legacyFold = foldSession([event(0, 100)]);
  delete legacyFold.days[0].tokenBreakdown;
  const record = JSON.stringify({ revision: '1', fold: legacyFold });
  storage.disk.set('s', record);
  storage.disk.set('deleted', record);
  const src = source();
  const handle = await acquireLedger(storage.facility);
  try {
    const collect = createCollector(src.persistence, { ledger: handle.ledger, now: () => now });
    const updated = await collect();
    assert.equal(updated.summary.totalTokens, 200);
    assert.equal(updated.coverage.retainedSessions, 1);
    assert.deepEqual(updated.days[0].tokenBreakdown, {
      inputTokens: 50, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 5, unclassifiedTokens: 100,
    });
    assert.equal(storage.disk.get('deleted'), record);
    assert.equal(handle.ledger.table.get('s').fold.days[0].tokenBreakdown.cacheReadTokens, 40);
    assert.match(handle.ledger.table.get('s').usageFingerprints, /^[a-f0-9]{64}$/);
    src.persistence.open = async () => { throw Error('unexpected read'); };
    assert.equal((await collect()).coverage.skippedSessions, 0);
  } finally { await handle.release(); }
});

test('持久化保存仍排除分叉继承前缀', async () => {
  const storage = storageFixture(), src = source(), handle = await acquireLedger(storage.facility);
  src.fork(); await preserveSessionUsage(handle.ledger, src.persistence, { id: 's' }); src.remove();
  assert.equal((await createCollector(src.persistence, { ledger: handle.ledger, now: () => now })()).summary.totalTokens, 100);
  await handle.release();
});

test('两个插件并发打开共用一个存储，卸载其中之一不会关闭另一方存储', async () => {
  const storage = storageFixture();
  const [a, b] = await Promise.all([acquireLedger(storage.facility), acquireLedger(storage.facility)]);
  assert.equal(a.ledger, b.ledger); assert.equal(storage.opened(), 1);
  await a.release(); await a.release(); assert.equal(storage.closed(), 0);
  await b.release(); assert.equal(storage.closed(), 1);
  const c = await acquireLedger(storage.facility); assert.equal(storage.opened(), 2); await c.release();
});

test('失败写入不会当作成功缓存，后续刷新可重试', async () => {
  const src = source(), records = new Map(); let fail = true;
  const ledger = createLedger({ get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => {
    if (fail) throw Error('disk full'); records.set(id, value);
  } });
  const collect = createCollector(src.persistence, { ledger, now: () => now });
  await assert.rejects(collect(), /disk full/); assert.equal(records.size, 0);
  fail = false; assert.equal((await collect()).summary.totalTokens, 100);
});

test('旧日志读取挂起时仍可保存删除前用量，恢复读取后不覆盖最终摘要', async () => {
  const storage = storageFixture(), src = source(), handle = await acquireLedger(storage.facility);
  let entered, resume; const ready = new Promise(r => entered = r), gate = new Promise(r => resume = r);
  const open = src.persistence.open; let first = true;
  src.persistence.open = async (...args) => {
    const reader = await open(...args); const read = reader.read;
    reader.read = async () => { const value = await read(); if (first) { first = false; entered(); await gate; } return value; };
    return reader;
  };
  const collect = createCollector(src.persistence, { ledger: handle.ledger, now: () => now });
  const scanning = collect(); await ready; src.update();
  try {
    await preserveSessionUsage(handle.ledger, src.persistence, { id: 's', revision: '2' });
    src.remove();
  } finally { resume(); }
  await scanning;
  assert.equal((await collect()).summary.totalTokens, 150); await handle.release();
});

test('扫描期间日志版本变化时不以旧 revision 保存新日志', async () => {
  const src = source();
  const list = src.persistence.list;
  src.persistence.stat = async () => (await list())[0];
  src.persistence.list = async () => {
    const snapshots = await list();
    src.update();
    src.persistence.list = list;
    return snapshots;
  };
  const collect = createCollector(src.persistence, { now: () => now });
  const changed = await collect();
  assert.equal(changed.coverage.skippedSessions, 1);
  assert.equal(changed.summary.totalTokens, 0);
  const stable = await collect();
  assert.equal(stable.coverage.skippedSessions, 0);
  assert.equal(stable.summary.totalTokens, 150);
});

test('损坏的持久化记录拒绝加载，避免静默清零', () => {
  assert.throws(() => recordSchema.parse({ fold: { days: [], durationMs: -1, missingUsage: 0, invalidUsage: 0 } }));
  const fold = foldSession([event(0, 100)]);
  fold.days[0].tokenBreakdown.cacheReadTokens = -1;
  assert.throws(() => recordSchema.parse({ fold }), /Invalid usage number/);
});

test('删除前对主日志和副本拒绝同一种异常用量，保留原台账', async () => {
  const src = source(), handle = await acquireLedger(storageFixture().facility);
  try {
    const { ledger } = handle;
    await preserveSessionUsage(ledger, src.persistence, { id: 's', revision: '1' });
    const original = ledger.table.get('s');
    const malformed = event(1, 20);
    const open = src.persistence.open;
    src.persistence.open = async () => ({
      read: async () => ({ events: [event(0, 100), malformed] }), close: async () => {},
    });
    await assert.rejects(preserveSessionUsage(ledger, src.persistence, { id: 's' }), /主日志有 1 条异常用量/);
    src.persistence.open = open;
    const invalidCopy = summarizeSessionUsage([event(0, 100), malformed], 0, ledger.timeZone);
    await assert.rejects(preserveSessionUsage(ledger, src.persistence, { id: 's' }, () => [invalidCopy]), /副本有 1 条异常用量/);
    assert.strictEqual(ledger.table.get('s'), original);
  } finally { await handle.release(); }
});

test('未变台账复用汇总，删除前写入、跨日和会话消失刷新快照', async () => {
  const src = source(), records = new Map();
  let iterated = 0, time = now;
  const ledger = createLedger({
    get: id => records.get(id),
    entries: () => { iterated++; return records.entries(); },
    put: async (id, record) => { records.set(id, record); },
  }, 'Asia/Shanghai');
  const collect = createCollector(src.persistence, { ledger, now: () => time });
  const first = await collect();
  time += 1000;
  const cached = await collect();
  assert.equal(iterated, 1);
  assert.strictEqual(cached.days, first.days);
  assert.equal(cached.generatedAt, time);
  src.update();
  await preserveSessionUsage(ledger, src.persistence, { id: 's', revision: '2' });
  assert.equal((await collect()).summary.totalTokens, 150);
  assert.equal(iterated, 2);
  time += 86400000;
  const nextDay = await collect();
  assert.notEqual(nextDay.today, first.today);
  assert.equal(iterated, 3);
  src.remove();
  assert.equal((await collect()).coverage.retainedSessions, 1);
  assert.equal(iterated, 4);
});
