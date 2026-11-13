import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const hostRoot = process.env.DSH_QA_INSTALL_DIR ?? 'D:/deepseek';
const tempRoot = await realpath(tmpdir());
const home = await mkdtemp(path.join(tempRoot, 'dsh-live-archive-'));
const profile = path.join(home, 'profiles', 'web');
const project = path.join(home, 'project');
const searchPath = path.join(home, 'search.sqlite');
const port = 19424;
const base = `http://127.0.0.1:${port}`;
const seedName = 'live-archive-qa-seed';
const pluginName = 'dsh-archive-manager-local';
const seed = path.join(profile, 'node_modules', seedName);
const plugin = path.join(profile, 'node_modules', pluginName);
const backup = path.join(home, 'backup');
await mkdir(seed, { recursive: true });
await mkdir(plugin, { recursive: true });
await mkdir(project, { recursive: true });
await mkdir(backup);
await writeFile(path.join(project, 'keep.txt'), 'Keep project files');
for (const file of ['lib', 'package.json']) await cp(path.join(root, file), path.join(plugin, file), { recursive: true });
await writeFile(path.join(plugin, 'cordis.patch.yml'), `- insert:\n    - id: archive-manager-local\n      name: ${pluginName}\n      config:\n        backupScanRoots: ${JSON.stringify([path.join(home,'backup')])}\n`);
await writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: seedName, version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
await writeFile(path.join(seed, 'cordis.patch.yml'), `- insert:\n    - id: ${seedName}\n      name: ${seedName}\n`);
await writeFile(path.join(seed, 'index.js'), `
import path from 'node:path';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'sessionQuery', 'workspaceController', 'workspaceRegistry', 'webServer'];
export function apply(ctx) {
  if (process.env.DSH_HOME !== ${JSON.stringify(home)}) throw Error('Synthetic home required');
  let fixture;
  let releaseParentClaim;
  const resumedId = 'live-archive-qa-resumed';
  let busy = false;
  let direct;
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const rest = await next();
    return busy && sessionId === resumedId ? [{ kind: 'job' }, ...rest] : rest;
  });
  async function createFixture() {
    const cwd = ${JSON.stringify(project)};
    const { sessionId } = await ctx.sessionController.create({ cwd });
    const session = ctx.sessions.get(sessionId);
    if (!session) throw Error('New session must remain loaded');
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append('assistant/message', { turn: 1, step: 1, stream: [],
      usage: { inputTokens: 55, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10, totalTokens: 100 },
      message: { id: 'qa-reply', role: 'assistant', content: [{ type: 'text', text: 'Synthetic response' }],
        source: { kind: 'model', provider: 'test', model: 'test' } } }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await ctx.sessions.flush(session);
    await ctx.workspaceController.archiveSession({ sessionId });

    const writer = await ctx.sessionPersistence.create({ version: 4, id: resumedId, createdAt: Date.now(), delegationDepth: 0, isSeeded: false, cwd });
    await writer.flush();
    await writer.close();
    const resolved = await ctx.sessionController.agents.resolveAgent(resumedId);
    if (!resolved.agent) throw resolved.error;
    await ctx.workspaceController.archiveSession({ sessionId: resumedId });
    if (ctx.sessions.get(sessionId) !== session || !ctx.sessions.get(resumedId)) throw Error('Archive must leave both sessions loaded for this regression');
    busy = true;
    return { ids: [sessionId, resumedId], paths: await Promise.all([sessionId, resumedId].map(async id => (await ctx.sessionPersistence.stat(id)).location.path)) };
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/live-archive-qa', handler: async (_req, res) => {
    try {
      res.end(JSON.stringify(await (fixture ??= createFixture())));
    } catch (error) { res.writeHead(500); res.end(String(error.stack ?? error)); }
  }}));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/live-archive-qa-idle', handler: (_req, res) => {
    busy = false;
    res.end(JSON.stringify({ loaded: Boolean(ctx.sessions.get(resumedId)) }));
  }}));

  async function writeChild(id, parentSession, depth, origin = 'subagent') {
    const cwd = ${JSON.stringify(project)};
    const time = Date.now();
    const writer = await ctx.sessionPersistence.create({ version: 4, id, createdAt: time, ...(origin ? {origin} : {}),
      parentSession, delegationDepth: depth, isSeeded: false, cwd });
    try {
      await writer.append([
        {seq:0,time,type:'turn/start',data:{turn:1}},
        {seq:1,time,type:'step/start',data:{turn:1,step:1}},
        {seq:2,time,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,stream:[],usage:{inputTokens:20,outputTokens:5,totalTokens:25},
          message:{id:'qa-'+id,role:'assistant',content:[{type:'text',text:'syntheticsubagentneedle'}],source:{kind:'model',provider:'test',model:'test'}}}},
        {seq:3,time,type:'step/end',data:{turn:1,step:1}},
        {seq:4,time,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}
      ]);
      await writer.flush();
    } finally { await writer.close(); }
    const file = (await ctx.sessionPersistence.stat(id)).location.path;
    const backupDir = path.join(${JSON.stringify(home)},'backup','sessions','qa',id);
    await mkdir(backupDir,{recursive:true});
    await copyFile(file,path.join(backupDir,path.basename(file)));
    const cacheDir = path.join(${JSON.stringify(home)},'backup','storages','session_projcache','sessions');
    await mkdir(cacheDir,{recursive:true});
    await writeFile(path.join(cacheDir,id+'.json.bak.1'),JSON.stringify({version:7,record:{identity:{createdAt:time},rows:{test:{text:'synthetic cache'}}}}));
    return file;
  }
  async function createDirect() {
    await ctx.workspaceRegistry.create(${JSON.stringify(project)},'删除会话测试项目');
    const { sessionId } = await ctx.sessionController.create({ cwd:${JSON.stringify(project)} });
    const agent = ctx.agents.get(sessionId);
    agent.session.append('session/title',{title:'删除会话回归',source:{kind:'user'},messageSeqs:[]});
    const started = Promise.withResolvers();
    agent.preStep = async () => {
      const signal = agent.phase.abort.signal;
      started.resolve();
      await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(resolve,150),{once:true}));
      signal.throwIfAborted();
    };
    agent.wakeDriver();
    await started.promise;
    await writeChild('qa-child',sessionId,1);
    await writeChild('qa-grandchild','qa-child',2);
    return { sessionId, childId:'qa-child', grandchildId:'qa-grandchild' };
  }
  function route(name, handler) {
    ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/live-archive-qa-'+name,handler:async(_req,res)=>{
      try { res.end(JSON.stringify(await handler())); }
      catch(error) { res.writeHead(500);res.end(String(error.stack??error)); }
    }}));
  }
  route('direct',()=>direct??=createDirect());
  route('stop',async()=>{
    const {sessionId}=await direct;
    ctx.sessionController.cancel({sessionId});
    return {status:ctx.agents.get(sessionId).status};
  });
  route('new-child',async()=>({path:await writeChild('qa-late-child',(await direct).sessionId,1)}));
  route('fork',async()=>({path:await writeChild('qa-fork',(await direct).sessionId,0,null)}));
  route('hold-parent',async()=>{
    const {sessionId}=await direct;
    const tracker=ctx.sessionPersistence.tracker;
    const original=tracker.claimWrite;
    tracker.claimWrite=function(id) {
      if (id===sessionId) throw Error('Synthetic concurrent write claim');
      return original.call(this,id);
    };
    releaseParentClaim=()=>{tracker.claimWrite=original;};
    return {};
  });
  route('release-parent',async()=>{
    releaseParentClaim?.();
    return {};
  });
  route('search',async()=>{
    if (!ctx.sessionQuery.config?.path || ctx.sessionQuery.config.openAt==='never') return { enabled:false };
    const result = await ctx.sessionQuery.searchSessions({query:'syntheticsubagentneedle',limit:20});
    return { enabled:true, hits:result.items.length };
  });
}
`);
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-live-archive-qa', private: true,
  dependencies: { [pluginName]: `file:./node_modules/${pluginName}`, [seedName]: `file:./node_modules/${seedName}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginName, seedName] } },
}));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
await writeFile(path.join(profile, 'cordis.patch.yml'), `- id: session-query-sqlite\n  config:\n    path: ${JSON.stringify(searchPath)}\n    openAt: first-search\n`);

const child = spawn(path.join(hostRoot, 'DeepSeek Harness.exe'), ['--expose-internals', path.join(hostRoot, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000); });
async function request(route, body, status = 200) {
  const res = await fetch(base + route, { method: body ? 'POST' : 'GET',
    headers: { 'x-dsh-archive-manager': '1', 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const content = await res.text();
  assert.equal(res.status, status, content);
  return JSON.parse(content);
}
const archive = (action, body, status) => request(`/api/${pluginName}/${action}`, body, status);
async function confirm(plan) {
  const first = await archive('commit', { token:plan.token, confirmed:true });
  if (!first.confirmation) return first;
  assert.deepEqual(first.deleted, []);
  assert.equal(first.confirmation.reviewRequired, true);
  for (const row of first.confirmation.items) for (const file of row.files) await access(file.path);
  const second = await archive('commit', { token:first.confirmation.token, confirmed:true });
  assert.equal(second.confirmation, undefined);
  return second;
}
function indexedRows(id) {
  const db = new DatabaseSync(searchPath,{readOnly:true});
  try { return db.prepare('SELECT count(*) AS count FROM persisted_docs WHERE session_id = ?').get(id).count; }
  finally { db.close(); }
}
try {
  for (let attempt = 0; ; attempt++) {
    try { await archive('list'); break; }
    catch (error) {
      if (attempt >= 80 || child.exitCode !== null) throw new Error(diagnostics, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (process.argv.includes('--browser')) {
    const direct = await request('/live-archive-qa-direct');
    await request('/live-archive-qa-stop');
    const url = diagnostics.match(/dsh web: (\S+)/)?.[1];
    assert(url,'No synthetic browser URL received');
    const urlFile = process.env.DSH_ARCHIVE_QA_URL_FILE ?? path.join(home,'browser-url.txt');
    await writeFile(urlFile,url);
    console.log('Synthetic browser host:',base,direct,'URL file:',urlFile);
    process.stdin.resume();
    await once(process.stdin,'data');
    process.stdin.pause();
  } else {
    const { ids, paths } = await request('/live-archive-qa');
    assert.deepEqual((await archive('list')).items.map(item => item.id).sort(), [...ids].sort());
    assert.deepEqual((await archive('list')).backupRoots, [{ path:backup, status:'available' }]);
    await rename(backup, backup + '-offline');
    try {
      assert.deepEqual((await archive('list')).backupRoots, [{ path:backup, status:'missing' }]);
      assert.match((await archive('prepare', { ids }, 409)).error, /备份目录不可用/);
      for (const file of paths) await access(file);
    } finally { await rename(backup + '-offline', backup); }
    const blocked = await archive('prepare', { ids: [ids[1]], mode: 'purge' }, 409);
    assert.match(blocked.error, /运行中的任务/);
    assert.deepEqual(await request('/live-archive-qa-idle'), { loaded: true });
    const prepared = await archive('prepare', { ids, mode: 'purge' });
    assert.equal(prepared.count, ids.length, JSON.stringify(prepared));
    assert.deepEqual(await archive('progress?token=' + prepared.token), { phase:'ready', total:ids.length, processed:0 });
    await archive('commit', { token: prepared.token, confirmed: false }, 400);
    assert.deepEqual(await request('/live-archive-qa-idle'), { loaded: true });
    for (const file of paths) await access(file);
    const changed = await archive('commit', { token:prepared.token, confirmed:true });
    assert.equal(changed.confirmation.reviewRequired, true);
    assert.deepEqual(changed.deleted, []);
    assert.deepEqual(await request('/live-archive-qa-idle'), { loaded: false });
    for (const file of paths) await access(file);
    assert.deepEqual(await confirm(changed.confirmation), { deleted: ids, skipped: [], failed: [] });
    assert.equal((await archive('progress?token=' + changed.confirmation.token)).phase, 'done');
    for (const file of paths) await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal((await archive('list')).items.length, 0);
    assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'Keep project files');
    const saved = JSON.parse(await readFile(path.join(home, 'storages', 'usage_stats_local', 'sessions', ids[0] + '.json'), 'utf8')).record;
    assert.deepEqual(saved.fold.days[0].tokenBreakdown, { inputTokens: 55, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10, unclassifiedTokens: 0 });

    const {sessionId,childId,grandchildId} = await request('/live-archive-qa-direct');
    const indexed = await request('/live-archive-qa-search');
    assert.deepEqual(indexed,{enabled:true,hits:2});
    assert(indexedRows(childId)>0);
    const direct = {scope:'direct',ids:[sessionId]};
    const busyDirect = await archive('prepare',direct,409);
    assert.match(busyDirect.error,/运行|排队/);
    assert.deepEqual((await archive('list?subagents=1')).items.map(item=>item.id).sort(),[childId,grandchildId].sort());
    assert.deepEqual(await request('/live-archive-qa-stop'),{status:'running'});
    const stopped = await archive('prepare',direct);
    assert.deepEqual(stopped.items.map(item=>item.id),[grandchildId,childId,sessionId]);
    assert.equal(stopped.items[1].parentSession,sessionId);
    await request('/live-archive-qa-new-child');
    const skipped = await archive('commit',{token:stopped.token,confirmed:true});
    assert.equal(skipped.deleted.length,0);
    assert.equal(skipped.skipped.length,3);
    for (const item of stopped.items) for (const file of item.files) await access(file.path);

    const alone = await archive('prepare',{scope:'subagent',ids:[childId]});
    assert.deepEqual(alone.items.map(item=>item.id),[grandchildId,childId]);
    assert.equal(alone.items[0].files.some(file=>file.kind==='copy'),true);
    assert.equal(alone.items[0].files.some(file=>file.kind==='cache'),true);
    assert.deepEqual((await archive('commit',{token:alone.token,confirmed:true})).deleted,[grandchildId,childId]);
    await access(stopped.items[2].files.find(file=>file.kind==='log').path);
    for (const item of alone.items) for (const file of item.files) await assert.rejects(access(file.path),{code:'ENOENT'});
    assert.equal(indexedRows(childId),0);
    assert.equal(indexedRows(grandchildId),0);

    const fork = await request('/live-archive-qa-fork');
    assert.match((await archive('prepare',direct,409)).error,/派生会话/);
    await access(fork.path);
    const forkPlan = await archive('prepare',{scope:'direct',ids:['qa-fork']});
    assert.deepEqual((await archive('commit',{token:forkPlan.token,confirmed:true})).deleted,['qa-fork']);

    const brokenDir = path.join(home,'backup','sessions','project','qa-unreadable');
    const brokenLog = path.join(brokenDir,'session.v4.jsonl');
    await mkdir(brokenDir,{recursive:true});
    await writeFile(brokenLog,'synthetic invalid JSON\n');
    const parent = await archive('prepare',direct);
    assert.deepEqual(parent.items.map(item=>item.id),['qa-late-child',sessionId]);
    assert.deepEqual(parent.uncheckedFiles,[brokenLog]);
    await request('/live-archive-qa-hold-parent');
    const partial = await confirm(parent);
    await request('/live-archive-qa-release-parent');
    assert.deepEqual(partial.deleted,['qa-late-child']);
    assert.deepEqual(partial.failed.map(row=>row.id),[sessionId]);
    const durable = JSON.parse(await readFile(path.join(home,'storages','archive_manager_local.json'),'utf8'));
    assert.equal(typeof durable.tables.continuations[sessionId].title,'string');
    const pending = (await archive('list')).items.find(row=>row.id===sessionId);
    assert.equal(pending?.cleanupPending,true);
    assert.equal(pending?.canUnarchive,false);
    const retry = await archive('prepare',{ids:[sessionId]});
    assert.deepEqual(retry.items.map(item=>item.id),[sessionId]);
    assert.deepEqual((await archive('commit',{token:retry.token,confirmed:true})).deleted,[sessionId]);
    await access(brokenLog);
    assert.equal((await archive('list?subagents=1')).items.length,0);
    for (const item of parent.items) for (const file of item.files) await assert.rejects(access(file.path),{code:'ENOENT'});
    for (const id of [childId,grandchildId,'qa-late-child']) {
      const ledger = JSON.parse(await readFile(path.join(home,'storages','usage_stats_local','sessions',id+'.json'),'utf8')).record;
      assert.equal(ledger.fold.days[0].tokens,25);
    }
    const search = await request('/live-archive-qa-search');
    assert.deepEqual(search,{enabled:true,hits:0});
    await access(path.join(project,'keep.txt'));
    console.log('Verified active refusal, Stop then direct delete, standalone child and nested cascade, membership drift, durable retry, unreadable backup retention, copy/cache removal, saved usage and project retention.',{search});
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  const resolvedHome = await realpath(home);
  assert.equal(resolvedHome, home);
  assert.equal(path.dirname(resolvedHome), tempRoot);
  await rm(resolvedHome, { recursive: true, force: true });
}
