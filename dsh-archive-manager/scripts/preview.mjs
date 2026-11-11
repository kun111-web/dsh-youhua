// Visual-only preview with clearly labelled synthetic data; never touches DSH.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
process.chdir(path.resolve(import.meta.dirname,'..'));
await mkdir('.preview',{recursive:true});
await writeFile('.preview/entry.jsx',`
import React from 'react';import{createRoot}from'react-dom/client';import{App}from'../src/client/App.jsx';import css from '../src/client/style.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
let rows=[{id:'demo-1',title:'界面排版调整',workspace:'F:/示例项目',createdAt:Date.now(),canUnarchive:true},{id:'demo-2',title:'待清理的旧会话',workspace:'未分组',deletedAt:Date.now(),cleanupPending:true,canUnarchive:false}];
let targets=[], progress;
const backupRoots=[{path:'F:/示例项目/.sandbox',status:new URLSearchParams(location.search).has('missing')?'missing':'available'}];
async function request(action,body){
  if(action.startsWith('list'))return{items:rows,backupRoots};
  if(action==='prepare'){
    if(backupRoots[0].status==='missing')throw Error('已登记的备份目录不可用，已暂停清理');
    targets=rows.filter(r=>body.ids.includes(r.id));
    return{token:'synthetic',mode:'purge',count:targets.length,bytes:1050000,backupRoots,
      checkedRoots:['C:/Users/示例/.dsh/sessions','F:/示例项目/.sandbox/home/sessions'],
      items:targets.map(r=>({...r,files:[{path:'C:/Users/示例/.dsh/sessions/project/'+r.id+'/session.v4.jsonl.zstd',kind:'log'},
        {path:'F:/示例项目/.sandbox/home/sessions/project/'+r.id+'/session.v4.jsonl.zstd',kind:'copy'}]})),blocked:[]};
  }
  if(action.startsWith('progress?'))return{...progress};
  if(action==='commit'){
    progress={phase:'deleting',processed:0,total:targets.length};
    for(const _target of targets){await new Promise(resolve=>setTimeout(resolve,1200));progress.processed++;}
    progress.phase='finalizing';
    await new Promise(resolve=>setTimeout(resolve,1000));
    const result={deleted:targets.filter(r=>r.id!=='demo-2').map(r=>r.id),skipped:[],
      failed:targets.filter(r=>r.id==='demo-2').map(r=>({id:r.id,reason:'模拟副本仍被占用'}))};
    rows=rows.filter(r=>!result.deleted.includes(r.id));
    return result;
  }
  rows=rows.filter(r=>!body.ids.includes(r.id));return{restored:body.ids,failed:[]};
}
createRoot(document.getElementById('app')).render(<App request={request}/>);
`);
await build({entryPoints:['.preview/entry.jsx'],outfile:'.preview/app.js',bundle:true,format:'esm',platform:'browser',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'}});
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>归档管理 · 模拟数据预览</title><style>body{margin:0;background:#fff;padding:28px;font-family:system-ui}main{max-width:820px;margin:auto}.demo{font-size:12px;color:#888;margin:0 0 20px}</style><main><p class="demo">模拟数据预览 · 不操作真实会话</p><div id="app"></div></main><script type="module" src="/app.js"></script>';
createServer(async(req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(await readFile('.preview/app.js'));}else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}else{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);}}).listen(19423,'127.0.0.1',()=>console.log('Preview http://127.0.0.1:19423'));
