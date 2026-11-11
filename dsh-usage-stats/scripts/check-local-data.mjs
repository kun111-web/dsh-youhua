// Development-only independent reader; production uses DSH sessionPersistence.
import { readdir,readFile,mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { foldSession,summarizeSessions } from '../src/aggregate.js';
const root=process.env.DSH_HOME??join(homedir(),'.dsh');
async function* files(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())yield*files(path);else if(item.name==='session.v4.jsonl.zstd')yield path;}}
const folds=[];let independent=0;
for await(const file of files(join(root,'sessions'))){
 const rows=zstdDecompressSync(await readFile(file)).toString('utf8').trim().split('\n').map(s=>JSON.parse(s));const header=rows.shift();
 // This verifier refuses seeded records rather than guessing their encoded cut.
 if(header.version!==4||header.isSeeded)throw Error('Verifier only supports unseeded v4 records; use the host reader for forks.');
 folds.push(foldSession(rows));
 const seen=new Set();for(const e of rows){if(e.type!=='assistant/message'||!e.data?.usage||seen.has(e.seq))continue;seen.add(e.seq);const u=e.data.usage;independent+=u.totalTokens??(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].reduce((n,k)=>n+(u[k]??0),0));}
}
const snapshot=summarizeSessions(folds);if(snapshot.summary.totalTokens!==independent)throw Error('Independent total mismatch');
await mkdir('qa',{recursive:true});await writeFile('qa/local-data.json',JSON.stringify(snapshot,null,2));
console.log(JSON.stringify({sessions:folds.length,totalTokens:snapshot.summary.totalTokens,models:[...new Set(snapshot.days.flatMap(d=>d.models.map(m=>m.model)))],independentTotalMatches:true}));
