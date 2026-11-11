import { z } from 'zod';
import { createManager, installVisibility, RequestError } from './manager.js';
import {createPurger, PurgeRefusal} from './purge.js';
import { acquireLedger, preserveSessionUsage, UsageConflict } from '../../dsh-usage-stats/src/ledger.js';
import { createCopyCleaner, installCheckpointPolicy, readCopyUsage } from './copies.js';
import { installSessionRelease } from './session-release.js';
import { access } from 'node:fs/promises';
import { registerPluginUpdates } from '../../dsh-usage-stats/src/plugin-updates.js';
import manifest from '../package.json' with { type: 'json' };
export const name='dsh-archive-manager-local';
export const inject=['webServer','workspaceRegistry','sessionQuery','storageDomain','sessionController','sessionPersistence','sessions','sessionProjectionCache','agents'];
export const API='/api/dsh-archive-manager-local';
export function authorize(req) {
  if(!['GET','POST'].includes(req.method)) return 405;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))return 403;
  let origin;try{origin=new URL('http://'+req.headers.host);}catch{return 403;}
  if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return 403;
  if(req.headers['x-dsh-archive-manager']!=='1')return 403;
  if(req.headers.origin && req.headers.origin!==origin.origin)return 403;
  if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return 403;
  if(req.method==='POST' && req.headers['content-type']?.split(';')[0]!=='application/json')return 415;
  return 200;
}
export async function readBody(req) {
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>1024*1024)throw new RequestError('请求过大',413);parts.push(part);}
  try{const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new RequestError('请求格式无效');}
}
async function reconcileSearch(query) {
  const config = query.config;
  if (!config?.path) return;
  if (!query._ready) {
    if (config.path === ':memory:') return;
    try { await access(config.path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
  // Native search reconciles its derived index with the current corpus before matching.
  try { await query.searchSessions({query:'archivecleanup',limit:1}); }
  catch { throw new PurgeRefusal('会话文件已清理，搜索索引尚未更新，请刷新后重试'); }
}
export async function apply(ctx,config={}) {
  const usage = await acquireLedger(ctx.storageDomain);
  ctx.effect(()=>()=>usage.release(),'archive-manager usage ledger');
  if(typeof ctx.workspaceRegistry.enqueueOperation!=='function')throw new Error('归档管理仅支持 DSH 0.2.2-rc.1');
  const domain=await ctx.storageDomain.open({name:'archive_manager_local',version:1,layout:'single',tables:{
    deleted:{valueSchema:z.object({deletedAt:z.number().finite().nonnegative(),purgedAt:z.number().finite().nonnegative().optional(),purgePending:z.boolean().optional(),cleanupVersion:z.number().optional(),parentSession:z.string().optional()})},
    continuations:{valueSchema:z.object({title:z.string(),firstId:z.string().optional()})},
  }});
  ctx.effect(()=>()=>domain.close(),'archive-manager domain');
  const copies=createCopyCleaner({primaryRoot:ctx.sessionPersistence.root,
    scanRoots:config.backupScanRoots??[],
    clearPrimaryCache:id=>ctx.storageDomain.get('session_projcache').table('sessions').delete(id)});
  const activity = id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
  const release = installSessionRelease({ agents: ctx.agents, sessions: ctx.sessions, activity,
    cache: ctx.sessionProjectionCache, getSubagents: () => ctx.get('subagents') });
  ctx.effect(() => release.dispose, 'archive-manager session release');
  async function publishStoredSessions(ids) {
    for (const row of await ctx.sessionController.listState.list()) {
      if (ids.has(row.sessionId)) ctx.emit('api-session/added', row);
    }
  }
  async function releaseForPurge(id, detached) {
    const wasLoaded = Boolean(ctx.sessions.get(id));
    try { await release.release(id); }
    finally {
      // Keep detached sessions visible until a deletion intent hides the row.
      if (wasLoaded && !ctx.sessions.get(id)) detached.add(id);
    }
  }
  const manager=createManager({registry:ctx.workspaceRegistry,query:ctx.sessionQuery,table:domain.table('deleted'),continuations:domain.table('continuations'),
    purger:createPurger({persistence:ctx.sessionPersistence,sessions:ctx.sessions,
      copies,verifySearch:()=>reconcileSearch(ctx.sessionQuery),async preserveUsage(snapshot, readDirectory) {
        try {
          await preserveSessionUsage(usage.ledger, ctx.sessionPersistence, snapshot, async function* (timeZone) {
            for (const file of snapshot.extraFiles) {
              if (file.kind === 'copy') yield await readCopyUsage(file, snapshot.id, ctx.sessionPersistence, timeZone, readDirectory);
            }
          });
        } catch (error) {
          if (error instanceof UsageConflict) throw new PurgeRefusal(error.message);
          throw error;
        }
      }}),
    activity, checkRelease: id => release.check(id), releaseSession: releaseForPurge,
    notify:id=>ctx.emit('api-session/removed',id),
    notifyRetained:publishStoredSessions,
    notifyRestored:id=>publishStoredSessions(new Set([id]))});
  ctx.effect(()=>installVisibility(ctx.sessionController.listState,manager.deleted),'archive-manager list visibility');
  ctx.effect(()=>installCheckpointPolicy(ctx.sessionProjectionCache,manager.deleted),'archive-manager checkpoint cleanup');
  let archiveWrites = 0;
  let updating = false;
  registerPluginUpdates(ctx, { name, version: manifest.version, claimUpdate() {
    if (archiveWrites || updating) return null;
    updating = true;
    return () => { updating = false; };
  } });
  async function writeArchive(operation) {
    if (updating) throw new RequestError('插件正在更新，请稍后重试', 409);
    archiveWrites++;
    try { return await operation(); }
    finally { archiveWrites--; }
  }
  for(const action of ['list','prepare','commit','progress','restore'])ctx.effect(()=>ctx.webServer.register({kind:'exact',path:`${API}/${action}`,handler:async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    try{
      const status=authorize(req);if(status!==200)return send(status,{error:'请求不被允许'});
      const read = action==='list' || action==='progress';
      if(req.method!==(read?'GET':'POST'))return send(405,{error:'请求方法不被允许'});
      const body=read?{}:await readBody(req);
      let result;
      if(action==='list')result=await manager.list({subagents:new URL(req.url,'http://localhost').searchParams.get('subagents')==='1'});
      else if(action==='progress')result=manager.progress(new URL(req.url,'http://localhost').searchParams.get('token'));
      else if(action==='prepare')result=await manager.prepare(body);
      else if(action==='commit'){if(typeof body.token!=='string')throw new RequestError('缺少确认凭据');result=await writeArchive(()=>manager.commit(body.token,body.confirmed));}
      else {if(typeof body.fromDeleted!=='boolean')throw new RequestError('恢复范围无效');result=await writeArchive(()=>manager.restore(body.ids,body.fromDeleted));}
      send(200,result);
    }catch(error){send(error.status??500,{error:error instanceof RequestError?error.message:'读取或保存归档失败，请重试。'});}
  }}),'archive-manager '+action);
}
