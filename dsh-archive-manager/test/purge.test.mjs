import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,lstat,access,symlink,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectLog,createPurger} from '../src/purge.js';
import {createCopyCleaner} from '../src/copies.js';
import {createManager} from '../src/manager.js';

async function fixture(preserveUsage=async()=>{}){
 const root=path.resolve('.sandbox/purge-tests',randomUUID()),dir=path.join(root,'project','s1'),file=path.join(dir,'session.v4.jsonl');await mkdir(dir,{recursive:true});await writeFile(file,'synthetic log only');
 const claims=new Set();let leaseHeld=false;let live=false;
 const snapshot=async()=>{try{const st=await lstat(file,{bigint:true});return{header:{id:'s1',version:4},formatStatus:'current',location:{kind:'jsonl',path:file},revision:[st.size,st.mtimeNs,st.ctimeNs].join(':')};}catch(e){if(e.code==='ENOENT')return;throw e;}};
 const persistence={name:'session-persistence-jsonl',root,stat:snapshot,list:async()=>{const s=await snapshot();return s?[s]:[];},locate:()=>({path:file}),tracker:{claimWrite(id){if(claims.has(id))throw Error('owned');claims.add(id);},releaseClaim(id){claims.delete(id);}},acquireLease:async()=>{leaseHeld=true;return{release:async()=>{leaseHeld=false;}};},coldLogMemo:new Map([['s1','cached']])};
 const purger=createPurger({persistence,sessions:{get:()=>live?{}:undefined},preserveUsage});
 return {root,dir,file,persistence,purger,claims,isHeld:()=>leaseHeld,setLive:v=>{live=v;}};
}
test('purge only unlinks the confirmed log under write lock, preserving project and releasing ownership',async()=>{const f=await fixture();const witness=await f.purger.inspect('s1');const projectFile=path.join(f.root,'project','keep.txt');await writeFile(projectFile,'keep');let pending=false,done=false;await f.purger.purge(witness,{beforeDelete:async()=>{assert.equal(f.isHeld(),true);await access(f.file);pending=true;},afterDelete:async()=>{assert.ok(pending);await assert.rejects(access(f.file));done=true;}});assert.ok(done);assert.equal(await readFile(projectFile,'utf8'),'keep');assert.equal(f.claims.size,0);assert.equal(f.isHeld(),false);assert.equal(f.persistence.coldLogMemo.has('s1'),false);});
test('path validation rejects traversal, project root, unknown generations and extra sidecars',async()=>{const f=await fixture();await assert.rejects(inspectLog(f.root,path.join(f.root,'..','session.v4.jsonl')));await assert.rejects(inspectLog(f.root,f.dir));await writeFile(path.join(f.dir,'session.v3.jsonl'),'old');await assert.rejects(f.purger.inspect('s1'),/历史版本/);await access(f.file);});
test('linked session directory is rejected',async()=>{const f=await fixture();const link=path.join(f.root,'project','linked');await symlink(f.dir,link,'junction');await assert.rejects(inspectLog(f.root,path.join(link,'session.v4.jsonl')),/链接/);});
test('changed log since confirmation is refused without deleting',async()=>{const f=await fixture(),w=await f.purger.inspect('s1');await writeFile(f.file,'changed contents');await assert.rejects(f.purger.purge(w,{beforeDelete:async()=>{},afterDelete:async()=>{}}),/变化/);assert.equal(await readFile(f.file,'utf8'),'changed contents');assert.equal(f.claims.size,0);});
test('live sessions, descendants and existing ownership are refused',async()=>{const f=await fixture();f.setLive(true);await assert.rejects(f.purger.inspect('s1'),/加载/);f.setLive(false);const list=f.persistence.list;f.persistence.list=async()=>[...(await list()),{header:{id:'child',parentSession:'s1'}}];await assert.rejects(f.purger.inspect('s1'),/派生/);f.persistence.list=list;const w=await f.purger.inspect('s1');f.claims.add('s1');await assert.rejects(f.purger.purge(w,{beforeDelete:async()=>{},afterDelete:async()=>{}}),/owned/);assert.ok(f.claims.has('s1'));await access(f.file);});
test('failed durable intent leaves log untouched; failed completion can be retried as missing',async()=>{const f=await fixture(),w=await f.purger.inspect('s1');await assert.rejects(f.purger.purge(w,{beforeDelete:async()=>{throw Error('disk');},afterDelete:async()=>{}}));await access(f.file);assert.equal(f.isHeld(),false);await assert.rejects(f.purger.purge(w,{beforeDelete:async()=>{},afterDelete:async()=>{throw Error('commit');}}));await assert.rejects(access(f.file));const missing=await f.purger.inspect('s1');assert.ok(missing.missing);let done=false;await f.purger.purge(missing,{beforeDelete:async()=>{},afterDelete:async()=>{done=true;}});assert.ok(done);});

