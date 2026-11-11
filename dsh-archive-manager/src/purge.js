import {lstat,realpath,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';

export class PurgeRefusal extends Error {}
const refuse=message=>{throw new PurgeRefusal(message);};
const key=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');

// Only a single current-generation session log is removed. Never recurse or
// infer ownership of a project directory, attachments, or unknown sidecars.
export async function inspectLog(root, file, readDirectory) {
  const base=path.resolve(root),target=path.resolve(file),relative=path.relative(base,target);
  const parts=relative.split(path.sep);
  if(path.isAbsolute(relative)||parts.length!==3||parts.some(p=>!p||p==='.'||p==='..'))refuse('会话日志不在预期的存储目录中');
  if(!/^session\.v4\.jsonl(?:\.zstd)?$/.test(parts[2]))refuse('仅支持当前 v4 会话日志；请先由 DSH 完成迁移');
  const directory=path.dirname(target);
  let current=base, directoryStat;
  for(const segment of ['',...parts]){
    if(segment)current=path.join(current,segment);
    const st=await lstat(current,{bigint:true});
    if(st.isSymbolicLink())refuse('会话路径包含链接，无法安全清除');
    if(current!==target&&!st.isDirectory())refuse('会话路径无效');
    if(current===target&&(!st.isFile()||st.nlink!==1n))refuse('日志不是独立的普通文件');
    if(current===directory)directoryStat=st;
  }
  if(path.resolve(await realpath(target)).toLowerCase()!==target.toLowerCase())refuse('会话日志路径发生重定向');
  const names=readDirectory
    ? (await readDirectory(directory,directoryStat)).map(entry=>entry.name)
    : await readdir(directory);
  if(names.some(n=>n!==parts[2]&&n!=='session.lock'))refuse('会话目录含历史版本或其他文件，未执行清除');
  const st=await lstat(target,{bigint:true});
  return {path:target,fingerprint:key(st),bytes:Number(st.size)};
}

export function createPurger({persistence,sessions,preserveUsage,copies,verifySearch}) {
  function compatible(){
    if(persistence.name!=='session-persistence-jsonl'||typeof persistence.root!=='string'||typeof persistence.acquireLease!=='function'||typeof persistence.tracker?.claimWrite!=='function'||typeof persistence.tracker?.releaseClaim!=='function')refuse('当前存储后端不支持彻底删除');
  }
  async function inspect(id, allowLoaded, inventory){
    compatible();
    const loaded = Boolean(sessions.get(id));
    if(loaded && !allowLoaded)refuse('会话仍被 DSH 加载，请重新准备删除');
    const snap=await persistence.stat(id);
    if(!snap)return {id,missing:true,bytes:0};
    if(snap.header.id!==id||snap.header.version!==4||snap.formatStatus==='migration-required')refuse('会话记录格式不支持安全清除');
    if(!snap.location && loaded && allowLoaded) return {id,header:snap.header,revision:snap.revision,missing:true,bytes:0};
    if(snap.location?.kind!=='jsonl')refuse('会话记录格式不支持安全清除');
    if(path.resolve(persistence.locate(snap.header).path)!==path.resolve(snap.location.path))refuse('会话日志位置不匹配');
    return {id,header:snap.header,revision:snap.revision,...await inspectLog(persistence.root,snap.location.path,inventory?.copies?.readDirectory)};
  }
  function parentIndex(headers) {
    const parents = new Map();
    for (const header of headers) {
      if (!header.parentSession) continue;
      if (!parents.has(header.parentSession)) parents.set(header.parentSession, []);
      parents.get(header.parentSession).push(header);
    }
    return parents;
  }
  async function snapshot(previous, copySnapshot) {
    compatible();
    const [stored, inventory] = await Promise.all([persistence.list(), copySnapshot ?? copies?.scan?.(previous?.copies)]);
    const historical = stored.filter(({ location }) => location && !/[/\\]session\.v4\.jsonl(?:\.zstd)?$/.test(location.path))
      .map(({ header }) => header);
    return { parents: parentIndex(stored.map(({ header }) => header)), historical, copies: inventory };
  }
  async function refresh(inventory) {
    if (!inventory) return snapshot();
    const next = await copies?.scan?.(inventory.copies);
    if (!next?.primaryHeaders || next.legacyStamp !== inventory.copies?.legacyStamp ||
        typeof persistence.tracker.pendingEntries !== 'function') {
      return Object.assign(inventory, await snapshot(inventory, next));
    }
    // Current logs and new copies are discovered from disk. Pending sessions
    // are the only current relationships that may lack a physical log.
    const pending = [...persistence.tracker.pendingEntries()].map(([, record]) => record.header);
    inventory.parents = parentIndex([...next.primaryHeaders, ...pending, ...inventory.historical]);
    inventory.copies = next;
    return inventory;
  }
  function findChildren(id, withChildren, parents) {
    const children = new Set();
    for (const header of parents.get(id) ?? []) {
      if (!withChildren || header.origin !== 'subagent') refuse('存在派生会话，请先处理：' + (header.id ?? id));
      children.add(header.id);
    }
    return children;
  }
  async function inspectAll(id, withChildren = false, inventory, { allowLoaded = false } = {}) {
    const primary = await inspect(id, allowLoaded, inventory);
    inventory ??= await snapshot();
    const children = findChildren(id, withChildren, inventory.parents);
    const extra = copies ? await copies.inspect(id, {primaryLog:primary.path, withChildren, snapshot:inventory.copies}) : { roots: [], files: [] };
    const lineage = [primary.header, ...extra.files.filter(file => file.kind === 'copy')].filter(Boolean);
    const child = lineage.find(entry => entry.origin === 'subagent');
    if (child && (!child.parentSession || lineage.some(entry => entry.origin !== 'subagent' || entry.parentSession !== child.parentSession))) {
      refuse('会话日志和副本的子智能体身份不一致');
    }
    return { ...primary, parentSession:child?.parentSession,
      children:[...new Set([...children, ...(extra.children ?? [])])].sort(), copyRoots: extra.roots, warnings: extra.warnings ?? [], extraFiles: extra.files,
      files: [...(primary.missing ? [] : [{ path: primary.path, bytes: primary.bytes, fingerprint: primary.fingerprint, kind: 'log' }]), ...extra.files],
      bytes: primary.bytes + extra.files.reduce((sum, file) => sum + file.bytes, 0) };
  }
  const signature = value => JSON.stringify([value.missing, value.revision, value.path, value.fingerprint, value.parentSession, value.copyRoots, value.files, value.warnings]);
  async function finishBatch(ids, inventory) {
    await verifySearch?.();
    const final = await snapshot(inventory);
    const failures = new Map();
    for (const id of ids) {
      try {
        const remaining = await inspectAll(id, false, final);
        if (!remaining.missing || remaining.files.length) refuse('仍发现会话文件，清理未完成，请重新确认');
      } catch (error) {
        failures.set(id, error);
      }
    }
    return failures;
  }
  return {
    snapshot,
    refresh,
    backupStatus: copies?.backupStatus,
    finishBatch,
    inspect: inspectAll,
    async children(id, inventory) {
      inventory ??= await snapshot();
      const children = findChildren(id, true, inventory.parents);
      const extra = await copies?.inspect(id, {withChildren:true, relationsOnly:true, snapshot:inventory.copies});
      return [...new Set([...children, ...(extra?.children ?? [])])].sort();
    },
    async verify(expected, withChildren, inventory, options) {
      const current = await inspectAll(expected.id, withChildren, inventory, options);
      if (signature(current) !== signature(expected) || (withChildren && JSON.stringify(current.children) !== JSON.stringify(expected.children))) {
        refuse('会话、副本或子智能体列表已变化，请重新确认');
      }
      return current;
    },
    async purge(expected,{beforeDelete,afterDelete},inventory){
      compatible();const {id}=expected;
      if(sessions.get(id))refuse('会话已重新加载，请重新准备删除');
      persistence.tracker.claimWrite(id);
      const leases=[];
      try{
        const fresh=await inspectAll(id, true, inventory);
        if(signature(expected)!==signature(fresh))refuse('会话或副本已变化，请重新确认');
        if(!fresh.missing){
          leases.push(await persistence.acquireLease(id,undefined,path.dirname(fresh.path)));
        }
        for(const file of fresh.extraFiles.filter(file=>file.kind==='copy')) leases.push(await persistence.acquireLease(id,undefined,path.dirname(file.path)));
        inventory=await refresh(inventory);
        const locked=await inspectAll(id, false, inventory);
        if(signature(locked)!==signature(fresh))refuse('会话或副本已变化，请重新确认');
        const readDirectory=inventory.copies?.readDirectory;
        if(!fresh.missing || fresh.extraFiles.some(file=>file.kind==='copy')) {
          if(typeof preserveUsage!=='function')refuse('用量保存服务未就绪，未清除会话日志');
          try { await preserveUsage(fresh, readDirectory); }
          catch (error) {
            if (error instanceof PurgeRefusal) throw error;
            refuse('保存或核对会话用量失败，日志与副本已保留，请重试');
          }
        }
        // Durable intent lets an interrupted purge be retried after restart.
        await beforeDelete();
        // Copies first; the source remains available if a copy cannot be removed.
        for(const file of fresh.extraFiles) await copies.remove(file,id,readDirectory);
        if(!fresh.missing){
          const last=await inspectLog(persistence.root,fresh.path,readDirectory);
          if(last.fingerprint!==fresh.fingerprint)refuse('会话日志已变化，请重新确认');
          await unlink(fresh.path);
          persistence.coldLogMemo?.delete(id);
        }
        if (afterDelete) {
          const failures = await finishBatch([id], inventory);
          if (failures.has(id)) throw failures.get(id);
          await afterDelete();
        }
        return {bytes:fresh.bytes};
      }finally{
        try{await Promise.all(leases.reverse().map(lease=>lease.release()));}finally{persistence.tracker.releaseClaim(id);}
      }
    }
  };
}
