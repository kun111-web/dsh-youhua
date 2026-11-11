import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
await mkdir('.preview',{recursive:true});
await build({entryPoints:['scripts/preview-entry.jsx'],outfile:'.preview/app.js',bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'}});
const html=await readFile('scripts/preview.html');
createServer(async(req,res)=>{try{
  if(new URL(req.url,'http://127.0.0.1').pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(html);}
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile('.preview/app.js'));}
  if(req.url==='/local-data.json'){res.setHeader('content-type','application/json');return res.end(await readFile('qa/local-data.json'));}
  res.writeHead(404);res.end();
}catch{res.writeHead(500);res.end('Preview data unavailable');}}).listen(19420,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:19420'));
