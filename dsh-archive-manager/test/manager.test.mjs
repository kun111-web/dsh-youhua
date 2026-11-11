import test from 'node:test';
import assert from 'node:assert/strict';
import {createManager,installVisibility,validateIds} from '../src/manager.js';
import {authorize,readBody} from '../src/index.js';
import {Readable} from 'node:stream';
import {installSidebarPolicy} from '../src/client/sidebar-policy.js';
import {PurgeRefusal} from '../src/purge.js';
function fixture(count=26){
 const ids=Array.from({length:count},(_,i)=>'s'+i),stored=new Map(),events=[],removed=[];let tail=Promise.resolve(),time=1000;
 const registry={archivedSessionIds:[...ids],enqueueOperation(fn){const p=tail.then(fn);tail=p.catch(()=>{});return p;},archiveSession(id){return this.enqueueOperation(async()=>{if(!this.archivedSessionIds.includes(id))this.archivedSessionIds.push(id);});},unarchiveSession(id){return this.enqueueOperation(async()=>{this.archivedSessionIds=this.archivedSessionIds.filter(v=>v!==id);});}};
 const query={listSessions:async()=>ids.map(id=>({header:{id,cwd:'F:/project',createdAt:0}})),readTitleSnapshots:async ids=>ids.map(id=>({status:'fulfilled',value:{title:{title:'测试 '+id}}}))};
 const table={get:id=>stored.get(id),entries:()=>stored.entries(),put:async(id,v)=>{stored.set(id,v);},delete:async id=>stored.delete(id)};
 const purger={
  inspect:async id=>({id,bytes:10,files:removed.includes(id)?[]:[{path:'test/'+id,kind:'log',bytes:10}],copyRoots:['test']}),
  purge:async(w,{beforeDelete})=>{await beforeDelete();removed.push(w.id);},
  finishBatch:async()=>new Map(),
 };
 const continuing = new Map();
 const continuations = {get:id=>continuing.get(id),entries:()=>continuing.entries(),put:async(id,value)=>continuing.set(id,value),delete:async id=>continuing.delete(id)};
 const options={registry,query,table,continuations,purger,activity:async()=>[],notify:id=>events.push(id),now:()=>time};
 return {ids,stored,events,removed,registry,query,table,options,manager:createManager(options),advance:()=>{time+=300001;}};
}
const confirm=(manager,batch)=>manager.commit(batch.token,true);
test('a running batch exposes progress without waiting for the deletion queue', async () => {
  const f = fixture(2);
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  const { promise: gate, resolve: resume } = Promise.withResolvers();
  const purge = f.options.purger.purge;
  f.options.purger.purge = async (witness, hooks) => {
    if (witness.id === 's1') { enter(); await gate; }
    await purge(witness, hooks);
  };
  const plan = await f.manager.prepare({ all:true });
  assert.deepEqual(f.manager.progress(plan.token), { phase:'ready', total:2, processed:0 });
  const commit = confirm(f.manager, plan);
  try {
    await entered;
    assert.deepEqual(f.manager.progress(plan.token), { phase:'deleting', total:2, processed:1 });
  } finally { resume(); }
  assert.deepEqual((await commit).deleted, f.ids);
  assert.deepEqual(f.manager.progress(plan.token), { phase:'done', total:2, processed:2 });
  f.advance();
  assert.throws(() => f.manager.progress(plan.token), /过期/);
});
test('a parent retry includes a partially removed child even after its log is gone', async () => {
  const f = fixture(1);
  f.stored.set('child', { deletedAt: 5, purgePending: true, parentSession: 's0' });
  const plan = await f.manager.prepare({ ids: ['s0'] });
  assert.deepEqual(plan.items.map(row => row.id), ['child', 's0']);
  assert.equal(plan.items[0].parentSession, 's0');
  const result = await confirm(f.manager, plan);
  assert.deepEqual(result.deleted, ['child', 's0']);
  assert.equal(f.stored.get('child').parentSession, 's0');
});

test('a direct parent deletion can resume from the archive list after a child fails before intent', async () => {
  const f = fixture(1);
  f.registry.archivedSessionIds = [];
  const childIds = ['first', 'second'];
  const originalPurge = f.options.purger.purge;
  const originalInspect = f.options.purger.inspect;
  const children = id => id === 's0' ? childIds.filter(child => !f.removed.includes(child)) : [];
  f.options.purger.children = async id => children(id);
  f.options.purger.inspect = async id => ({ ...await originalInspect(id), children:children(id),
    parentSession:childIds.includes(id) ? 's0' : undefined });
  let fail = true;
  f.options.purger.purge = async (witness, hooks) => {
    if (fail && witness.id === 'second') throw Error('file became busy');
    await originalPurge(witness, hooks);
  };
  const initial = await f.manager.prepare({ scope:'direct', ids:['s0'] });
  const first = await confirm(f.manager, initial);
  assert.deepEqual(first.deleted, ['first']);
  assert.deepEqual(first.failed.map(row => row.id), ['second']);
  assert.deepEqual(first.skipped.map(row => row.id), ['s0']);
  assert.equal(f.manager.deleted('s0'), false);

  const restarted = createManager(f.options);
  const {items} = await restarted.list();
  assert.deepEqual(items.map(row => row.id), ['s0']);
  assert.equal(items[0].cleanupPending, true);
  fail = false;
  const retry = await restarted.prepare({ ids:['s0'] });
  assert.deepEqual(retry.items.map(row => row.id), ['second', 's0']);
  assert.deepEqual((await confirm(restarted, retry)).deleted, ['second', 's0']);
  assert.deepEqual((await restarted.list()).items, []);
});

