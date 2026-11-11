import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginUpdater } from '../src/plugin-updates.js';

const registry = 'https://registry.npmjs.org/';
const version = '1.3.0';
const name = 'dsh-usage-stats-local';
const latest = { version: '1.4.0', tags: ['latest'], bundle: true, prerelease: false };

function fixture() {
  let auto = false;
  const calls = [];
  const inventory = { name, version, enabled: true, updatable: true };
  const versions = { status: 'listed', installed: version, registry, versions: [latest] };
  const manager = {
    profile: {},
    async listBundles() { return [inventory]; },
    async listVersions(pkg, options) {
      calls.push(['list', pkg, options.registry]);
      return versions;
    },
    async updateBundle(pkg, target, options) {
      calls.push(['update', pkg, target, options.registry]);
      return { result: { application: 'restart-required' } };
    }
  };
  const readAuto = async () => auto;
  return { calls, inventory, versions, manager, readAuto, setAuto(value) { auto = value; } };
}

test('manual check installs the npm latest stable version and reports restart', async () => {
  const f = fixture();
  f.versions.versions.unshift({ ...latest, version: '1.5.0-rc.1', tags: ['next'], prerelease: true });
  const updater = createPluginUpdater({ ...f, name, version });
  await updater.tick();
  assert.deepEqual(f.calls, []);
  const running = updater.check();
  assert.equal(updater.check(), running);
  assert.deepEqual(await running, { phase: 'restart', target: latest.version });
  assert.deepEqual(f.calls, [['list', name, registry], ['update', name, latest.version, registry]]);
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

test('archives can defer installation and a later check retries it', async () => {
  const f = fixture();
  let busy = true;
  let released = false;
  const updater = createPluginUpdater({
    ...f, name, version, claimUpdate: () => busy ? null : () => { released = true; }
  });
  assert.deepEqual(await updater.check(), { phase: 'deferred', target: latest.version });
  assert.equal(f.calls.length, 1);
  busy = false;
  await updater.check();
  assert.equal(f.calls.at(-1)[0], 'update');
  assert.equal(released, true);
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

test('reports a failed native rollback instead of reporting an installed version', async () => {
  const f = fixture();
  f.manager.updateBundle = async () => ({
    result: { application: 'failed' }, restore: { application: 'failed' }
  });
  const updater = createPluginUpdater({ ...f, name, version });
  assert.deepEqual(await updater.check(), { phase: 'restore-error', target: latest.version });
});
