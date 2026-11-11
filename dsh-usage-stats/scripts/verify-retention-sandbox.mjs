// Synthetic integration only. Never points at the user's daily DSH_HOME.
import { mkdir, cp, writeFile, readFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const home = path.join(root, '.sandbox', 'purge-tests', 'retention-' + randomUUID());
const profile = path.join(home, 'profiles', 'web');
const base = 'http://127.0.0.1:19422';
const project = path.join(home, 'synthetic-project');
await mkdir(project, { recursive: true });
await writeFile(path.join(project, 'keep.txt'), 'Keep project files');
for (const [name, source] of [['dsh-usage-stats-local', root], ['dsh-archive-manager-local', path.resolve(root, '../dsh-archive-manager')]]) {
  const destination = path.join(profile, 'node_modules', name);
  await mkdir(destination, { recursive: true });
  for (const file of ['lib', 'package.json', 'cordis.patch.yml']) await cp(path.join(source, file), path.join(destination, file), { recursive: true });
}
await writeFile(path.join(profile,'node_modules/dsh-archive-manager-local/cordis.patch.yml'),'- insert:\n    - id: archive-manager-local\n      name: dsh-archive-manager-local\n      config:\n        backupScanRoots: '+JSON.stringify([path.join(home,'copies')])+'\n');
const seed = path.join(profile, 'node_modules', 'retention-qa-seed');
await mkdir(seed, { recursive: true });
await writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: 'retention-qa-seed', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
await writeFile(path.join(seed, 'cordis.patch.yml'), '- insert:\n    - id: retention-qa-seed\n      name: retention-qa-seed\n');
await writeFile(path.join(seed, 'index.js'), `
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
export const inject=['sessionPersistence','workspaceRegistry','webServer'];
export async function apply(ctx){
 if(process.env.DSH_HOME!==${JSON.stringify(home)})throw Error('Synthetic home required');
 async function seed(id,tokenAmounts,recreate=false){
  const marker=${JSON.stringify(home)}+'/'+id+'.seeded';if(!recreate&&existsSync(marker))return;
  const time=recreate?Number(readFileSync(marker,'utf8')):Date.now();
  const h=await ctx.sessionPersistence.create({version:4,id,createdAt:time,delegationDepth:0,isSeeded:false,cwd:${JSON.stringify(project)}});
  try{
   for(const [index,tokens] of tokenAmounts.entries()){
    const turn=index+1, seq=5*index;
    const usage={inputTokens:tokens-60,outputTokens:10,cacheReadTokens:40,cacheWriteTokens:10,totalTokens:tokens};
    await h.append([{seq,time,type:'turn/start',data:{turn}},{seq:seq+1,time,type:'step/start',data:{turn,step:1}},{seq:seq+2,time,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,stream:[],usage,message:{id:id+'-message-'+index,role:'assistant',content:[{type:'text',text:'Synthetic retention test'}],source:{kind:'model',provider:'retention-qa',model:'synthetic-model'}}}},{seq:seq+3,time,type:'step/end',data:{turn,step:1}},{seq:seq+4,time,type:'turn/end',data:{turn,reason:{kind:'completed'}}}]);
    await h.flush();
   }
  }finally{await h.close();}
  const snap=await ctx.sessionPersistence.stat(id);const dir=path.join(${JSON.stringify(home)},'copies/sessions/project',id);mkdirSync(dir,{recursive:true});copyFileSync(snap.location.path,path.join(dir,path.basename(snap.location.path)));
  const cacheDir=path.join(${JSON.stringify(home)},'copies/storages/session_projcache/sessions');mkdirSync(cacheDir,{recursive:true});writeFileSync(path.join(cacheDir,id+'.json'),JSON.stringify({version:7,record:{identity:{createdAt:time},rows:{test:{text:'synthetic cache'}}}}));
  await ctx.workspaceRegistry.archiveSession(id);writeFileSync(marker,String(time));
  return snap.location.path;
 }
 await seed('retention-qa-a',[100]);
 try { const r=await ctx.sessionPersistence.open('retention-qa-a','read'); try{await r.read();}finally{await r.close();} } catch(e){writeFileSync(${JSON.stringify(home)}+'/read-error.txt',String(e.stack));}
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/retention-qa-seed-b',handler:async(req,res)=>{
  try{await seed('retention-qa-b',[120,130]);res.end('ok');}catch(e){res.writeHead(500);res.end(String(e));}
 }}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/retention-qa-old-b',handler:async(req,res)=>{
  try{await seed('retention-qa-b',[120],true);res.end('ok');}catch(e){res.writeHead(500);res.end(String(e));}
 }}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/retention-qa-diverged-b',handler:async(req,res)=>{
  try{await seed('retention-qa-b',[120,140],true);res.end('ok');}catch(e){res.writeHead(500);res.end(String(e));}
 }}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/retention-qa-seed-c',handler:async(req,res)=>{
  try{await seed('retention-qa-c',[110]);res.end('ok');}catch(e){res.writeHead(500);res.end(String(e));}
 }}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/retention-qa-orphan-c',handler:async(req,res)=>{
  try{
   const current=await ctx.sessionPersistence.stat('retention-qa-c');
   unlinkSync(current.location.path);
   unlinkSync(await seed('retention-qa-c',[110,140],true));
   res.end('ok');
  }catch(e){res.writeHead(500);res.end(String(e));}
 }}));
}
`);
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'retention-qa-profile', private: true,
  dependencies: Object.fromEntries(['dsh-usage-stats-local', 'dsh-archive-manager-local', 'retention-qa-seed'].map(name => [name, 'file:./node_modules/' + name])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-usage-stats-local', 'dsh-archive-manager-local', 'retention-qa-seed'] } },
}, null, 2));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');

