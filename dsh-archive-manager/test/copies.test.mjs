import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,access,symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCopyCleaner, installCheckpointPolicy, readCopyUsage } from '../src/copies.js';
async function fixture(){
 const base=path.resolve('.sandbox/copy-tests',randomUUID()),primary=path.join(base,'primary/sessions'),backup=path.join(base,'backup/sessions');
 await mkdir(primary,{recursive:true});await mkdir(path.join(backup,'project','target'),{recursive:true});
 const file=path.join(backup,'project/target/session.v4.jsonl');
 await writeFile(file,JSON.stringify({version:4,id:'target',isSeeded:false})+'\n'+JSON.stringify({type:'assistant/message',data:{message:{content:'synthetic private text'}}})+'\n');
 const cache=path.join(base,'backup/storages/session_projcache/sessions/target.json');await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,JSON.stringify({version:7,record:{identity:{createdAt:1},rows:{test:{text:'synthetic'}}}}));
 const cleaner=createCopyCleaner({primaryRoot:primary,scanRoots:[path.dirname(backup)]});
 return{base,primary,backup,file,cache,cleaner};
}
test('known copy and projection cache are enumerated and individually removed',async()=>{const f=await fixture();const result=await f.cleaner.inspect('target');assert.equal(result.files.length,2);assert.deepEqual(new Set(result.files.map(x=>x.kind)),new Set(['copy','cache']));for(const file of result.files)await f.cleaner.remove(file,'target');assert.equal((await f.cleaner.inspect('target')).files.length,0);await access(path.join(f.backup,'project'));});
test('other session copies are untouched',async()=>{const f=await fixture();const dir=path.join(f.backup,'project/other');await mkdir(dir);const file=path.join(dir,'session.v4.jsonl');await writeFile(file,JSON.stringify({version:4,id:'other'})+'\n');for(const item of (await f.cleaner.inspect('target')).files)await f.cleaner.remove(item,'target');assert.equal(JSON.parse((await readFile(file,'utf8')).trim()).id,'other');});
test('identity mismatch and derived copies refuse cleanup',async()=>{const f=await fixture();await writeFile(f.file,JSON.stringify({version:4,id:'wrong'})+'\n');await assert.rejects(f.cleaner.inspect('target'),/身份/);await writeFile(f.file,JSON.stringify({version:4,id:'target'})+'\n');const dir=path.join(f.backup,'project/child');await mkdir(dir);await writeFile(path.join(dir,'session.v4.jsonl'),JSON.stringify({version:4,id:'child',parentSession:'target'})+'\n');await assert.rejects(f.cleaner.inspect('target'),/派生/);await access(f.file);});
test('changed copies and linked directories are refused',async()=>{const f=await fixture();const witness=(await f.cleaner.inspect('target')).files.find(x=>x.kind==='copy');await writeFile(f.file,'changed');await assert.rejects(f.cleaner.remove(witness,'target'),/变化/);const link=path.join(f.backup,'linked');await symlink(path.join(f.backup,'project'),link,'junction');await assert.rejects(f.cleaner.inspect('target'),/链接|JSON/);});
test('unsafe IDs never become paths',async()=>{const f=await fixture();await assert.rejects(f.cleaner.inspect('../target'),/ID/);await access(f.file);});

test('an unreadable backup is reported, blocks its own ID, and is kept when cleaning another session', async () => {
  const f = await fixture();
  const brokenDir = path.join(f.backup, 'project', 'broken');
  const brokenLog = path.join(brokenDir, 'session.v4.jsonl');
  await mkdir(brokenDir);
  await writeFile(brokenLog, 'invalid JSON\n');
  const snapshot = await f.cleaner.scan();
  const target = await f.cleaner.inspect('target', { snapshot });
  assert.deepEqual(target.warnings, [brokenLog]);
  await assert.rejects(f.cleaner.inspect('broken', { snapshot }), /broken/);
  for (const file of target.files) await f.cleaner.remove(file, 'target');
  await access(brokenLog);
});
test('late projection writes cannot recreate deleted conversation caches',async()=>{const calls=[],cache={put:async(id,v)=>calls.push([id,v])};const original=cache.put;const dispose=installCheckpointPolicy(cache,id=>id==='deleted');await cache.put('deleted',{text:'private'});await cache.put('kept',{});assert.equal(calls.length,1);dispose();assert.equal(cache.put,original);});

test('an orphan projection cache is included when a registered backup has no logs', async () => {
  const f = await fixture();
  const orphan = path.join(f.base, 'cache-only');
  const file = path.join(orphan, 'storages/session_projcache/sessions/target.json.bak.1');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await readFile(f.cache));
  const cleaner = createCopyCleaner({ primaryRoot: f.primary, scanRoots: [orphan] });
  const plan = await cleaner.inspect('target');
  assert.deepEqual(plan.files.map(entry => entry.path), [file]);
  await cleaner.remove(plan.files[0], 'target');
  assert.deepEqual((await cleaner.inspect('target')).files, []);
});

test('a second log in the primary corpus is included as a copy', async () => {
  const f = await fixture();
  const primaryLog = path.join(f.primary, 'project/target/session.v4.jsonl');
  const duplicate = path.join(f.primary, 'another-project/target/session.v4.jsonl');
  for (const file of [primaryLog, duplicate]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await readFile(f.file));
  }
  const cleaner = createCopyCleaner({ primaryRoot: f.primary });
  const plan = await cleaner.inspect('target', { primaryLog });
  assert.deepEqual(plan.files.map(entry => entry.path), [duplicate]);
  await cleaner.remove(plan.files[0], 'target');
  await access(primaryLog);
  assert.deepEqual((await cleaner.inspect('target', { primaryLog })).files, []);
});

test('backup usage excludes inherited messages and refuses a truncated JSONL body', async () => {
  const f = await fixture();
  const event = (seq, tokens) => ({ seq, time: 2 + seq, type: 'assistant/message', data: { usage: { totalTokens: tokens } } });
  const rows = [
    { type: 'session', version: 4, id: 'target', isSeeded: true },
    event(0, 100),
    { seq: 1, time: 3, type: 'session/end-seed', data: { inherited: true } },
    event(2, 50),
  ];
  const jsonl = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const witness = async () => (await f.cleaner.inspect('target')).files.find(file => file.kind === 'copy');
  await writeFile(f.file, jsonl);
  const usage = await readCopyUsage(await witness(), 'target', {}, 'Asia/Shanghai');
  assert.equal(usage.fold.days[0].tokens, 50);
  assert.equal(usage.usageFingerprints.length, 64);
  await writeFile(f.file, jsonl + '{"seq":');
  await assert.rejects(readCopyUsage(await witness(), 'target', {}, 'Asia/Shanghai'), /文件已保留/);
  await access(f.file);
});

test('a refreshed inventory reuses unchanged headers and detects in-place relationship changes', async () => {
  const f = await fixture();
  const other = path.join(f.backup, 'project', 'other', 'session.v4.jsonl');
  await mkdir(path.dirname(other));
  await writeFile(other, JSON.stringify({version:4,id:'other'}) + '\n');
  const first = await f.cleaner.scan();
  await writeFile(f.file, JSON.stringify({version:4,id:'target',origin:'subagent',parentSession:'other'}) + '\n');
  const next = await f.cleaner.scan(first);
  assert.equal(next.headers.get(other).header, first.headers.get(other).header);
  assert.notEqual(next.headers.get(f.file).header, first.headers.get(f.file).header);
  assert.deepEqual((await f.cleaner.inspect('other', {snapshot:next,withChildren:true})).children, ['target']);
});
