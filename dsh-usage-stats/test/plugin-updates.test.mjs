import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPluginUpdater } from '../src/plugin-updates.js';
import { hasActiveWork, registerUpdateAdmission } from '../src/plugin-update-admission.js';
import { collectUpdates, preferenceFile, queueDirectory } from '../src/update-on-exit.mjs';

const registry = 'https://registry.npmjs.org/';
const version = '1.3.0';
const name = 'dsh-usage-stats-local';
const latest = { version: '1.4.0', tags: ['latest'], bundle: true, prerelease: false };

function fixture() {
  let auto = false;
  const calls = [];
  const inventory = { name, version, source: name + '@' + version, enabled: true, updatable: true };
  const versions = { status: 'listed', installed: version, registry, versions: [latest] };
  const manager = {
    profile: {},
    async listBundles() { return [inventory]; },
    async listVersions(pkg, options) {
      calls.push(['list', pkg, options.registry]);
      return versions;
    }
  };
  const readAuto = async () => auto;
  const stage = async plan => calls.push(['stage', plan]);
  return { calls, inventory, versions, manager, readAuto, stage, setAuto(value) { auto = value; } };
}

test('manual check queues the npm latest stable version for exit', async () => {
  const f = fixture();
  f.versions.versions.unshift({ ...latest, version: '1.5.0-rc.1', tags: ['next'], prerelease: true });
  const updater = createPluginUpdater({ ...f, name, version });
  await updater.tick();
  assert.deepEqual(f.calls, []);
  const running = updater.check();
  assert.equal(updater.check(), running);
  assert.deepEqual(await running, { phase: 'queued', target: latest.version });
  assert.deepEqual(f.calls, [['list', name, registry], ['stage', {
    from: version, target: latest.version, source: name + '@' + version, manual: true
  }]]);
  f.inventory.version = latest.version;
  assert.equal((await updater.check()).phase, 'restart');
  assert.equal(f.calls.length, 2);
});

test('background check honours opt-out while a lookup is in progress', async () => {
  const f = fixture();
  f.setAuto(true);
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  f.manager.listVersions = () => { started.resolve(); return reply.promise; };
  const updater = createPluginUpdater({ ...f, name, version });
  const tick = updater.tick();
  await started.promise;
  f.setAuto(false);
  reply.resolve(f.versions);
  await tick;
  assert.deepEqual(f.calls, []);
  assert.equal(updater.status.phase, 'idle');
});

test('a background check only records the update and preserves the opt-out flag', async () => {
  const f = fixture();
  f.setAuto(true);
  const updater = createPluginUpdater({ ...f, name, version });
  await updater.tick();
  assert.equal(updater.status.phase, 'queued');
  assert.deepEqual(f.calls.at(-1), ['stage', {
    from: version, target: latest.version, source: name + '@' + version, manual: false
  }]);
});

test('skips local installs, registry fallbacks, incompatible releases and prereleases', async () => {
  const f = fixture();
  const updater = createPluginUpdater({ ...f, name, version });
  f.inventory.updatable = false;
  assert.equal((await updater.check()).phase, 'unavailable');
  f.inventory.updatable = true;
  f.versions.registry = 'https://registry.npmmirror.com/';
  assert.equal((await updater.check()).phase, 'check-error');
  f.versions.registry = registry;
  f.versions.versions = [{ ...latest, incompatible: { reason: 'DSH version' } }];
  assert.equal((await updater.check()).phase, 'ineligible');
  f.versions.versions = [{ ...latest, prerelease: true }];
  assert.equal((await updater.check()).phase, 'ineligible');
  f.versions.versions = [];
  assert.equal((await updater.check()).phase, 'current');
  assert.ok(f.calls.every(call => call[0] === 'list'));
});

