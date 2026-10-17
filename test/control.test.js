import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { startBridge } from '../src/plugin.js';
import { BridgeClient } from '../src/client.js';
import { FakeAdapter } from './helpers.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-control-'));
  const root = join(directory, 'workspace'); await mkdir(root);
  const adapter = new FakeAdapter(); const store = new Store(join(directory, 'data')); await store.load();
  const controller = new Controller(store, adapter, [root]);
  t.after(() => controller.close());
  const session = await controller.createSession({ cwd: root });
  return { directory, root, adapter, store, controller, session };
}
test('deduplicates concurrent admission and preserves continuation context', async t => {
  const f = await fixture(t);
  const input = { sessionId: f.session.sessionId, requestId: randomUUID(), objective: 'Inspect files' };
  const [first, duplicate] = await Promise.all([f.controller.submit(input), f.controller.submit(input)]);
  assert.equal(first.taskId, duplicate.taskId); assert.equal(f.adapter.prompts, 1);
  await assert.rejects(f.controller.submit({ ...input, objective: 'Different task' }), /different task/);
  f.adapter.finish(f.session.sessionId);
  await f.controller.monitors.get(first.taskId);
  const result = await f.controller.getTask({ taskId: first.taskId });
  assert.equal(result.status, 'completed'); assert.equal(result.verified, false); assert.match(result.result, /fixture passed/);
  const next = await f.controller.continueTask({ taskId: first.taskId, requestId: randomUUID(), objective: 'Explain result' });
  assert.equal(next.sessionId, first.sessionId); assert.equal(next.parentTaskId, first.taskId);
  const delta = await f.controller.getTask({ taskId: next.taskId, afterSeq: result.cursor });
  assert.ok(delta.events.every(event => event.seq > result.cursor));
  f.adapter.finish(f.session.sessionId, 'Second answer'); await f.controller.monitors.get(next.taskId);
  assert.equal((await f.controller.getTask({ taskId: first.taskId })).result, 'Evidence: fixture passed.');
});
test('rejects arbitrary sessions, prototype keys, sibling paths and symlink escapes', async t => {
  const f = await fixture(t); const outside = join(f.directory, 'workspace-other'); await mkdir(outside);
  await assert.rejects(f.controller.createSession({ cwd: outside }), /outside/);
  assert.throws(() => f.controller.session('__proto__'), /bridge-created/);
  await assert.rejects(f.controller.submit({ sessionId: randomUUID(), requestId: randomUUID(), objective: 'No' }), /bridge-created/);
  const link = join(f.root, 'escape'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.controller.createSession({ cwd: link }), /outside/);
});
test('serializes mutation, waits for progress and cancels without claiming verification', async t => {
  const f = await fixture(t);
  const task = await f.controller.submit({ sessionId: f.session.sessionId, requestId: randomUUID(), objective: 'Wait' });
  await assert.rejects(f.controller.submit({ sessionId: f.session.sessionId, requestId: randomUUID(), objective: 'Race' }), /one active/);
  const waiting = f.controller.waitTask({ taskId: task.taskId, afterSeq: task.cursor, timeoutMs: 2000 });
  await f.controller.cancelTask({ taskId: task.taskId });
  await f.controller.monitors.get(task.taskId);
  const result = await waiting; assert.equal(result.status, 'cancelled'); assert.equal(result.verified, false);
});
test('failed model turns do not become successful tasks', async t => {
  const f = await fixture(t);
  const task = await f.controller.submit({ sessionId: f.session.sessionId, requestId: randomUUID(), objective: 'Fail' });
  f.adapter.finish(f.session.sessionId, 'Error', 'error'); await f.controller.monitors.get(task.taskId);
  assert.equal((await f.controller.getTask({ taskId: task.taskId })).status, 'failed');
});
test('restart reconciles a completed durable turn without sending input again', async t => {
  const f = await fixture(t);
  const task = await f.controller.submit({ sessionId: f.session.sessionId, requestId: randomUUID(), objective: 'Inspect' });
  f.adapter.finish(f.session.sessionId); await f.controller.monitors.get(task.taskId);
  await f.controller.patch(task.taskId, { status: 'running' });
  const reloaded = new Store(f.store.directory); await reloaded.load();
  f.adapter.live = () => undefined;
  const recovered = new Controller(reloaded, f.adapter, [f.root]);
  await recovered.recover(); assert.equal(recovered.task(task.taskId).status, 'completed'); assert.equal(f.adapter.prompts, 1);
});
test('corrupt ledger fails closed', async t => {
  const f = await fixture(t); await writeFile(f.store.file, 'broken');
  await assert.rejects(new Store(f.store.directory).load(), /repair/);
});
test('HTTP authentication, origin, schema, discovery rotation and lock ownership', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
  const config = { allowedRoots: [directory], dataDir: join(directory, 'data') };
  const bridge = await startBridge({}, config, new FakeAdapter());
  t.after(() => bridge.close());
  const connection = JSON.parse(await readFile(bridge.connectionFile, 'utf8'));
  const url = `${connection.url}/v1/get_capabilities`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` };
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{"extra":true}' })).status, 400);
  assert.equal((await fetch(`${connection.url}/v1/__proto__`, { method: 'POST', headers, body: '{}' })).status, 404);
  await assert.rejects(startBridge({}, config, new FakeAdapter()), /Another bridge/);
  const client = new BridgeClient(bridge.connectionFile);
  assert.equal((await client.call('get_capabilities')).sessionPolicy, 'bridge-created-only');
  const worker = await client.call('create_worker_session', { cwd: directory });
  assert.equal((await client.call('list_worker_sessions'))[0].sessionId, worker.sessionId);
  await bridge.close();
  const second = await startBridge({}, config, new FakeAdapter()); t.after(() => second.close());
  const rotated = JSON.parse(await readFile(second.connectionFile, 'utf8'));
  assert.notEqual(rotated.token, connection.token);
  assert.equal((await client.call('get_capabilities')).protocolVersion, 1);
});
