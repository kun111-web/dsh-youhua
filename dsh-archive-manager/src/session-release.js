import { PurgeRefusal } from './purge.js';

export function installSessionRelease({ agents, sessions, activity, cache, getSubagents }) {
  const handles = new WeakMap();
  // Capture the host's exact disposer, preserving Cordis's caller-scoped `this`.
  const registry = agents[Symbol.for('cordis.original')] ?? agents;
  const methods = ['create', 'resume'].map(name => {
    const original = registry[name];
    if (typeof original !== 'function') throw new Error(`不兼容的 DSH agents.${name} 接口`);
    const descriptor = Object.getOwnPropertyDescriptor(registry, name);
    async function wrapped(...args) {
      const handle = await original.apply(this, args);
      if (!args[0]?.parentAgent && handle?.agent && typeof handle.dispose === 'function') {
        handles.set(handle.agent, handle);
      }
      return handle;
    }
    return { name, descriptor, wrapped };
  });
  for (const { name, wrapped } of methods) registry[name] = wrapped;

  async function idleTarget(id) {
    const session = sessions.get(id);
    if (!session) {
      if ((await activity(id)).length) throw new PurgeRefusal('会话仍有运行中的任务，请停止后重试');
      return;
    }
    const agent = agents.get(id);
    const handle = agent && handles.get(agent);
    const isChild = session.header.origin === 'subagent';
    const parent = isChild ? agents.get(session.header.parentSession) : undefined;
    const subagents = isChild ? getSubagents?.() : undefined;
    if (agent?.session !== session || (isChild ? !parent || typeof subagents?.drainChildren !== 'function' : !handle)) {
      throw new PurgeRefusal('宿主仍持有该会话，当前无法安全释放');
    }

    // DSH's Stop acknowledges cancellation before the turn flushes its final events.
    await waitForStop(agent);
    if (parent) await waitForStop(parent);

    async function requireIdle() {
      const active = await activity(id);
      if (sessions.get(id) !== session || agents.get(id) !== agent) {
        throw new PurgeRefusal('会话状态已变化，请重新准备删除');
      }
      if (active.length || agent.status !== 'idle' || agent.inbox?.hasPending) {
        throw new PurgeRefusal('会话仍有运行中的任务或排队输入，请等待后重试');
      }
      if (parent && (agents.get(parent.id) !== parent || parent.status !== 'idle' || parent.inbox?.hasPending)) {
        throw new PurgeRefusal('父会话仍在运行或排队，请停止后重试');
      }
    }

    await requireIdle();
    return { session, handle, parent, subagents, isChild, requireIdle };
  }

  return {
    dispose() {
      for (const { name, descriptor, wrapped } of methods) {
        if (registry[name] !== wrapped) continue;
        if (descriptor) Object.defineProperty(registry, name, descriptor);
        else delete registry[name];
      }
    },
    async check(id) {
      await idleTarget(id);
    },
    async release(id) {
      const target = await idleTarget(id);
      if (!target) return;
      const { session, handle, parent, subagents, isChild, requireIdle } = target;
      try {
        if (!await sessions.flush(session)) throw new Error('No session writer flushed');
      } catch {
        throw new PurgeRefusal('会话日志尚未保存，请重新准备删除');
      }
      await requireIdle();
      try {
        if (isChild) await subagents.drainChildren(parent, [id]);
        else await handle.dispose();
      } catch {
        throw new PurgeRefusal('释放会话失败，请重新准备删除');
      }
      if (sessions.get(id)) throw new PurgeRefusal('会话已重新加载，请重新准备删除');
      // Detach queues a cache checkpoint. Join that write before rechecking
      // the user's confirmed list.
      try {
        await cache.write(session);
      } catch {
        throw new PurgeRefusal('保存会话缓存失败，请重新准备删除');
      }
    },
  };
}

async function waitForStop(agent) {
  if (agent.phase?.kind !== 'running' || !agent.phase.abort.signal.aborted) return;
  let timer;
  try {
    await Promise.race([agent.whenIdle(), new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
  } finally {
    clearTimeout(timer);
  }
}