test('native DSH update rechecks activity at its first mutation, after its network lookup', async () => {
  const lookup = Promise.withResolvers();
  const agent = { id: 'session', status: 'idle', inbox: { hasPending: false } };
  let mutated = 0;
  const ctx = { get(key) {
    if (key === 'agents') return { list: () => [agent] };
    if (key === 'jobs') return { list: () => [] };
  } };
  const manager = {
    async updateBundle() {
      await lookup.promise;
      return this.change(() => { mutated++; return 'applied'; }, { stage: 'remove' });
    },
    async change(operation) {
      const result = {};
      const application = await operation(result);
      return { ...result, application };
    }
  };
  const native = manager.updateBundle;
  const dispose = registerUpdateAdmission(manager, name, ctx);
  const attempt = manager.updateBundle(name);
  agent.status = 'running';
  lookup.resolve();
  assert.match((await attempt).error.diagnostic, /任务正在执行/);
  assert.equal(mutated, 0);
  agent.status = 'idle';
  assert.equal((await manager.updateBundle(name)).application, 'applied');
  assert.equal(mutated, 1);
  dispose();
  assert.equal(manager.updateBundle, native);
});

test('task protection includes queued input, jobs without an owner, and executing schedules', () => {
  const agent = { id: 'test', status: 'idle', inbox: { hasPending: false } };
  const jobs = [];
  const schedule = { runtime: { executing: new Set() } };
  const services = { agents: { list: () => [agent] }, jobs: { list: id => id ? [] : jobs }, schedule };
  const ctx = { get: key => services[key] };
  assert.equal(hasActiveWork(ctx), false);
  agent.inbox.hasPending = true;
  assert.equal(hasActiveWork(ctx), true);
  agent.inbox.hasPending = false;
  jobs.push({ status: 'stopping' });
  assert.equal(hasActiveWork(ctx), true);
  jobs.length = 0;
  schedule.runtime.executing.add('job');
  assert.equal(hasActiveWork(ctx), true);
  assert.equal(hasActiveWork({ get() {} }), true);
});

test('worker revalidates npm source, compatibility and preferences before installing a queued version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-update-plan-test-'));
  const save = (path, value) => writeFile(path, JSON.stringify(value));
  try {
    const plugin = join(dir, 'node_modules', name);
    const queue = queueDirectory(dir);
    await mkdir(plugin, { recursive: true });
    await mkdir(queue);
    await save(join(plugin, 'package.json'), { name, version });
    const manifest = { dependencies: { [name]: version }, dsh: { profile: { bundles: [name] } } };
    await save(join(dir, 'package.json'), manifest);
    const host = '0.2.2-rc.1';
    const plan = { id: 'fixture', manual: false, host, from: version, target: latest.version, source: name + '@' + version };
    const file = join(queue, name + '.json');
    await save(file, plan);
    const meta = { name, version: latest.version, engines: { dsh: host }, dsh: { bundle: {} } };
    const lookup = async () => meta;
    assert.deepEqual(await collectUpdates(dir, host, lookup), []);
    await save(preferenceFile(dir, name), true);
    assert.deepEqual((await collectUpdates(dir, host, lookup)).map(row => row.target), [latest.version]);
    meta.engines.dsh = '0.2.2-rc.1 || 0.2.2-rc.2';
    assert.deepEqual((await collectUpdates(dir, host, lookup)).map(row => row.target), [latest.version]);
    const newHost = '0.2.2-rc.2';
    await save(file, { ...plan, host: newHost });
    assert.deepEqual((await collectUpdates(dir, newHost, lookup)).map(row => row.target), [latest.version]);
    meta.engines.dsh = host;
    assert.deepEqual(await collectUpdates(dir, newHost, lookup), []);
    meta.engines.dsh = '0.2.2-rc.1 || 0.2.2-rc.2';
    await save(file, plan);
    meta.version = '1.5.0';
    assert.deepEqual(await collectUpdates(dir, host, lookup), []);
    meta.version = latest.version;
    manifest.dependencies[name] = 'file:/local/plugin.tgz';
    await save(join(dir, 'package.json'), manifest);
    assert.deepEqual(await collectUpdates(dir, host, lookup), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
