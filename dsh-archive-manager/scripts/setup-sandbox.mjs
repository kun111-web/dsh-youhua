import {mkdir,writeFile,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const home=resolve('.sandbox/verified-home'),profile=join(home,'profiles/web');
const dest=join(profile,'node_modules/dsh-archive-manager-local');await mkdir(dest,{recursive:true});
for(const file of ['lib','package.json','cordis.patch.yml'])await cp(file,join(dest,file),{recursive:true});
const seed=resolve('.sandbox/seed-source');await mkdir(seed,{recursive:true});
await mkdir('.sandbox/project',{recursive:true});
await writeFile(join(seed,'package.json'),JSON.stringify({name:'archive-qa-seed',version:'1.0.0',type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
await writeFile(join(seed,'cordis.patch.yml'),'- insert:\n    - id: archive-qa-seed\n      name: archive-qa-seed\n');
await writeFile(join(seed,'index.js'),`import {existsSync,writeFileSync} from 'node:fs';
export const inject=['sessionPersistence','workspaceRegistry'];
export async function apply(ctx){
 if(process.env.DSH_HOME!==${JSON.stringify(home)})throw Error('QA seed requires isolated home');
 const marker=${JSON.stringify(join(home,'qa-seeded'))};if(existsSync(marker))return;
 const names=['界面排版调整','API 接口联调','周报整理','数据库迁移验证','单元测试补充'];
 for(let i=0;i<26;i++){
  const id='archive-qa-'+String(i+1).padStart(2,'0');
  const h=await ctx.sessionPersistence.create({version:4,id,createdAt:Date.now()-i*3600000,delegationDepth:0,isSeeded:false,cwd:${JSON.stringify(resolve('.sandbox/project'))}});
  await h.append([{seq:0,time:Date.now(),type:'session/title',data:{title:i===25?'普通会话 · 不应被删除':names[i%names.length]+' '+(i+1),source:{kind:'user'},messageSeqs:[]}}]);await h.flush();await h.close();
  if(i<25)await ctx.workspaceRegistry.archiveSession(id);
 }
 writeFileSync(marker,'Synthetic QA sessions only');
}`);
await cp(seed,join(profile,'node_modules/archive-qa-seed'),{recursive:true});
await writeFile(join(profile,'package.json'),JSON.stringify({name:'archive-manager-qa',private:true,dependencies:{'dsh-archive-manager-local':'file:'+resolve('.'),'archive-qa-seed':'file:'+seed},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-archive-manager-local','archive-qa-seed']}}},null,2));
await writeFile(join(profile,'cordis.yml'),'[]\n');await writeFile(join(profile,'cordis.patch.yml'),'[]\n');
console.log('DSH_HOME='+home);