let child, log;
async function start() {
  log = createWriteStream(path.join(home, 'host.log'), { flags: 'a' });
  child = spawn('D:/deepseek/DeepSeek Harness.exe', ['--expose-internals', 'D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--port', '19422', '--no-open'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('Host exited: ' + await readFile(path.join(home, 'host.log'), 'utf8'));
    try { await snapshot(); const list = await archive('list'); if (list.items) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw Error('Host startup timed out: ' + await readFile(path.join(home, 'host.log'), 'utf8'));
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  log?.end();
}
async function snapshot() {
  const res = await fetch(base + '/api/dsh-usage-stats-local/snapshot', { headers: { 'x-dsh-usage-stats': '1' }, signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 200); const value = await res.json(); assert.equal(value.ok, true); return value;
}
async function archive(action, body) {
  const res = await fetch(base + '/api/dsh-archive-manager-local/' + action, { method: body ? 'POST' : 'GET',
    headers: { 'x-dsh-archive-manager': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
}
async function purge(id) {
  const permanent = await archive('prepare', { ids: [id], mode: 'purge' });
  assert(permanent.items[0].files.some(file=>file.kind==='copy'));
  assert(permanent.items[0].files.some(file=>file.kind==='cache'));
  const body = { token: permanent.token, confirmed: true };
  const result = await archive('commit', body);
  assert.deepEqual(result, { deleted: [id], skipped: [], failed: [] });
  assert.deepEqual(await archive('commit', body), result);
  for(const file of permanent.items[0].files)await assert.rejects(access(file.path));
}
console.log('Synthetic DSH_HOME: ' + home);
try {
  await start();
  // Wait for the seed's independent plugin startup to finish.
  for (let i = 0; i < 40 && (await snapshot()).summary.totalTokens !== 100; i++) await new Promise(r => setTimeout(r, 100));
  const before = await snapshot(); assert.equal(before.summary.totalTokens, 100, JSON.stringify(before));
  const seedResult = await fetch(base + '/retention-qa-seed-b'); assert.equal(seedResult.status, 200, await seedResult.text());
  await purge('retention-qa-b'); // no statistics request between creation and purge
  await purge('retention-qa-a');
  const deleted = await snapshot(); assert.equal(deleted.summary.totalTokens, 350); assert.equal(deleted.coverage.retainedSessions, 2);
  assert.deepEqual(deleted.days[0].tokenBreakdown, {
    inputTokens: 170, outputTokens: 30, cacheReadTokens: 120, cacheWriteTokens: 30, unclassifiedTokens: 0,
  });
  assert.equal(deleted.coverage.skippedSessions, 0);
  assert.equal((await archive('list')).items.length, 0);
  await stop(); await start();
  const restarted = await snapshot();
  assert.deepEqual(restarted.summary, deleted.summary); assert.deepEqual(restarted.days, deleted.days);
  assert.equal(restarted.coverage.retainedSessions, 2);
  assert.deepEqual((await snapshot()).summary, restarted.summary);
  const older = await fetch(base + '/retention-qa-old-b'); assert.equal(older.status, 200, await older.text());
  const restoredOld = await snapshot();
  assert.equal(restoredOld.coverage.retainedSessions, 1);
  assert.equal(restoredOld.coverage.conflictingSessions, 0);
  assert.deepEqual(restoredOld.days, restarted.days);
  await purge('retention-qa-b');
  assert.deepEqual((await snapshot()).days, restarted.days);
  const seedC = await fetch(base + '/retention-qa-seed-c'); assert.equal(seedC.status, 200, await seedC.text());
  assert.equal((await snapshot()).summary.totalTokens, 460);
  const orphanC = await fetch(base + '/retention-qa-orphan-c'); assert.equal(orphanC.status, 200, await orphanC.text());
  assert.equal((await snapshot()).summary.totalTokens, 460);
  await purge('retention-qa-c');
  assert.equal((await snapshot()).summary.totalTokens, 600);
  const diverged = await fetch(base + '/retention-qa-diverged-b'); assert.equal(diverged.status, 200, await diverged.text());
  const conflicted = await snapshot();
  assert.equal(conflicted.summary.totalTokens, 600);
  assert.equal(conflicted.coverage.conflictingSessions, 1);
  const refused = await archive('prepare', { ids: ['retention-qa-b'], mode: 'purge' });
  const blocked = await archive('commit', { token: refused.token, confirmed: true });
  assert.deepEqual(blocked.deleted, []);
  assert.match(blocked.failed[0]?.reason, /用量.*有分歧/);
  for (const file of refused.items[0].files) await access(file.path);
  await access(path.join(project, 'keep.txt'));
  const report = { testedAt: new Date().toISOString(), home, totalTokens: restarted.summary.totalTokens,
    retainedSessions: restarted.coverage.retainedSessions, deletionBeforeFirstView: true, repeatCommitNoDoubleCount: true,
    restartPreservesDailyAndModelTotals: true, tokenBreakdown: restarted.days[0].tokenBreakdown,
    projectFilePreserved: true, copiesAndCachesRemoved: true, singleListDirectDeletion: true,
    olderRestoredLogPreservesUsageOnRefreshAndDeletion: true,
    backupOnlyNewUsageSavedBeforeDeletion: true, divergentLogAndCopyRetained: true };
  await writeFile(path.join(root, 'qa', 'retention-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await stop(); }
