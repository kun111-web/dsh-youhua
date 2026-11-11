import { AsyncLocalStorage } from 'node:async_hooks';
import { pluginNames } from './update-on-exit.mjs';

const key = Symbol.for('dsh-local.plugin-update-admission.v1');
const installed = globalThis[key] ??= new WeakMap();

export function hasActiveWork(ctx) {
  const agents = ctx.get('agents');
  const jobs = ctx.get('jobs');
  if (typeof agents?.list !== 'function' || typeof jobs?.list !== 'function') return true;
  const roster = agents.list();
  if (roster.some(agent => agent.status !== 'idle' || agent.phase?.kind === 'maintenance' || agent.inbox?.hasPending)) return true;
  const running = job => job.status === 'running' || job.status === 'stopping';
  if ([undefined, ...roster.map(agent => agent.id)].some(id => jobs.list(id).some(running))) return true;
  const schedule = ctx.get('schedule')?.runtime;
  return Boolean(schedule?.running || schedule?.executing?.size);
}

function installHooks(manager) {
  const update = manager.updateBundle;
  const change = manager.change;
  const descriptors = ['updateBundle', 'change'].map(name => Object.getOwnPropertyDescriptor(manager, name));
  const calls = new AsyncLocalStorage();
  const registrations = new Set();
  let active = 0;

  function disposeUnused() {
    if (registrations.size || active) return;
    installed.delete(manager);
    for (const [index, [name, fn]] of [['updateBundle', guardedUpdate], ['change', guardedChange]].entries()) {
      if (manager[name] !== fn) continue;
      if (descriptors[index]) Object.defineProperty(manager, name, descriptors[index]);
      else delete manager[name];
    }
  }

  async function guardedUpdate(name, ...args) {
    if (!registrations.size || !pluginNames.includes(name)) return update.call(this, name, ...args);
    const record = [...registrations].find(entry => entry.name === name) ?? registrations.values().next().value;
    const operation = { name, record, admitted: false };
    active++;
    try {
      return await calls.run(operation, () => update.call(this, name, ...args));
    } finally {
      operation.release?.();
      active--;
      disposeUnused();
    }
  }

  function guardedChange(operation, request, ...args) {
    const update = calls.getStore();
    if (!update || update.admitted || !['install', 'remove'].includes(request.stage)) {
      return change.call(this, operation, request, ...args);
    }
    // The native manager calls this callback with its profile write lock
    // held, after the network preflight and before its first mutation.
    return change.call(this, result => {
      const { record, name } = update;
      let blocked = '有任务正在执行或状态尚未确认，更新已暂缓。';
      try {
        if (!hasActiveWork(record.ctx)) {
          update.release = record.name === name ? record.claimUpdate?.() : undefined;
          blocked = update.release === null ? '归档管理正在处理会话，更新已暂缓。' : undefined;
        }
      } catch { /* Unknown activity is treated as busy. */ }
      if (blocked) {
        result.error = { code: 'operation-error', diagnostic: blocked };
        return 'failed';
      }
      // Keep the admitted native transaction intact if it needs to restore
      // the previous package after a failed hot replacement.
      update.admitted = true;
      return operation(result);
    }, request, ...args);
  }

  manager.updateBundle = guardedUpdate;
  manager.change = guardedChange;
  return { registrations, disposeUnused };
}

export function registerUpdateAdmission(service, name, ctx, claimUpdate) {
  const manager = service[Symbol.for('cordis.original')] ?? service;
  if (typeof manager.updateBundle !== 'function' || typeof manager.change !== 'function') return;
  let state = installed.get(manager);
  if (!state) {
    state = installHooks(manager);
    installed.set(manager, state);
  }
  const entry = { name, ctx, claimUpdate };
  state.registrations.add(entry);
  return () => { state.registrations.delete(entry); state.disposeUnused(); };
}