test('usage is durably saved under the lease before deleting the log',async()=>{
 let saved=false; const f=await fixture(async snapshot=>{assert.equal(snapshot.id,'s1');assert.ok(f.isHeld());await access(f.file);saved=true;});
 await f.purger.purge(await f.purger.inspect('s1'),{beforeDelete:async()=>{assert.ok(saved);},afterDelete:async()=>{await assert.rejects(access(f.file));}});
});
test('failed or unavailable usage persistence refuses deletion and releases the lease',async()=>{
 for(const preserveUsage of [async()=>{throw Error('disk full');},null]){
  const f=await fixture(preserveUsage);let marked=false;
  await assert.rejects(f.purger.purge(await f.purger.inspect('s1'),{beforeDelete:async()=>{marked=true;},afterDelete:async()=>{}}),/用量/);
  assert.equal(marked,false);await access(f.file);assert.equal(f.isHeld(),false);assert.equal(f.claims.size,0);
 }
});

test('a newly discovered copy after confirmation refuses all deletion',async()=>{
 const f=await fixture();let files=[];const copies={inspect:async()=>({roots:['backup'],files}),remove:async()=>{throw Error('must not remove');}};
 const purger=createPurger({persistence:f.persistence,sessions:{get:()=>undefined},preserveUsage:async()=>{},copies});
 const witness=await purger.inspect('s1');files=[{path:'new-cache',kind:'cache',bytes:1,fingerprint:'new'}];
 await assert.rejects(purger.purge(witness,{beforeDelete:async()=>{throw Error('must not mark');},afterDelete:async()=>{}}),/变化/);await access(f.file);
});
test('copy removal failure preserves source log and never reports completion',async()=>{
 const f=await fixture();let completed=false,pending=false;
 const copies={inspect:async()=>({roots:['backup'],files:[{path:'cache',kind:'cache',bytes:1,fingerprint:'x'}]}),remove:async()=>{throw Error('locked copy');}};
 const purger=createPurger({persistence:f.persistence,sessions:{get:()=>undefined},preserveUsage:async()=>{},copies});
 await assert.rejects(purger.purge(await purger.inspect('s1'),{beforeDelete:async()=>{pending=true;},afterDelete:async()=>{completed=true;}}),/locked copy/);
 assert(pending);assert.equal(completed,false);await access(f.file);assert.equal(f.claims.size,0);assert.equal(f.isHeld(),false);
});

test('incremental recheck discovers a new backup introduced while acquiring the write lease', async () => {
  const f = await fixture();
  const backup = f.root + '-backup';
  const backupFile = path.join(backup, 'sessions', 'project', 's1', 'session.v4.jsonl');
  const log = JSON.stringify({ id:'s1', version:4 }) + '\n';
  await writeFile(f.file, log);
  await mkdir(backup);
  const acquire = f.persistence.acquireLease;
  f.persistence.acquireLease = async (...args) => {
    const lease = await acquire(...args);
    await mkdir(path.dirname(backupFile), { recursive:true });
    await writeFile(backupFile, log);
    return lease;
  };
  f.persistence.tracker.pendingEntries = () => [];
  const copies = createCopyCleaner({ primaryRoot:f.root, scanRoots:[backup] });
  const purger = createPurger({ persistence:f.persistence, sessions:new Map(), copies, preserveUsage:async()=>{} });
  const inventory = await purger.snapshot();
  const witness = await purger.inspect('s1', true, inventory);
  let marked = false;
  await assert.rejects(purger.purge(witness, { beforeDelete:async()=>{marked=true;} }, inventory), /变化/);
  assert.equal(marked, false);
  await access(f.file);
  await access(backupFile);
});

