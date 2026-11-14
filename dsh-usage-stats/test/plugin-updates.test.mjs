import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasActiveWork, registerUpdateAdmission } from '../src/plugin-update-admission.js';

const name = 'dsh-usage-stats-local';

test('native DSH update rechecks activity at its first mutation, after its network lookup', async () => {
  const lookup = Promise.withResolvers();
  const agent = { id: 'session', status: 'idle', inbox: { hasPending: false } };
  let mutated = 0;
  const ctx = { get(key) {
    if (key === 'agents') return { list: () => [agent] };
    if (key === 'jobs') return { list: () => [] };
  } };
  const manager = {
    async updateBundle() {
      await lookup.promise;
      return this.change(() => { mutated++; return 'applied'; }, { stage: 'remove' });
    },
    async change(operation) {
      const result = {};
      const application = await operation(result);
      return { ...result, application };
    }
  };
  const native = manager.updateBundle;
  const dispose = registerUpdateAdmission(manager, name, ctx);
  const attempt = manager.updateBundle(name);
  agent.status = 'running';
  lookup.resolve();
  assert.match((await attempt).error.diagnostic, /任务正在执行/);
  assert.equal(mutated, 0);
  agent.status = 'idle';
  assert.equal((await manager.updateBundle(name)).application, 'applied');
  assert.equal(mutated, 1);
  dispose();
  assert.equal(manager.updateBundle, native);
});

test('task protection includes queued input, jobs without an owner, and executing schedules', () => {
  const agent = { id: 'test', status: 'idle', inbox: { hasPending: false } };
  const jobs = [];
  const schedule = { runtime: { executing: new Set() } };
  const services = { agents: { list: () => [agent] }, jobs: { list: id => id ? [] : jobs }, schedule };
  const ctx = { get: key => services[key] };
  assert.equal(hasActiveWork(ctx), false);
  agent.inbox.hasPending = true;
  assert.equal(hasActiveWork(ctx), true);
  agent.inbox.hasPending = false;
  jobs.push({ status: 'stopping' });
  assert.equal(hasActiveWork(ctx), true);
  jobs.length = 0;
  schedule.runtime.executing.add('job');
  assert.equal(hasActiveWork(ctx), true);
  assert.equal(hasActiveWork({ get() {} }), true);
});
