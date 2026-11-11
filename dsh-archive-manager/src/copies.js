import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, unlink } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';
import path from 'node:path';
import { inspectLog, PurgeRefusal } from './purge.js';
import { summarizeSessionUsage, verifySessionUsage } from '../../dsh-usage-stats/src/ledger.js';

const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const normalized = file => path.resolve(file).toLowerCase();
async function exists(file) { try { return await lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; } }
const listDirectory = dir => readdir(dir, { withFileTypes: true });
class UnreadableLog extends PurgeRefusal {}

async function inspectBackupRoot(root, readDirectory) {
  const result = { path: root, status: 'available' };
  try {
    const stat = await exists(root);
    if (!stat) return { ...result, status: 'missing' };
    if (stat.isSymbolicLink() || !stat.isDirectory() || normalized(await realpath(root)) !== normalized(root)) {
      return { ...result, status: 'invalid' };
    }
    return { ...result, stat, entries: await readDirectory(root, stat) };
  } catch {
    return { ...result, status: 'unreadable' };
  }
}

// Only registered sandbox trees are explored. Never follow links or search drives.
export async function discoverSessionRoots(scanRoots, readDirectory = listDirectory) {
  const inspected = await Promise.all(scanRoots.map(root => inspectBackupRoot(root, readDirectory)));
  const backupRoots = inspected.map(({ path, status }) => ({ path, status }));
  const unavailable = backupRoots.filter(root => root.status !== 'available');
  if (unavailable.length) throw new PurgeRefusal('已登记的备份目录不可用，已暂停清理：' + unavailable.map(root => root.path).join('、'));
  const found = new Set();
  const cacheDirectories = new Map();
  async function walk(dir, depth, inspectedRoot) {
    const stat = inspectedRoot?.stat ?? await exists(dir);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PurgeRefusal('副本扫描目录包含链接或异常路径：' + dir);
    if (path.basename(dir) === 'sessions' && path.basename(path.dirname(dir)) !== 'storages') { found.add(path.resolve(dir)); return; }
    if (depth >= 6) throw new PurgeRefusal('副本目录层级过深，未完成扫描：' + dir);
    const entries = inspectedRoot?.entries ?? await readDirectory(dir, stat);
    const cache = entries.some(entry => entry.name === 'storages') ? await cacheDirectory(dir) : undefined;
    cacheDirectories.set(dir, cache);
    if (cache) found.add(path.join(dir, 'sessions'));
    for (const entry of entries) {
      if (['node_modules', 'profiles', 'storages', '.git', 'copy-tests', 'purge-tests'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) { if (entry.name === 'sessions') throw new PurgeRefusal('会话副本目录是链接：' + path.join(dir, entry.name)); continue; }
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
    }
  }
  for (const root of inspected) await walk(root.path, 0, root);
  return { roots: [...found].sort(), cacheDirectories, backupRoots };
}

async function cacheDirectory(home) {
  let current = home;
  for (const segment of ['storages', 'session_projcache', 'sessions']) {
    current = path.join(current, segment);
    const stat = await exists(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PurgeRefusal('会话缓存目录路径异常：' + current);
  }
  if (normalized(await realpath(current)) !== normalized(current)) throw new PurgeRefusal('会话缓存目录被重定向：' + current);
  return current;
}

async function headerOf(file) {
  const input = createReadStream(file);
  const decoder = file.endsWith('.zstd') ? createZstdDecompress() : null;
  if (decoder) {
    input.on('error', error => decoder.destroy(error));
    input.pipe(decoder);
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of decoder ?? input) {
      const end = chunk.indexOf(10);
      const header = end < 0 ? chunk : chunk.subarray(0, end);
      length += header.length;
      if (length > 1024 * 1024) throw new Error('header too large');
      chunks.push(header);
      if (end >= 0) break;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!header || typeof header.id !== 'string' || !header.id) throw new Error('missing session ID');
    return header;
  } catch {
    throw new UnreadableLog('无法读取会话日志的 JSON 文件头：' + file);
  } finally {
    input.destroy();
  }
}

function readPlainCopy(raw) {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n');
  if (lines.pop() !== '') throw new Error('Unterminated session log');
  const meta = JSON.parse(lines.shift());
  if (meta?.type !== 'session' || typeof meta.isSeeded !== 'boolean') throw new Error('Invalid session header');
  let inheritedEventCount;
  const events = lines.map((line, index) => {
    const event = JSON.parse(line);
    if (event?.seq !== index || !Number.isSafeInteger(event.time) || event.time < 0 ||
      typeof event.type !== 'string' || !Object.hasOwn(event, 'data')) throw new Error('Invalid session event');
    if (event.type === 'session/end-seed' && event.data?.inherited === true) {
      if (inheritedEventCount !== undefined) throw new Error('Multiple inherited seed markers');
      inheritedEventCount = index;
    }
    return event;
  });
  if (meta.isSeeded !== (inheritedEventCount !== undefined)) throw new Error('Invalid inherited seed marker');
  return { meta, events, inheritedEventCount: inheritedEventCount ?? 0 };
}

export async function readCopyUsage(file, id, persistence, timeZone, readDirectory) {
  try {
    const before = await inspectLog(file.root, file.path, readDirectory);
    if (before.fingerprint !== file.fingerprint) throw new Error('Backup log changed');
    const raw = await readFile(file.path);
    // The host decodes every Zstandard frame. The Electron stream can stop at the header frame.
    const parsed = file.path.endsWith('.zstd') ? await persistence.readZstdPrefix(raw) : readPlainCopy(raw);
    if (parsed.meta?.id !== id || parsed.meta.version !== 4 || parsed.tornTruncateTo !== undefined) {
      throw new Error('Incomplete or mismatched backup log');
    }
    const summary = verifySessionUsage(summarizeSessionUsage(parsed.events, parsed.inheritedEventCount, timeZone), '会话副本');
    const after = await inspectLog(file.root, file.path, readDirectory);
    if (after.fingerprint !== before.fingerprint) throw new Error('Backup log changed');
    return summary;
  } catch {
    throw new PurgeRefusal('无法核对副本中的完整用量，文件已保留：' + file.path);
  }
}

async function inspectCache(home, id, name = id + '.json') {
  if (name !== id + '.json' && !name.startsWith(id + '.json.bak.')) throw new PurgeRefusal('缓存文件名不匹配');
  const file = path.join(home, 'storages/session_projcache/sessions', name);
  const stat = await exists(file); if (!stat) return;
  let current = path.resolve(home);
  for (const segment of ['', 'storages', 'session_projcache', 'sessions', name]) {
    if (segment) current = path.join(current, segment);
    const st = await lstat(current, { bigint: true });
    if (st.isSymbolicLink() || (current === file ? !st.isFile() || st.nlink !== 1n : !st.isDirectory())) throw new PurgeRefusal('会话缓存路径异常：' + current);
  }
  if (normalized(await realpath(file)) !== normalized(file)) throw new PurgeRefusal('会话缓存路径被重定向');
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new PurgeRefusal('无法读取会话缓存：' + file); }
  if (![3,4,5,6,7].includes(data?.version) || !data.record?.identity || !data.record?.rows) throw new PurgeRefusal('无法核实会话缓存格式：' + file);
  return { path: file, root: home, kind: 'cache', bytes: Number(stat.size), fingerprint: fingerprint(stat) };
}

