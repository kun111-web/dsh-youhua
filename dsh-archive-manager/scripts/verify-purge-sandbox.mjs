// Explicit integration fixture only: never accepts a real profile or arbitrary IDs.
import {readFile,writeFile,readdir,access,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../.sandbox/verified-home');
const id='archive-qa-01',base='http://127.0.0.1:19421/api/dsh-archive-manager-local';
async function api(action,body){const response=await fetch(`${base}/${action}`,{method:body?'POST':'GET',headers:{'x-dsh-archive-manager':'1','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
async function hashes(dir){let result={};for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())Object.assign(result,await hashes(file));else if(entry.name.startsWith('session.v4.jsonl'))result[file]=createHash('sha256').update(await readFile(file)).digest('hex');}return result;}
const before=await hashes(path.join(root,'sessions'));
const target=Object.keys(before).find(file=>path.basename(path.dirname(file))===id);
assert(target,'Synthetic target must exist before integration test');
const list=(await api('list')).data;
assert(list.items.every(row=>/^archive-qa-\d+$/.test(row.id)&&row.workspace===path.resolve(import.meta.dirname,'../.sandbox/project')),'Only sandbox conversations may be present');
const sentinel=path.resolve(import.meta.dirname,'../.sandbox/project/purge-project-sentinel.txt');
await mkdir(path.dirname(sentinel),{recursive:true});await writeFile(sentinel,'Project files must survive.');
const prepared=await api('prepare',{mode:'purge',ids:[id]});
assert.equal(prepared.status,200,JSON.stringify(prepared));assert.equal(prepared.data.count,1);assert.equal(prepared.data.mode,'purge');
const wrong=await api('commit',{token:prepared.data.token,confirmed:false});
assert.equal(wrong.status,400);await access(target);
const committed=await api('commit',{token:prepared.data.token,confirmed:true});
assert.deepEqual(committed.data,{deleted:[id],skipped:[],failed:[]});
assert.deepEqual((await api('commit',{token:prepared.data.token,confirmed:true})).data,committed.data);
const after=await hashes(path.join(root,'sessions'));
assert.equal(after[target],undefined);delete before[target];assert.deepEqual(after,before);
assert.equal(await readFile(sentinel,'utf8'),'Project files must survive.');
const restore=await api('restore',{ids:[id],fromDeleted:true});assert.equal(restore.data.restored.length,0);assert.equal(restore.data.failed.length,1);
const final=(await api('list')).data;assert(!final.items.some(row=>row.id===id));
const storage=JSON.parse(await readFile(path.join(root,'storages/archive_manager_local.json'),'utf8'));
assert(storage.tables.deleted[id].purgedAt);
const report={testedAt:new Date().toISOString(),profile:root,target:id,bytes:prepared.data.bytes,remainingFiles:Object.keys(after).length,unchangedOtherFiles:true,projectFilePreserved:true,wrongConfirmationRejected:true,restoreRejected:true,durablePurgedMarker:true,result:committed.data};
await writeFile(path.resolve(import.meta.dirname,'../qa/purge-integration.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