test('a usage conflict before intent and an untouched legacy continuation both allow unarchiving', async () => {
  const f = fixture(1);
  f.options.purger.purge = async () => { throw new PurgeRefusal('日志用量有分歧'); };
  const failed = await confirm(f.manager, await f.manager.prepare({ ids:['s0'] }));
  assert.equal(failed.failed[0].reason, '日志用量有分歧');
  assert.equal(f.options.continuations.get('s0'), undefined);
  assert.equal(f.stored.has('s0'), false);
  await f.options.continuations.put('s0', { title:'旧版续删记录' });
  assert.equal((await f.manager.list()).items[0].canUnarchive, true);
  assert.deepEqual((await f.manager.restore(['s0'])).restored, ['s0']);
  assert.equal(f.options.continuations.get('s0'), undefined);
});

test('a completed grandchild keeps a legacy root continuation protected', async () => {
  const f = fixture(1);
  const original = f.query.listSessions;
  f.query.listSessions = async () => [...await original(), { header:{ id:'child', origin:'subagent', parentSession:'s0' } }];
  f.stored.set('grandchild', { deletedAt:1, purgedAt:2, parentSession:'child' });
  await f.options.continuations.put('s0', { title:'部分清理' });
  assert.equal((await f.manager.list()).items.find(row => row.id === 's0').canUnarchive, false);
  assert.deepEqual((await f.manager.restore(['s0'])).restored, []);
});

test('preparation keeps the session loaded and release drift requires a fresh confirmation', async () => {
  const f = fixture(1);
  let loaded = true, releases = 0;
  const inspect = f.options.purger.inspect;
  f.options.releaseSession = async (id, detached) => {
    if (!loaded) return;
    loaded = false; releases++;
    detached.add(id);
  };
  f.options.purger.refresh = async inventory => inventory;
  f.options.purger.inspect = async id => {
    const log = await inspect(id);
    if (!loaded) log.files.push({ path:'new-cache', kind:'cache', bytes:5 });
    return log;
  };
  f.options.purger.verify = async log => {
    if ((await f.options.purger.inspect(log.id)).files.length !== log.files.length) throw new PurgeRefusal('范围有变化');
  };
  const manager = createManager(f.options);
  const plan = await manager.prepare({ ids:['s0'] });
  assert.equal(releases, 0);
  const changed = await confirm(manager, plan);
  assert.equal(releases, 1);
  assert.equal(changed.confirmation.reviewRequired, true);
  assert.deepEqual(changed.confirmation.items[0].files.map(file => file.path), ['test/s0','new-cache']);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(await confirm(manager, plan), changed);
  assert.deepEqual((await confirm(manager, changed.confirmation)).deleted, ['s0']);
});

test('batch finalization runs once and leaves durable intent on reconciliation failure', async () => {
  const f = fixture(3);
  let synchronizations = 0;
  f.options.purger.finishBatch = async ids => {
    synchronizations++;
    assert.deepEqual(ids, f.ids);
    assert(ids.every(id => f.stored.get(id).purgePending));
    throw new PurgeRefusal('搜索索引尚未更新');
  };
  const result = await confirm(f.manager, await f.manager.prepare({ all:true }));
  assert.equal(synchronizations, 1);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed.length, 3);
  assert(f.ids.every(id => f.stored.get(id).purgePending));
});