test('a missing registered backup blocks preparation and losing it under lease preserves the log', async () => {
  const f = await fixture();
  const backup = f.root + '-backup';
  await writeFile(f.file, JSON.stringify({ id:'s1', version:4 }) + '\n');
  const copies = createCopyCleaner({ primaryRoot:f.root, scanRoots:[backup] });
  const purger = createPurger({ persistence:f.persistence, sessions:new Map(), copies, preserveUsage:async()=>{} });
  assert.deepEqual(await purger.backupStatus(), [{ path:backup, status:'missing' }]);
  await assert.rejects(purger.snapshot(), /备份目录不可用/);
  await mkdir(backup);
  const inventory = await purger.snapshot();
  assert.deepEqual(inventory.copies.backupRoots, [{ path:backup, status:'available' }]);
  const witness = await purger.inspect('s1', true, inventory);
  const acquire = f.persistence.acquireLease;
  f.persistence.acquireLease = async (...args) => {
    const lease = await acquire(...args);
    await rename(backup, backup + '-offline');
    return lease;
  };
  await assert.rejects(purger.purge(witness, { beforeDelete:async()=>assert.fail('deletion was started') }, inventory), /备份目录不可用/);
  await access(f.file);
  assert.equal(f.isHeld(), false);
});

test('snapshot directory entries are reused and a new sidecar still blocks deletion', async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ id:'s1', version:4 }) + '\n');
  const copies = createCopyCleaner({ primaryRoot:f.root });
  const purger = createPurger({ persistence:f.persistence, sessions:new Map(), copies, preserveUsage:async()=>{} });
  const inventory = await purger.snapshot();
  const initialEntries = inventory.copies.directories.get(f.dir).entries;
  await purger.inspect('s1', true, inventory);
  assert.strictEqual(inventory.copies.directories.get(f.dir).entries, initialEntries);
  await writeFile(path.join(f.dir, 'session.v3.jsonl'), 'legacy log');
  await assert.rejects(purger.inspect('s1', true, inventory), /历史版本/);
  await access(f.file);
});

test('30 real synthetic logs use two full host listings and one search reconciliation during commit', async () => {
  const root = path.resolve('.sandbox/purge-tests', randomUUID());
  const ids = Array.from({length:30}, (_, index) => 'session-' + index);
  const records = new Map();
  await Promise.all(ids.map(async id => {
    const header = { id, version:4 };
    const file = path.join(root, 'project', id, 'session.v4.jsonl');
    await mkdir(path.dirname(file), { recursive:true });
    await writeFile(file, JSON.stringify(header) + '\n');
    records.set(id, { header, location:{ kind:'jsonl', path:file }, revision:'initial' });
  }));
  let lists = 0, reconciliations = 0;
  async function stat(id) {
    const record = records.get(id);
    try { await access(record.location.path); return record; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const persistence = {
    name:'session-persistence-jsonl', root, stat,
    list:async()=>{lists++;return (await Promise.all(ids.map(stat))).filter(Boolean);},
    locate:({id})=>records.get(id).location,
    tracker:{pendingEntries:()=>[],claimWrite(){},releaseClaim(){}},
    acquireLease:async()=>({release:async()=>{}}),
  };
  const copies = createCopyCleaner({primaryRoot:root});
  const purger = createPurger({persistence,copies,sessions:new Map(),preserveUsage:async()=>{},verifySearch:async()=>{reconciliations++;}});
  const table = () => {
    const items = new Map();
    return { get:id=>items.get(id), entries:()=>items.entries(), put:async(id,value)=>items.set(id,value), delete:async id=>items.delete(id) };
  };
  const manager = createManager({
    registry:{archivedSessionIds:ids,enqueueOperation:task=>task()},
    query:{listSessions:async()=>[...records.values()],readTitleSnapshots:async()=>[]},
    table:table(),continuations:table(),activity:async()=>[],notify(){},purger,
  });
  const plan = await manager.prepare({ids});
  assert.equal(lists, 1);
  lists = 0;
  const result = await manager.commit(plan.token, true);
  assert.deepEqual(result, {deleted:ids,skipped:[],failed:[]});
  assert.equal(lists, 2);
  assert.equal(reconciliations, 1);
});
