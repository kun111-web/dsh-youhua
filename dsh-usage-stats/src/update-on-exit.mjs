import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export const registry = 'https://registry.npmjs.org/';
export const pluginNames = ['dsh-usage-stats-local', 'dsh-archive-manager-local'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function writeAtomic(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, data, { flag: 'wx' });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function queueDirectory(profile) { return join(profile, '.dsh-local-plugin-updates'); }
export function preferenceFile(profile, name) { return join(profile, name + '.auto-update.json'); }

function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function otherDesktopIsRunning() {
  const tasklist = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  const { stdout } = await promisify(execFile)(tasklist,
    ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq ' + basename(process.execPath)],
    { timeout: 8000, windowsHide: true });
  const pids = [...stdout.matchAll(/^"[^"\r\n]+","(\d+)"/gm)].map(match => Number(match[1]));
  if (!pids.includes(process.pid)) throw new Error('无法核对 DSH 进程');
  return pids.some(pid => pid !== process.pid);
}

function installedManifest(profile, name) {
  return readJson(join(profile, 'node_modules', name, 'package.json'));
}

export async function collectUpdates(profile, hostVersion, fetchLatest) {
  const directory = queueDirectory(profile);
  const manifest = await readJson(join(profile, 'package.json'));
  const enabled = manifest?.dsh?.profile?.bundles ?? [];
  const updates = [];
  for (const name of pluginNames) {
    const file = join(directory, name + '.json');
    const plan = await readJson(file);
    if (!plan || !enabled.includes(name) || !stableVersion.test(plan.from) ||
        !stableVersion.test(plan.target) || plan.from === plan.target || plan.host !== hostVersion) continue;
    if (!plan.manual && await readJson(preferenceFile(profile, name)) !== true) continue;
    const dependency = manifest.dependencies?.[name];
    if (typeof dependency !== 'string' || !/^[\w.^~<>=*|+ -]+$/.test(dependency) ||
        plan.source !== name + '@' + dependency) continue;
    const installed = await installedManifest(profile, name);
    if (installed?.name !== name || installed.version !== plan.from) continue;
    const meta = await fetchLatest(name);
    const supportedHosts = meta.engines?.dsh;
    if (meta.name !== name || meta.version !== plan.target || meta.deprecated || !meta.dsh?.bundle ||
        typeof supportedHosts !== 'string' || !supportedHosts.split('||').some(version => version.trim() === hostVersion)) continue;
    updates.push({ name, file, target: plan.target, id: plan.id });
  }
  return updates;
}

async function fetchLatest(name) {
  const response = await fetch(registry + name + '/latest', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('npm 元数据查询失败：' + response.status);
  return response.json();
}

async function installWithCli(profile, cli, updates) {
  const child = spawn(process.execPath, [
    '--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add',
    ...updates.map(({ name, target }) => name + '@' + target),
    '--save-exact', '--registry=' + registry
  ], {
    cwd: profile,
    env: { ...process.env, DSH_HOME: dirname(dirname(profile)), ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('DSH 安装失败：' + code)));
  });
}

async function runWorker(profile, cli, anchor, hostPid, desktopPid) {
  if (process.platform !== 'win32' || basename(profile) !== 'desktop' ||
      basename(dirname(profile)) !== 'profiles' ||
      [hostPid, desktopPid].some(pid => !Number.isSafeInteger(pid) || pid < 2 || pid === process.pid)) return;
  const directory = queueDirectory(profile);
  const deadline = Date.now() + 60_000;
  while (live(hostPid) || live(desktopPid)) {
    if (Date.now() >= deadline) return;
    await delay(500);
  }
  if (await otherDesktopIsRunning()) return;

  const { version: hostVersion } = await readJson(anchor);
  const updates = await collectUpdates(profile, hostVersion, fetchLatest);
  if (!updates.length || await otherDesktopIsRunning()) return;
  const stillQueued = [];
  for (const update of updates) {
    const plan = await readJson(update.file);
    if (plan?.id === update.id && (plan.manual || await readJson(preferenceFile(profile, update.name)) === true)) {
      stillQueued.push(update);
    }
  }
  if (!stillQueued.length || await otherDesktopIsRunning()) return;
  try {
    await installWithCli(profile, cli, stillQueued);
    for (const { name, file, target, id } of stillQueued) {
      if ((await installedManifest(profile, name))?.version !== target) throw new Error('安装版本未更新');
      if ((await readJson(file))?.id === id) await unlink(file);
    }
  } catch (error) {
    await writeAtomic(join(directory, 'last-error.json'), JSON.stringify({ at: Date.now(), message: String(error) }));
    throw error;
  }
}

if (import.meta.main && basename(process.argv[1] ?? '') === 'worker-v1.mjs') {
  const [, , profile, cli, anchor, hostPid, desktopPid] = process.argv;
  try { await runWorker(profile, cli, anchor, Number(hostPid), Number(desktopPid)); }
  catch (error) {
    try {
      await writeAtomic(join(queueDirectory(profile), 'last-error.json'),
        JSON.stringify({ at: Date.now(), message: String(error) }));
    } catch { /* The queued plans remain available for a later exit. */ }
    process.exitCode = 1;
  }
}
