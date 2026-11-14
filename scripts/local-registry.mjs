import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const host = '127.0.0.1';
const port = 4873;
const origin = `http://${host}:${port}`;
const workspace = path.resolve(import.meta.dirname, '..');
const projects = ['dsh-usage-stats', 'dsh-archive-manager', 'dsh-wuthering-waves-intro'];
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const filenamePrefix = name => name.replace(/^@/, '').replace('/', '-') + '-';
const registryFilename = (name, version) => `${name.split('/').at(-1)}-${version}.tgz`;
const archives = new Map();

async function findPackage(name) {
  for (const project of projects) {
    const dir = path.join(workspace, project);
    const manifest = await readJson(path.join(dir, 'package.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (manifest?.name === name) return { dist: path.join(dir, 'dist'), latest: manifest.version };
    if (manifest && Object.hasOwn(manifest.dependencies ?? {}, name)) {
      return { dist: path.join(dir, 'dist'), latest: manifest.dependencies[name] };
    }
  }
}

async function listArchives(name) {
  const pkg = await findPackage(name);
  if (!pkg) return [];
  const prefix = filenamePrefix(name);
  const sums = await readFile(path.join(pkg.dist, 'SHA256SUMS.txt'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  return sums.trim().split(/\r?\n/).flatMap(line => {
    const [sha256, filename] = line.trim().split(/\s+/);
    if (!filename?.startsWith(prefix) || !/^[\da-f]{64}$/.test(sha256)) return [];
    const version = filename.slice(prefix.length, -4);
    if (!filename.endsWith('.tgz') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return [];
    return [{ file: path.join(pkg.dist, filename), filename, sha256, version, latest: version === pkg.latest }];
  });
}

async function verifyArchive({ file, sha256, version }, name) {
  const info = await stat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!info?.isFile()) return;
  const key = `${sha256}/${info.mtimeMs}/${info.ctimeMs}/${info.size}`;
  const cached = archives.get(file);
  if (cached?.key === key) return cached.result;

  const result = (async () => {
    const hashes = ['sha256', 'sha1', 'sha512'].map(algorithm => createHash(algorithm));
    for await (const chunk of createReadStream(file)) {
      for (const hash of hashes) hash.update(chunk);
    }
    assert.equal(hashes[0].digest('hex'), sha256, `SHA-256 不符：${file}`);
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(manifest.name, name, file);
    assert.equal(manifest.version, version, file);
    const dist = {
      tarball: `${origin}/${name}/-/${registryFilename(name, version)}`,
      shasum: hashes[1].digest('hex'),
      integrity: `sha512-${hashes[2].digest('base64')}`,
    };
    return { manifest: { ...manifest, dist }, time: info.mtime.toISOString(), size: info.size };
  })();
  archives.set(file, { key, result });
  try {
    return await result;
  } catch (error) {
    if (archives.get(file)?.result === result) archives.delete(file);
    throw error;
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function serve(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: '只读安装源' });
  if (request.headers.host !== `${host}:${port}`) return json(response, 400, { error: '请使用本机源地址' });
  const pathname = decodeURIComponent(new URL(request.url, origin).pathname.slice(1)).replace(/\/$/, '');
  if (pathname === '' || pathname === '-/ping') return json(response, 200, { ok: true });
  const [name, filename, extra] = pathname.split('/-/');
  if (extra !== undefined) return json(response, 404, { error: '未找到安装包' });
  const entries = await listArchives(name);
  if (filename !== undefined) {
    const entry = entries.find(item => registryFilename(name, item.version) === filename || item.filename === filename);
    const archive = entry && await verifyArchive(entry, name);
    if (!archive) return json(response, 404, { error: '未找到安装包' });
    console.log(`${request.method} ${entry.filename}`);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': archive.size });
    if (request.method === 'HEAD') return response.end();
    return pipeline(createReadStream(entry.file), response);
  }
  const packument = { name, 'dist-tags': {}, versions: {}, time: {} };
  for (const entry of entries) {
    const archive = await verifyArchive(entry, name);
    if (!archive) continue;
    packument.versions[entry.version] = archive.manifest;
    packument.time[entry.version] = archive.time;
    if (entry.latest) packument['dist-tags'].latest = entry.version;
  }
  if (!Object.keys(packument.versions).length) return json(response, 404, { error: '未找到已打包的版本' });
  return json(response, 200, packument);
}

createServer((request, response) => {
  serve(request, response).catch(error => {
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    console.error(error.message);
    if (!response.headersSent) json(response, 500, { error: '本地安装包读取或校验失败' });
    else response.destroy();
  });
}).listen(port, host, () => console.log(`DSH 本地 npm 安装源：${origin}/`));