test('one inventory is shared by all completed records in a list and preparation', async () => {
  const f = fixture(5);
  for (const id of f.ids.slice(1)) f.stored.set(id, { deletedAt:1, purgedAt:2 });
  let scans = 0;
  const inventory = {};
  f.options.purger.snapshot = async () => { scans++; return inventory; };
  f.options.purger.inspect = async (id, withChildren, snapshot) => {
    assert.equal(snapshot, inventory);
    return {id, bytes:0, files:[]};
  };
  await f.manager.list();
  assert.equal(scans, 1);
  await f.manager.prepare({ all:true });
  assert.equal(scans, 2);
});
test('single list and direct confirmed deletion cover every archived session',async()=>{const f=fixture();assert.equal((await f.manager.list()).items.length,26);const p=await f.manager.prepare({all:true});assert.equal(p.count,26);assert.equal(p.items[0].files.length,1);assert.equal(f.removed.length,0);await assert.rejects(f.manager.commit(p.token));assert.equal(f.removed.length,0);assert.equal((await confirm(f.manager,p)).deleted.length,26);assert.equal((await f.manager.list()).items.length,0);assert.equal(f.stored.get('s0').cleanupVersion,2);});
test('old soft-delete clients cannot bypass permanent-delete confirmation',async()=>{const f=fixture();await assert.rejects(f.manager.prepare({all:true,mode:'soft'}),/重新打开/);assert.equal(f.removed.length,0);});
test('confirmation freezes targets, skips restored entries and excludes later archives',async()=>{const f=fixture(3),p=await f.manager.prepare({all:true});await f.registry.unarchiveSession('s1');await f.registry.archiveSession('later');const r=await confirm(f.manager,p);assert.deepEqual(r.deleted,['s0','s2']);assert.equal(r.skipped.length,1);});
test('legacy deleted and residual completed entries are in the same list',async()=>{const f=fixture(2);f.stored.set('s0',{deletedAt:1});f.stored.set('s1',{deletedAt:1,purgedAt:2});const rows=(await f.manager.list()).items;assert.equal(rows.length,2);assert(rows.every(r=>r.cleanupPending));assert.equal(rows.find(r=>r.id==='s1').canUnarchive,false);assert.equal((await confirm(f.manager,await f.manager.prepare({all:true}))).deleted.length,2);});
test('changed marker and running tasks are skipped, failures remain visible',async()=>{const f=fixture(3);f.options.activity=async id=>id==='s0'?['running']:[];f.options.purger.purge=async(w,hooks)=>{await hooks.beforeDelete();throw Error('copy failure');};const m=createManager(f.options),p=await m.prepare({all:true});f.stored.set('s1',{deletedAt:2});const r=await confirm(m,p);assert.equal(r.skipped.length,2);assert.equal(r.failed.length,1);assert.equal(f.stored.get('s2').purgePending,true);assert.equal((await m.list()).items.length,3);await assert.rejects(m.commit('missing',true));});
test('concurrent and repeated commit do not delete twice; expiry is enforced',async()=>{const f=fixture(2),p=await f.manager.prepare({all:true});const [a,b]=await Promise.all([confirm(f.manager,p),confirm(f.manager,p)]);assert.deepEqual(a,b);assert.equal(f.removed.length,2);assert.deepEqual(await confirm(f.manager,p),a);f.advance();await assert.rejects(confirm(f.manager,p),/过期/);});
test('unarchive works for ordinary and old soft-deleted entries but not partial purges',async()=>{const f=fixture(3);f.stored.set('s1',{deletedAt:1});f.stored.set('s2',{deletedAt:1,purgePending:true});assert.equal((await f.manager.restore(['s0','s1','s2'])).restored.length,2);assert.equal(f.stored.has('s1'),false);assert.equal(f.stored.has('s2'),true);});
test('file witnesses are captured after title projection reads',async()=>{const f=fixture(1);let queried=false;f.query.readTitleSnapshots=async()=>{queried=true;return[];};f.options.purger.inspect=async id=>{assert(queried);return{id,bytes:0,files:[],copyRoots:[]};};await createManager(f.options).prepare({all:true});});
test('invalid and duplicate IDs, blocked targets, notification errors',async()=>{const f=fixture(3);assert.throws(()=>validateIds([3]));f.options.purger.inspect=async id=>{if(id==='s1')throw Error('blocked');return{id,bytes:0,files:[]};};f.options.notify=()=>{throw Error();};const m=createManager(f.options);const p=await m.prepare({ids:['s0','s0','s1','unknown']});assert.equal(p.count,1);assert.equal(p.blocked.length,1);assert.deepEqual((await confirm(m,p)).deleted,['s0']);});
test('list and search visibility restores on disposal',()=>{const listState={list:async()=>[{sessionId:'s0'},{sessionId:'s1'}],search:async()=>({items:[{sessionId:'s0'},{sessionId:'s1'}]})};const original=listState.list,dispose=installVisibility(listState,id=>id==='s0');return(async()=>{assert.equal((await listState.list()).length,1);assert.equal((await listState.search()).items.length,1);dispose();assert.equal(listState.list,original);})();});
test('sidebar still uses the normal conversation view',()=>{let value='only';const view={setArchivedFilter(mode){value=mode;}},original=view.setArchivedFilter;const dispose=installSidebarPolicy(view);assert.equal(value,'default');view.setArchivedFilter('show');assert.equal(value,'default');dispose();assert.equal(view.setArchivedFilter,original);});
test('local origin and JSON guards reject foreign mutation requests',()=>{const req={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:19421','x-dsh-archive-manager':'1','content-type':'application/json'}};assert.equal(authorize(req),200);assert.equal(authorize({...req,headers:{...req.headers,origin:'https://evil.test'}}),403);assert.equal(authorize({...req,socket:{remoteAddress:'10.0.0.1'}}),403);assert.equal(authorize({...req,headers:{...req.headers,'content-type':'text/plain'}}),415);});
test('body parser requires a bounded JSON object',async()=>{assert.deepEqual(await readBody(Readable.from([Buffer.from('{"all":true}')])),{all:true});await assert.rejects(readBody(Readable.from([Buffer.from('null')])));await assert.rejects(readBody(Readable.from([Buffer.alloc(1024*1024+1)])));});
