import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const projects = ['dsh-usage-stats', 'dsh-archive-manager'];
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 运行失败（${result.status ?? result.signal}）`);
  return result.stdout;
}

function npm(project, args, options = {}) {
  // The Windows shell receives only the fixed npm arguments below. Pass paths in cwd or env.
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', 'npm.cmd', ...args] : args;
  return run(command, commandArgs, { cwd: project, stdio: 'inherit', ...options });
}

async function releaseInfo(project) {
  const dir = path.join(workspace, project);
  const { name, version, description } = await readJson(path.join(dir, 'package.json'));
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.ok(description.startsWith(`v${version} · `), `${name} 的描述版本不一致`);
  const lock = await readJson(path.join(dir, 'package-lock.json'));
  assert.equal(lock.version, version, `${name} 的锁文件版本不一致`);
  assert.equal(lock.packages[''].version, version, `${name} 的锁文件根包版本不一致`);
  const filename = `${name}-${version}.tgz`;
  const installer = await readFile(path.join(dir, 'install.ps1'), 'utf8');
  assert.ok(installer.includes(`dist\\${filename}'`), `${name} 的安装脚本没有指向 ${filename}`);
  return { dir, name, version, description, filename };
}

async function prepare(info, stage) {
  const packed = JSON.parse(npm(info.dir, ['pack', '--json'], {
    env: { ...process.env, npm_config_pack_destination: stage },
    stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
  }));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, info.filename);
  const archive = path.join(stage, info.filename);
  const extract = file => run('tar', ['-xOf', archive, `package/${file}`], { maxBuffer: 16 * 1024 * 1024 });
  const manifest = JSON.parse(extract('package.json'));
  assert.equal(manifest.name, info.name);
  assert.equal(manifest.version, info.version);
  assert.equal(manifest.description, info.description);
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/update-on-exit.mjs', 'cordis.patch.yml']) {
    assert.ok(extract(file).equals(await readFile(path.join(info.dir, file))), `${info.name} 的包内文件不一致：${file}`);
  }

  const checksum = hash('sha256', await readFile(archive));
  const dist = path.join(info.dir, 'dist');
  const destination = path.join(dist, info.filename);
  const sumsPath = path.join(dist, 'SHA256SUMS.txt');
  const sums = await readFile(sumsPath, 'utf8');
  const entry = sums.split(/\r?\n/).find(line => line.split(/\s+/)[1] === info.filename);
  if (entry) assert.equal(entry.split(/\s+/)[0], checksum, `${info.filename} 已发布，内容变化时请升版`);
  let existing;
  try { existing = await readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) assert.equal(hash('sha256', existing), checksum, `${info.filename} 已存在且内容不同`);
  return { archive, destination, existing, checksum, entry, sums, sumsPath, filename: info.filename };
}

const releases = await Promise.all(projects.map(releaseInfo));
for (const { dir, name } of releases) {
  console.log(`验证并构建 ${name}`);
  npm(dir, ['test']);
  npm(dir, ['run', 'build']);
}

const stage = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-release-'));
try {
  const packages = [];
  for (const info of releases) packages.push(await prepare(info, stage));
  for (const { archive, destination, existing, checksum, entry, sums, sumsPath, filename } of packages) {
    if (!existing) await copyFile(archive, destination, constants.COPYFILE_EXCL);
    if (!entry) {
      const temporary = sumsPath + '.' + path.basename(stage);
      try {
        const newline = sums.includes('\r\n') ? '\r\n' : '\n';
        await writeFile(temporary, sums.trimEnd() + newline + `${checksum}  ${filename}` + newline, { flag: 'wx' });
        await rename(temporary, sumsPath);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    console.log(`${checksum}  ${destination}`);
  }
} finally {
  for (const entry of await readdir(stage)) await unlink(path.join(stage, entry));
  await rmdir(stage);
}
