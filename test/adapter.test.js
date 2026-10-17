import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapter.js';

test('DSH adapter waits for children and the parent summary before flushing', async () => {
  let idleCalls = 0; let childCalls = 0; let flushed = false;
  const agent = { status: 'idle', session: { seq: 1 }, whenIdle: async () => { idleCalls++; } };
  const ctx = {
    sessionController: Object.fromEntries(['create', 'rename', 'prompt', 'inspect', 'resolveAgent'].map(key => [key, () => {}])),
    agents: { get: () => agent }, sessions: { flush: async () => { flushed = true; } },
    get: () => ({ waitForChildren: async () => { childCalls++; if (childCalls === 1) { agent.session.seq++; return true; } return false; } }),
  };
  await new DshAdapter(ctx).wait('owned');
  assert.equal(idleCalls, 2); assert.equal(childCalls, 2); assert.equal(flushed, true);
});
