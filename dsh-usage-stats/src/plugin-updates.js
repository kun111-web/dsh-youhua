import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const npmRegistry = 'https://registry.npmjs.org/';
const minute = 60_000;
const interval = 6 * 60 * minute;
const queueKey = Symbol.for('dsh-local.plugin-update-queue.v1');
const queues = globalThis[queueKey] ??= new WeakMap();

async function installedBundle(manager, name) {
  return (await manager.listBundles()).find(item => item.name === name);
}

export function createPluginUpdater({ manager, name, version, readAuto, claimUpdate, reportError = () => {} }) {
  const lifetime = new AbortController();
  let status = { phase: 'idle' };
  let pending;
  let nextCheck = 0;

  async function install(automatic) {
    const signal = lifetime.signal;
    if (signal.aborted || (automatic && !await readAuto())) return { phase: 'idle' };
    const bundle = await installedBundle(manager, name);
    if (!bundle?.enabled || !bundle.updatable) return { phase: 'unavailable' };
    if (bundle.version !== version) return { phase: 'restart', target: bundle.version };

    const listed = await manager.listVersions(name, { registry: npmRegistry }, signal);
    if (listed.status !== 'listed' || listed.registry !== npmRegistry) return { phase: 'check-error' };
    if (listed.installed !== version) return { phase: 'restart', target: listed.installed };
    const latest = listed.versions.find(candidate => candidate.tags.includes('latest'));
    if (!latest) return { phase: listed.omitted ? 'check-error' : 'current' };
    if (latest.prerelease || latest.deprecated || latest.incompatible || !latest.bundle) {
      return { phase: 'ineligible', target: latest.version };
    }
    if (signal.aborted || (automatic && !await readAuto())) return { phase: 'idle' };
    signal.throwIfAborted();
    const release = claimUpdate?.();
    if (release === null) return { phase: 'deferred', target: latest.version };
    status = { phase: 'installing', target: latest.version };
    try {
      const answer = await manager.updateBundle(name, latest.version, { registry: npmRegistry });
      const application = answer.result.application;
      const target = latest.version;
      if (application === 'restart-required') return { phase: 'restart', target };
      if (application === 'applied') return { phase: 'updated', target };
      if (answer.restore && !['applied', 'restart-required'].includes(answer.restore.application)) {
        return { phase: 'restore-error', target };
      }
      return { phase: 'install-error', target };
    } finally {
      release?.();
    }
  }

  function check(automatic = false) {
    if (pending) return pending;
    status = { phase: 'checking' };
    // The Host locks individual package mutations. Serialize the full update
    // across both plugins so their remove and install steps do not interleave.
    const key = manager.profile;
    pending = (queues.get(key) ?? Promise.resolve()).then(() => install(automatic)).catch(error => {
      if (lifetime.signal.aborted && status.phase !== 'installing') return { phase: 'idle' };
      reportError(error);
      return { phase: status.phase === 'installing' ? 'install-error' : 'check-error' };
    }).then(result => {
      status = result;
      nextCheck = Date.now() + (result.phase === 'deferred' ? minute
        : result.phase.endsWith('-error') ? 15 * minute : interval);
      pending = undefined;
      return result;
    });
    const operation = pending;
    queues.set(key, operation);
    void operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); });
    return operation;
  }

  return {
    check,
    get status() { return status; },
    resetSchedule() { nextCheck = 0; },
    async tick() {
      if (!lifetime.signal.aborted && !pending && Date.now() >= nextCheck && await readAuto()) {
        if (Date.now() >= nextCheck) await check(true);
      }
    },
    stop() { lifetime.abort(); }
  };
}

function localRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (req.headers['x-dsh-local-plugin-update'] !== '1') return false;
  let address;
  try { address = new URL('http://' + req.headers.host); }
  catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) return false;
  if (req.headers.origin && req.headers.origin !== address.origin) return false;
  return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
}

export function registerPluginUpdates(ctx, { name, version, claimUpdate }) {
  ctx.inject(['pluginManager'], scope => {
    const manager = scope.pluginManager;
    if (!manager.profile?.dir || typeof manager.listVersions !== 'function' ||
        typeof manager.updateBundle !== 'function') return;
    const preference = join(manager.profile.dir, `${name}.auto-update.json`);
    async function readAuto() {
      try { return JSON.parse(await readFile(preference, 'utf8')) === true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    async function saveAuto(enabled) {
      const temp = `${preference}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(enabled) + '\n', { flag: 'wx' });
      try { await rename(temp, preference); }
      finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }

    const reportError = error => scope.logger?.warn(`${name} 检查更新失败：${String(error)}`);
    const updater = createPluginUpdater({ manager, name, version, readAuto, claimUpdate, reportError });
    const tick = () => { void updater.tick().catch(reportError); };
    scope.effect(() => {
      const startup = setTimeout(tick, 30_000);
      const timer = setInterval(tick, minute);
      startup.unref?.();
      timer.unref?.();
      return () => {
        clearTimeout(startup);
        clearInterval(timer);
        // An in-flight installation may be the reason DSH is unloading us.
        updater.stop();
      };
    }, `${name}: automatic updates`);

    for (const action of ['status', 'check', 'enable', 'disable']) {
      scope.effect(() => scope.webServer.register({
        kind: 'exact',
        path: `/api/${name}/updates/${action}`,
        async handler(req, res) {
          const send = (code, data) => {
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff'
            });
            res.end(JSON.stringify(data));
          };
          if (!localRequest(req)) return send(403, { error: '仅可在本机 DSH 检查更新' });
          if (req.method !== (action === 'status' ? 'GET' : 'POST')) {
            return send(405, { error: '请求方法不被允许' });
          }
          try {
            const bundle = await installedBundle(manager, name);
            const available = bundle?.updatable === true && bundle.enabled;
            if (action === 'enable' && !available) return send(409, { error: '请先从 npm 安装并启用插件' });
            if (action === 'check') await updater.check();
            if (action === 'enable' || action === 'disable') {
              await saveAuto(action === 'enable');
              if (action === 'enable') {
                updater.resetSchedule();
                tick();
              }
            }
            const installedVersion = bundle?.version;
            const outcome = updater.status.phase === 'idle' && available && installedVersion !== version
              ? { phase: 'restart', target: installedVersion } : updater.status;
            send(200, { ...outcome, available, auto: await readAuto() });
          } catch (error) {
            reportError(error);
            send(500, { error: '读取或保存更新设置失败，请重试' });
          }
        }
      }), `${name}: update ${action}`);
    }
  });
}