export function createCopyCleaner({ primaryRoot, scanRoots = [], clearPrimaryCache }) {
  primaryRoot = path.resolve(primaryRoot);
  scanRoots = [...new Map(scanRoots.map(root => [normalized(root), path.resolve(root)])).values()];
  const add = (map, id, entry) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(entry);
  };
  async function backupStatus() {
    const inspected = await Promise.all(scanRoots.map(root => inspectBackupRoot(root, listDirectory)));
    return inspected.map(({ path, status }) => ({ path, status }));
  }
  async function scan(previous) {
    const oldDirectories = previous?.directories, oldHeaders = previous?.headers;
    const directories = new Map(), headers = new Map(), primaryHeaders = [], legacy = [];
    async function readDirectory(dir, stat) {
      stat ??= await lstat(dir, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PurgeRefusal('会话目录路径异常：' + dir);
      const stamp = fingerprint(stat);
      const cached = directories.get(dir) ?? oldDirectories?.get(dir);
      const entries = cached?.stamp === stamp ? cached.entries : await listDirectory(dir);
      directories.set(dir, { stamp, entries });
      return entries;
    }
    async function readHeader(file) {
      const stat = await lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new PurgeRefusal('副本日志不是独立普通文件：' + file);
      const stamp = fingerprint(stat);
      const cached = oldHeaders?.get(file);
      const header = cached?.stamp === stamp ? cached.header : await headerOf(file);
      if (cached?.stamp !== stamp && fingerprint(await lstat(file, { bigint: true })) !== stamp) {
        throw new PurgeRefusal('扫描期间日志发生变化，请重新确认：' + file);
      }
      headers.set(file, { stamp, header });
      return header;
    }
    let discovered;
    try { discovered = await discoverSessionRoots(scanRoots, readDirectory); }
    catch (error) {
      if (error instanceof PurgeRefusal) throw error;
      throw new PurgeRefusal('无法扫描备份目录：' + (error.path ?? scanRoots.join('、')));
    }
    const roots = [...new Map([[normalized(primaryRoot), primaryRoot],
      ...discovered.roots.filter(root => normalized(root) !== normalized(primaryRoot)).map(root => [normalized(root), root])]).values()];
    const logs = new Map(), descendants = new Map(), issues = new Map(), warnings = [];
    for (const root of roots) {
      const primary = normalized(root) === normalized(primaryRoot);
      let current = root;
      try {
        const stat = await exists(root);
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new PurgeRefusal('会话根目录路径异常：' + root);
        for (const project of stat ? await readDirectory(root, stat) : []) {
          current = path.join(root, project.name);
          if (project.isSymbolicLink()) throw new PurgeRefusal('副本项目目录包含链接：' + current);
          if (!project.isDirectory()) continue;
          for (const session of await readDirectory(current)) {
            const dir = path.join(root, project.name, session.name);
            current = dir;
            if (session.isSymbolicLink()) throw new PurgeRefusal('副本会话目录包含链接：' + dir);
            if (!session.isDirectory()) continue;
            for (const { name } of await readDirectory(dir)) {
              if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(name)) {
                if (name !== 'session.lock') add(issues, session.name, '会话目录含历史版本或其他文件，未清除：' + dir);
                // Older primary generations still contribute relationships through the host.
                if (primary && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)) {
                  const file = path.join(dir, name);
                  legacy.push([file, fingerprint(await lstat(file, { bigint: true }))]);
                }
                continue;
              }
              current = path.join(dir, name);
              let header;
              try { header = await readHeader(current); }
              catch (error) {
                if (primary || !(error instanceof UnreadableLog)) throw error;
                add(issues, session.name, error.message);
                warnings.push(current);
                continue;
              }
              const entry = { file: current, root, header, directoryId: session.name };
              if (primary) primaryHeaders.push(header);
              add(logs, session.name, entry);
              if (header.id !== session.name) add(logs, header.id, entry);
              if (header.parentSession) add(descendants, header.parentSession, entry);
            }
          }
        }
      } catch (error) {
        if (error instanceof PurgeRefusal) throw error;
        throw new PurgeRefusal('无法检查会话目录或日志：' + (error.path ?? current));
      }
    }
    return { roots, backupRoots: discovered.backupRoots, cacheDirectories: discovered.cacheDirectories,
      logs, descendants, issues, warnings: warnings.sort(), directories, headers, primaryHeaders,
      legacyStamp: JSON.stringify(legacy.sort()), readDirectory };
  }
  async function scanCaches({ roots, cacheDirectories, readDirectory }) {
    const caches = new Map();
    for (const root of roots) {
      const home = path.dirname(root);
      const cacheDir = cacheDirectories.has(home) ? cacheDirectories.get(home) : await cacheDirectory(home);
      if (!cacheDir) continue;
      for (const { name } of await readDirectory(cacheDir)) {
        const id = /^([a-zA-Z0-9_-]+)\.json(?:\.bak\..*)?$/.exec(name)?.[1];
        if (id) add(caches, id, { home, name, primary: root === primaryRoot && name === id + '.json' });
      }
    }
    return caches;
  }
  async function inspect(id, { primaryLog, withChildren = false, relationsOnly = false, snapshot } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new PurgeRefusal('会话 ID 不适合文件清理');
    snapshot ??= await scan();
    const { roots, logs, descendants, issues, warnings } = snapshot;
    const files = [], children = new Set();
    for (const { header, directoryId, file } of descendants.get(id) ?? []) {
      if (!withChildren || header.origin !== 'subagent') throw new PurgeRefusal('存在派生会话，请先处理：' + directoryId);
      if (header.id !== directoryId || header.version !== 4) throw new PurgeRefusal('子智能体日志身份不匹配：' + file);
      children.add(header.id);
    }
    if (!relationsOnly) {
      const issue = issues.get(id)?.[0];
      if (issue) throw new PurgeRefusal(issue);
      for (const { root, header, directoryId, file } of logs.get(id) ?? []) {
        if (header.id !== id || header.version !== 4) throw new PurgeRefusal('副本会话身份不匹配：' + file);
        if (directoryId !== id) throw new PurgeRefusal('会话 ID 与日志目录不一致：' + file);
        if (primaryLog && normalized(file) === normalized(primaryLog)) continue;
        files.push({ ...await inspectLog(root, file, snapshot.readDirectory), root, kind: 'copy', parentSession: header.parentSession, origin: header.origin });
      }
      snapshot.caches ??= scanCaches(snapshot);
      for (const { home, name, primary } of (await snapshot.caches).get(id) ?? []) {
        const cache = await inspectCache(home, id, name);
        if (cache) files.push({ ...cache, primary });
      }
    }
    return { roots, warnings, files: files.sort((a, b) => a.path.localeCompare(b.path)), children: [...children].sort() };
  }
  return { scan, inspect, backupStatus, async remove(file, id, readDirectory) {
    const fresh = file.kind === 'copy' ? await inspectLog(file.root, file.path, readDirectory) : await inspectCache(file.root, id, path.basename(file.path));
    if (!fresh || fresh.path !== file.path || fresh.fingerprint !== file.fingerprint) throw new PurgeRefusal('副本或缓存已变化，请重新确认：' + file.path);
    if (file.primary && clearPrimaryCache) await clearPrimaryCache(id);
    else await unlink(file.path);
    if (await exists(file.path)) throw new PurgeRefusal('文件仍然存在，清理未完成：' + file.path);
  } };
}

export function installCheckpointPolicy(cache, isDeleted) {
  if (typeof cache?.put !== 'function') throw new Error('不兼容的会话缓存接口');
  const original = cache.put;
  function put(id, ...args) { return isDeleted(id) ? Promise.resolve() : original.call(this, id, ...args); }
  cache.put = put;
  return () => { if (cache.put === put) cache.put = original; };
}
