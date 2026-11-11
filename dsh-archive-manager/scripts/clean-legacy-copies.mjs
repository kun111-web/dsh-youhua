// One-time, explicit offline cleanup of already-purged sessions only.
import { readFile,writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createCopyCleaner } from '../src/copies.js';
import { foldSession } from '../../dsh-usage-stats/src/aggregate.js';
const args=process.argv.slice(2),index=args.indexOf('--home');
if(index<0||!args[index+1])throw Error('--home required');
const home=path.resolve(args[index+1]),workspace=path.resolve(import.meta.dirname,'../..');
const cleaner=createCopyCleaner({primaryRoot:path.join(home,'sessions'),scanRoots:[path.join(workspace,'dsh-usage-stats/.sandbox'),path.join(workspace,'dsh-archive-manager/.sandbox')]});
const marks=JSON.parse(await readFile(path.join(home,'storages/archive_manager_local.json'),'utf8')).tables.deleted;
const ledgerDir=path.join(home,'storages/usage_stats_local');
const timeZone=JSON.parse(await readFile(path.join(ledgerDir,'global.json'),'utf8')).record;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plans=[];
for(const [id,mark] of Object.entries(marks)){
 if(!mark.purgedAt)continue;
 const plan=await cleaner.inspect(id);if(!plan.files.length)continue;
 const ledgerPath=path.join(ledgerDir,'sessions',id+'.json'),ledgerRaw=await readFile(ledgerPath),saved=JSON.parse(ledgerRaw).record.fold;
 for(const file of plan.files.filter(f=>f.kind==='copy')){
  const raw=await readFile(file.path),decoded=file.path.endsWith('.zstd')?zstdDecompressSync(raw):raw;
  const rows=decoded.toString('utf8').trim().split('\n').map(JSON.parse),header=rows.shift();
  assert.equal(header.id,id);assert.equal(header.isSeeded,false,'Seeded copies need the host reader');assert(rows.length,'Refuse incomplete decompression');
  const fold=foldSession(rows,{timeZone});assert.equal(fold.invalidUsage,0);
  for(const day of fold.days)for(const model of day.models){
   const kept=saved.days.find(d=>d.date===day.date)?.models.find(m=>m.key===model.key)?.tokens??0;
   assert(kept>=model.tokens,'Saved usage must cover every model/day in the copy before deleting it');
  }
 }
 plans.push({id,ledgerPath,ledgerHash:hash(ledgerRaw),files:plan.files});
}
console.log(JSON.stringify({apply:args.includes('--apply'),sessions:plans.length,files:plans.flatMap(p=>p.files.map(f=>({path:f.path,kind:f.kind,bytes:f.bytes})))},null,2));
if(args.includes('--apply')){
 for(const plan of plans){
  assert.equal(hash(await readFile(plan.ledgerPath)),plan.ledgerHash);
  for(const file of plan.files)await cleaner.remove(file,plan.id);
  assert.equal((await cleaner.inspect(plan.id)).files.length,0);
  assert.equal(hash(await readFile(plan.ledgerPath)),plan.ledgerHash,'Usage ledger must remain unchanged');
 }
 await writeFile(path.resolve(import.meta.dirname,'../qa/legacy-copy-cleanup.json'),JSON.stringify({cleanedAt:new Date().toISOString(),home,plans,usageUnchanged:true,remainingKnownFiles:0},null,2)+'\n');
 console.log('Verified: known copies/caches absent; usage ledger unchanged.');
}
