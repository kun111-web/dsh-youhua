import { randomUUID } from 'node:crypto';
import { PurgeRefusal } from './purge.js';
export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateIds(ids) {
  if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id.length || id.length > 256)) throw new RequestError('会话选择无效');
  return [...new Set(ids)];
}
export function createManager({registry, query, table, continuations, activity, notify, notifyRestored = async()=>{}, notifyRetained = async()=>{}, checkRelease, releaseSession, purger, now = Date.now}) {
  const batches = new Map();
  const restoring = new Set();
  const deleted = id => table.get(id) !== undefined;
  const started = record => record?.purgedAt !== undefined || record?.purgePending === true;
  const marker = id => JSON.stringify([table.get(id), continuations.get(id)]);
  const headers = async () => new Map((await query.listSessions()).map(r => [r.header.id, r.header]));
  const reason = (error, fallback) => error instanceof PurgeRefusal ? error.message : fallback;
  const clean = () => {
    for (const [key, batch] of batches) {
      if (batch.expires < now() && !batch.running) batches.delete(key);
    }
  };

  async function candidates(inventory) {
    const ids = new Set(registry.archivedSessionIds.filter(id => !deleted(id)));
    for (const [id] of continuations.entries()) ids.add(id);
    let scanError;
    for (const [id, record] of table.entries()) {
      if (record.purgedAt === undefined || record.purgePending) { ids.add(id); continue; }
      if (ids.has(id) || scanError) continue;
      // Completed deletions can have residual or reintroduced copies.
      try { inventory ??= await purger.snapshot?.(); }
      catch (error) {
        scanError = reason(error, '无法核对副本目录，请刷新后重试');
        continue;
      }
      try {
        const remaining = await purger.inspect(id, true, inventory, { allowLoaded: true });
        if (remaining.files?.length || remaining.children?.length) ids.add(id);
      } catch { ids.add(id); }
    }
    return { ids: [...ids], scanError, inventory, uncheckedFiles: inventory?.copies?.warnings ?? [] };
  }

  async function cleanupProgress(records, inventory) {
    const legacy = new Set();
    const marks = [...table.entries()].filter(([, record]) => started(record));
    const progress = new Set(marks.map(([id]) => id));
    for (const [id, continuation] of continuations.entries()) {
      if (continuation.firstId === undefined) legacy.add(id);
      else if (started(table.get(continuation.firstId))) progress.add(id);
    }
    if (!legacy.size || !marks.length) return progress;
    try { inventory ??= await purger.snapshot?.(); }
    catch { return new Set([...progress, ...legacy]); }
    const parents = new Map();
    function link(id, parent) {
      if (!parent) return;
      if (!parents.has(id)) parents.set(id, new Set());
      parents.get(id).add(parent);
    }
    for (const [, header] of records) {
      if (header.origin === 'subagent') link(header.id, header.parentSession);
    }
    for (const [id, record] of marks) link(id, record.parentSession);
    for (const [parent, children] of inventory?.copies?.descendants ?? []) {
      for (const { header } of children) if (header.origin === 'subagent') link(header.id, parent);
    }
    // Older continuations were written before any file operation. Look for
    // durable intent in descendants before deciding they block cancellation.
    for (const id of progress) for (const parent of parents.get(id) ?? []) progress.add(parent);
    return progress;
  }

  async function rows(ids, records, progress = new Set()) {
    const titles = await query.readTitleSnapshots(ids);
    return ids.map((id, i) => {
      const result = titles[i], header = records.get(id), record = table.get(id), continuation = continuations.get(id);
      const parentSession = record?.parentSession ?? (header?.origin === 'subagent' ? header.parentSession : undefined);
      const hasProgress = Boolean(continuation && progress.has(id));
      return {id, title:result?.status==='fulfilled'?result.value.title?.title||'未命名会话':continuation?.title??(parentSession?'子智能体会话':record?'待清理的旧会话':'无法读取标题'),
        workspace:header?.cwd||'未分组',createdAt:header?.createdAt??null,deletedAt:record?.deletedAt??null,
        parentSession, cleanupPending:!!record||hasProgress,
        canUnarchive:!hasProgress&&!parentSession&&!started(record),unavailable:!header};
    });
  }

  async function assertIdle(id) {
    if ((await activity(id)).length) throw new PurgeRefusal('会话仍有运行中的任务，请停止后重试：' + id);
  }
  function pendingChildren() {
    const byParent = new Map();
    for (const [id, record] of table.entries()) {
      const parent = record.parentSession;
      if (!record.purgePending || !parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(id);
    }
    for (const ids of byParent.values()) ids.sort();
    return byParent;
  }
  async function collect(id, parentId, seen, order, inventory, pendingByParent) {
    if (seen.has(id) || seen.size >= 10000) throw new PurgeRefusal('子智能体关系异常或数量过多');
    seen.add(id);
    const storedChildren = await purger.children?.(id, inventory) ?? [];
    const children = [...new Set([...storedChildren, ...(pendingByParent.get(id) ?? [])])];
    for (const childId of children) await collect(childId, id, seen, order, inventory, pendingByParent);
    order.push({id, parentId, children: children.sort()});
  }

  async function buildPlan(targets, scope, records, inventory, blocked = []) {
    const candidates = [];
    const archivedIds = new Set(registry.archivedSessionIds);
    const pendingByParent = pendingChildren();
    for (const id of targets) {
      try {
        const archived = archivedIds.has(id);
        if (restoring.has(id)) throw new PurgeRefusal('会话正在取消归档，请刷新列表');
        if (scope === 'archive' && !archived && !deleted(id) && !continuations.get(id)) {
          throw new PurgeRefusal('会话已取消归档，请刷新列表');
        }
        const order = [];
        await checkRelease?.(id);
        await collect(id, undefined, new Set(), order, inventory, pendingByParent);
        for (const entry of order) if (entry.id !== id) await checkRelease?.(entry.id);
        candidates.push({ id, archived, order });
      } catch (error) {
        blocked.push({ id, reason: reason(error, '无法核实会话或副本，请重试') });
      }
    }
    const ids = [...new Set([...candidates.flatMap(group => group.order.map(entry => entry.id)), ...blocked.map(row => row.id)])];
    const titles = new Map((await rows(ids, records)).map(row => [row.id, row]));
    if (inventory?.copies) inventory.copies.caches = undefined;
    const groups = [];
    for (const { id, archived, order } of candidates) {
      try {
        const witnesses = new Map(), items = [];
        for (const entry of order) {
          const log = await purger.inspect(entry.id, true, inventory, { allowLoaded: true });
          const pending = pendingByParent.get(entry.id) ?? [];
          const observed = [...new Set([...(log.children ?? []), ...pending])].sort();
          const parentId = log.parentSession ?? table.get(entry.id)?.parentSession;
          if (JSON.stringify(observed) !== JSON.stringify(entry.children) || (entry.parentId && parentId !== entry.parentId)) {
            throw new PurgeRefusal('子智能体关系已变化，请刷新后重试');
          }
          witnesses.set(entry.id, { log, marker: marker(entry.id), pending });
          const row = titles.get(entry.id);
          items.push({ ...row, parentSession: log.parentSession ?? row.parentSession, files: log.files ?? [] });
        }
        groups.push({ id, archived, ids: [...witnesses.keys()], witnesses, items });
      } catch (error) {
        blocked.push({ id, reason: reason(error, '无法核实会话或副本，请重试') });
      }
    }
    if (!groups.length) throw new RequestError(blocked[0]?.reason || '没有可以删除的会话', 409);
    const nested = new Set(groups.flatMap(group => group.ids.slice(0, -1)));
    const roots = groups.filter(group => !nested.has(group.id));
    const items = roots.flatMap(group => group.items);
    const witnesses = roots.flatMap(group => [...group.witnesses.values()]);
    const token = randomUUID(), expires = now() + 5 * 60 * 1000;
    batches.set(token, { groups: roots, scope, expires, progress: { phase: 'ready', total: items.length, processed: 0 } });
    return {token,expires,count:items.length,mode:'purge',
      blocked:blocked.map(row=>({...row,title:titles.get(row.id)?.title})),items,
      bytes:witnesses.reduce((sum,w)=>sum+w.log.bytes,0),
      uncheckedFiles:[...new Set(witnesses.flatMap(w=>w.log.warnings??[]))],
      backupRoots:inventory?.copies?.backupRoots ?? [],
      checkedRoots:[...new Set(witnesses.flatMap(w=>w.log.copyRoots??[]))]};
  }

  async function verifyGroup(group, inventory, allowLoaded, archivedIds, pendingByParent) {
    if (restoring.has(group.id) || group.archived !== archivedIds.has(group.id)) throw new PurgeRefusal('会话归档状态已改变');
    const parentId = group.witnesses.get(group.id).log.parentSession ?? table.get(group.id)?.parentSession;
    if (parentId) await assertIdle(parentId);
    for (const [id, witness] of group.witnesses) {
      if (marker(id) !== witness.marker) throw new PurgeRefusal('会话状态已改变，请重新确认');
      if (JSON.stringify(pendingByParent.get(id) ?? []) !== JSON.stringify(witness.pending)) {
        throw new PurgeRefusal('待清理的子智能体已变化，请重新确认');
      }
      await assertIdle(id);
      await purger.verify?.(witness.log, true, inventory, { allowLoaded });
    }
  }

  async function writeIntent(group, id, record) {
    const previous = continuations.get(group.id);
    const needsContinuation = !previous || (previous.firstId !== undefined && !started(table.get(previous.firstId)));
    if (needsContinuation) await continuations.put(group.id, { title: group.items.at(-1).title, firstId: id });
    try { await table.put(id, record); }
    catch (error) {
      if (needsContinuation) await continuations.delete(group.id).catch(() => {});
      throw error;
    }
  }

  async function finalize(removed, inventory, result) {
    if (!removed.length) return;
    let failures;
    try { failures = await purger.finishBatch(removed.map(row => row.id), inventory); }
    catch (error) { failures = new Map(removed.map(({ id }) => [id, error])); }
    const blockedParents = new Set();
    for (const { id, deletedAt, parentSession } of removed) {
      try {
        if (failures.has(id)) throw failures.get(id);
        if (blockedParents.has(id)) throw new PurgeRefusal('同一组子智能体尚未核对完成，请刷新后重试');
        await table.put(id, { deletedAt, purgedAt: now(), cleanupVersion: 2, parentSession });
        if (continuations.get(id)) await continuations.delete(id);
        result.deleted.push(id);
        try { notify(id); } catch {}
      } catch (error) {
        if (parentSession) blockedParents.add(parentSession);
        result.failed.push({ id, reason: reason(error, '清理结果尚未核对完成，请刷新后重试') });
      }
    }
  }

  async function execute(batch) {
    const result = { deleted: [], skipped: [], failed: [] };
    const progress = batch.progress;
    progress.phase = 'verifying';
    const skipped = (group, error) => {
      const text = reason(error, '无法复核会话文件，请重新确认');
      for (const id of group.ids) result.skipped.push({ id, reason: text });
      progress.processed += group.ids.length;
    };
    let inventory;
    try { inventory = await purger.snapshot?.(); }
    catch (error) {
      for (const group of batch.groups) skipped(group, error);
      return result;
    }

    const ready = [];
    const archivedIds = new Set(registry.archivedSessionIds);
    const pendingByParent = pendingChildren();
    const detached = new Set();
    for (const group of batch.groups) {
      try {
        await verifyGroup(group, inventory, true, archivedIds, pendingByParent);
        for (const id of group.ids) {
          await releaseSession?.(id, detached);
        }
        ready.push(group);
      } catch (error) { skipped(group, error); }
    }
    if (detached.size) {
      try { await notifyRetained(detached); } catch {}
      try { inventory = await purger.refresh(inventory); }
      catch (error) {
        for (const group of ready) skipped(group, error);
        return result;
      }
      let changed;
      try {
        for (const group of ready) await verifyGroup(group, inventory, false, archivedIds, pendingByParent);
      } catch (error) { changed = error; }
      if (changed) {
        try {
          const plan = await buildPlan(ready.map(group => group.id), batch.scope, await headers(), inventory, [...result.skipped]);
          result.confirmation = { ...plan, reviewRequired: true };
        } catch (error) {
          for (const group of ready) skipped(group, new PurgeRefusal(error.message));
        }
        return result;
      }
    }

    progress.phase = 'deleting';
    const removed = [];
    for (const group of ready) {
      let incomplete = false;
      for (const [id, witness] of group.witnesses) {
        if (incomplete) {
          result.skipped.push({ id, reason: '同一组子智能体尚未清理完成，请刷新后重试' });
          progress.processed++;
          continue;
        }
        try {
          await assertIdle(id);
          const record = table.get(id), deletedAt = record?.deletedAt ?? now();
          const parentSession = witness.log.parentSession ?? record?.parentSession;
          await purger.purge(witness.log, {
            beforeDelete: () => writeIntent(group, id, { ...record, deletedAt, purgePending: true, parentSession }),
          }, inventory);
          removed.push({ id, deletedAt, parentSession });
        } catch (error) {
          incomplete = true;
          result.failed.push({ id, reason: reason(error, '清理未完成；已有用量保留，请刷新后重试') });
        } finally { progress.processed++; }
      }
    }
    progress.phase = 'finalizing';
    await finalize(removed, inventory, result);
    return result;
  }

  return {
    deleted,
    async list({subagents = false} = {}) {
      const records = await headers();
      const listed = subagents
        ? {ids: [...records.values()].filter(h => h.origin === 'subagent' && table.get(h.id)?.purgedAt === undefined).map(h => h.id)}
        : await candidates();
      const progress = await cleanupProgress(records, listed.inventory);
      const backupRoots = listed.inventory?.copies?.backupRoots ?? await purger.backupStatus?.();
      return {items:await rows(listed.ids, records, progress), generatedAt:now(), scanError:listed.scanError, uncheckedFiles:listed.uncheckedFiles, backupRoots};
    },
    async prepare({all=false,ids=[],mode='purge',scope='archive'}) {
      if(mode!=='purge')throw new RequestError('删除流程已更新，请重新打开归档管理后操作',409);
      const selected = validateIds(ids);
      if(typeof all!=='boolean'||!['archive','direct','subagent'].includes(scope)||
        (scope!=='archive'&&all)||(scope==='direct'&&selected.length!==1))throw new RequestError('选择范围无效');
      return registry.enqueueOperation(async () => {
        clean();
        if (batches.size >= 100) throw new RequestError('待确认批次过多，请稍后重试',429);
        const records = await headers();
        let inventory;
        try { inventory = await purger.snapshot?.(); }
        catch (error) { throw new RequestError(reason(error, '无法核对会话或副本目录，请重试'), 409); }
        const eligible = scope === 'archive' ? new Set((await candidates(inventory)).ids) : null;
        const targets = all ? [...eligible] : selected.filter(id => scope === 'archive' ? eligible.has(id)
          : scope === 'subagent' ? records.get(id)?.origin === 'subagent' : records.has(id) || deleted(id) || continuations.get(id));
        return buildPlan(targets, scope, records, inventory);
      });
    },
    progress(token) {
      clean();
      const batch = batches.get(token);
      if (!batch) throw new RequestError('确认已过期，请重新选择', 409);
      return { ...batch.progress };
    },
    async commit(token,confirmed) {
      clean();
      const batch = batches.get(token);
      if (!batch) throw new RequestError('确认已过期，请重新选择', 409);
      if (confirmed !== true) throw new RequestError('请在确认框点击确认删除');
      if (batch.result) return batch.result;
      if (batch.running) return batch.running;
      batch.progress.phase = 'queued';
      batch.progress.processed = 0;
      batch.running = registry.enqueueOperation(() => execute(batch));
      try {
        batch.result = await batch.running;
        batch.progress.phase = batch.result.confirmation ? 'review' : 'done';
        return batch.result;
      } catch (error) {
        batch.progress.phase = 'failed';
        throw error;
      } finally { batch.running = null; }
    },
    async restore(ids) {
      const result = { restored: [], failed: [] };
      for (const id of validateIds(ids)) {
        let claimed = false;
        try {
          await registry.enqueueOperation(async () => {
            const record = table.get(id);
            const continuation = continuations.get(id);
            if (restoring.has(id)) throw new RequestError('会话正在取消归档');
            if (started(record) || (continuation && (await cleanupProgress(await headers())).has(id))) {
              throw new RequestError('清理中的会话不能恢复');
            }
            restoring.add(id);
            claimed = true;
          });
          await registry.unarchiveSession(id);
          await registry.enqueueOperation(async () => {
            if (continuations.get(id)) await continuations.delete(id);
            if (table.get(id)) await table.delete(id);
          });
          result.restored.push(id);
          try { await notifyRestored(id); } catch {}
        } catch (error) {
          result.failed.push({ id, reason: error instanceof RequestError ? error.message : '无法取消归档，请刷新后重试' });
        } finally {
          if (claimed) restoring.delete(id);
        }
      }
      return result;
    },
  };
}

export function installVisibility(listState, isDeleted) {
  if(typeof listState?.list !== 'function' || typeof listState?.search !== 'function') throw new Error('不兼容的 DSH 会话列表接口');
  const originalList=listState.list, originalSearch=listState.search;
  async function list(...args) { return (await originalList.apply(this,args)).filter(row=>!isDeleted(row.sessionId)); }
  async function search(...args) { const result=await originalSearch.apply(this,args); return {...result,items:result.items.filter(row=>!isDeleted(row.sessionId))}; }
  listState.list=list;listState.search=search;
  return ()=> {if(listState.list===list)listState.list=originalList;if(listState.search===search)listState.search=originalSearch;};
}
