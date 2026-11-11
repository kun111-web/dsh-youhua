import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readJson, writeAtomic, preferenceFile, queueDirectory, pluginNames, registry } from './update-on-exit.mjs';
import { registerUpdateAdmission } from './plugin-update-admission.js';

const minute = 60_000;
const interval = 6 * 60 * minute;
const hooksKey = Symbol.for('dsh-local.exit-updates.v1');
const exitHooks = globalThis[hooksKey] ??= new Set();

async function installedBundle(manager, name) {
  return (await manager.listBundles()).find(item => item.name === name);
}

export function createPluginUpdater({ manager, name, version, readAuto, stage, reportError = () => {} }) {
  const lifetime = new AbortController();
  let status = { phase: 'idle' };
  let pending;
  let nextCheck = 0;

  async function findUpdate(automatic) {
    const signal = lifetime.signal;
    if (signal.aborted || (automatic && !await readAuto())) return { phase: 'idle' };
    const bundle = await installedBundle(manager, name);
    if (!bundle?.enabled || !bundle.updatable) return { phase: 'unavailable' };
    if (bundle.version !== version) return { phase: 'restart', target: bundle.version };
    const listed = await manager.listVersions(name, { registry }, signal);
    if (listed.status !== 'listed' || listed.registry !== registry) return { phase: 'check-error' };
    if (listed.installed !== version) return { phase: 'restart', target: listed.installed };
    const latest = listed.versions.find(candidate => candidate.tags.includes('latest'));
    if (!latest) return { phase: listed.omitted ? 'check-error' : 'current' };
    if (latest.prerelease || latest.deprecated || latest.incompatible || !latest.bundle) {
      return { phase: 'ineligible', target: latest.version };
    }
    if ((automatic && !await readAuto()) || signal.aborted) return { phase: 'idle' };
    await stage({ from: version, target: latest.version, source: bundle.source, manual: !automatic });
    return { phase: 'queued', target: latest.version };
  }

  function check(automatic = false) {
    if (pending) return pending;
    status = { phase: 'checking' };
    pending = findUpdate(automatic).catch(error => {
      if (lifetime.signal.aborted) return { phase: 'idle' };
      reportError(error);
      return { phase: 'check-error' };
    }).then(result => {
      status = result;
      nextCheck = Date.now() + (result.phase === 'check-error' ? 15 * minute : interval);
      pending = undefined;
      return result;
    });
    return pending;
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

function desktopRuntime(profile) {
  if (process.platform !== 'win32' || !process.connected || !process.argv[1] ||
      typeof profile?.installAnchor !== 'string' || typeof profile.dir !== 'string' ||
      basename(profile.dir) !== 'desktop' || basename(dirname(profile.dir)) !== 'profiles') return;
  const hostLib = join(dirname(dirname(profile.installAnchor)), 'dsh-desktop-host', 'lib');
  if (resolve(process.argv[1]).toLowerCase() !== join(hostLib, 'index.js').toLowerCase()) return;
  return { profile: profile.dir, cli: join(hostLib, 'cli.js'), anchor: profile.installAnchor };
}

function installExitHook({ profile, cli, anchor }) {
  if (exitHooks.has(profile)) return;
  exitHooks.add(profile);
  const directory = queueDirectory(profile);
  const worker = join(directory, 'worker-v1.mjs');
  const desktopPid = process.ppid;
  // Keep this listener through the normal Cordis teardown of the Desktop Host.
  process.once('exit', () => {
    if (!existsSync(worker) || !pluginNames.some(name => existsSync(join(directory, name + '.json')))) return;
    const child = spawn(process.execPath, [worker, profile, cli, anchor, String(process.pid), String(desktopPid)], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: profile,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.on('error', () => {});
    child.unref();
  });
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
    if (!manager.profile?.dir || typeof manager.listVersions !== 'function') return;
    const runtime = desktopRuntime(manager.profile);
    const profile = manager.profile.dir;
    const directory = queueDirectory(profile);
    const queueFile = join(directory, name + '.json');
    const preference = preferenceFile(profile, name);
    const readAuto = async () => await readJson(preference) === true;
    if (runtime) installExitHook(runtime);
    scope.effect(() => registerUpdateAdmission(manager, name, scope, claimUpdate), name + ': update admission');

    async function stage(plan) {
      const { version: host } = await readJson(runtime.anchor);
      await mkdir(directory, { recursive: true });
      const worker = await readFile(new URL('./update-on-exit.mjs', import.meta.url));
      await writeAtomic(join(directory, 'worker-v1.mjs'), worker);
      const previous = await readJson(queueFile);
      const manual = plan.manual || (previous?.target === plan.target && previous.manual === true);
      await writeAtomic(queueFile, JSON.stringify({ ...plan, id: randomUUID(), manual, host, at: Date.now() }));
    }

    async function queuedStatus() {
      const plan = await readJson(queueFile);
      if (plan?.from !== version || (!plan.manual && !await readAuto())) return;
      const failure = await readJson(join(directory, 'last-error.json'));
      return { phase: failure?.at >= plan.at ? 'install-error' : 'queued', target: plan.target };
    }

    const reportError = error => scope.logger?.warn(name + ' 检查更新失败：' + String(error));
    const updater = createPluginUpdater({ manager, name, version, readAuto, stage, reportError });
    const tick = () => { void updater.tick().catch(reportError); };
    scope.effect(() => {
      if (!runtime) return;
      const startup = setTimeout(tick, 30_000);
      const timer = setInterval(tick, minute);
      startup.unref?.();
      timer.unref?.();
      return () => { clearTimeout(startup); clearInterval(timer); updater.stop(); };
    }, name + ': automatic updates');

    for (const action of ['status', 'check', 'enable', 'disable']) {
      scope.effect(() => scope.webServer.register({
        kind: 'exact',
        path: '/api/' + name + '/updates/' + action,
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
            const available = Boolean(runtime && bundle?.updatable && bundle.enabled);
            if ((action === 'check' || action === 'enable') && !available) {
              return send(409, { error: '请在 Windows 版 DSH 启用从 npm 安装的插件' });
            }
            if (action === 'check') await updater.check();
            if (action === 'enable' || action === 'disable') {
              await writeAtomic(preference, JSON.stringify(action === 'enable') + '\n');
              if (action === 'enable') { updater.resetSchedule(); tick(); }
            }
            let outcome = updater.status;
            if (available && bundle.version !== version) outcome = { phase: 'restart', target: bundle.version };
            else if (available && !['checking', 'check-error'].includes(outcome.phase)) {
              outcome = await queuedStatus() ?? (outcome.phase === 'queued' ? { phase: 'idle' } : outcome);
            }
            send(200, { ...outcome, available, auto: await readAuto() });
          } catch (error) {
            reportError(error);
            send(500, { error: '读取或保存更新设置失败，请重试' });
          }
        }
      }), name + ': update ' + action);
    }
  });
}
