import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlError, requireValue } from './errors.js';

const ACTIVE = new Set(['submitting', 'running', 'cancelling']);
const now = () => new Date().toISOString();
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textContent = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

export class Controller {
  constructor(store, adapter, roots) {
    this.store = store; this.adapter = adapter; this.roots = roots;
    this.operations = Promise.resolve(); this.monitors = new Map(); this.refreshes = new Map(); this.closing = false;
  }
  exclusive(operation) {
    const result = this.operations.then(operation); this.operations = result.catch(() => {}); return result;
  }
  async workspace(path) {
    requireValue(typeof path === 'string' && isAbsolute(path), 'invalid-workspace', 'Use an absolute workspace path.');
    const canonical = await realpath(path);
    requireValue((await stat(canonical)).isDirectory(), 'invalid-workspace', 'Workspace must be a directory.');
    requireValue(this.roots.some(root => { const diff = relative(root, canonical); return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`)); }),
      'workspace-denied', 'Workspace is outside configured allowedRoots.', 403);
    return canonical;
  }
  task(id) {
    const tasks = this.store.snapshot().tasks;
    const task = Object.hasOwn(tasks, id) ? tasks[id] : undefined;
    requireValue(task, 'task-not-found', 'Unknown bridge task.', 404); return task;
  }
  session(id) {
    const sessions = this.store.snapshot().sessions;
    const session = Object.hasOwn(sessions, id) ? sessions[id] : undefined;
    requireValue(session, 'session-not-owned', 'Only bridge-created sessions may be controlled.', 403); return session;
  }
  capabilities() {
    return { name: 'dsh-codex-control', version: '0.1.0', protocolVersion: 1,
      sessionPolicy: 'bridge-created-only', allowedRoots: this.roots,
      operations: ['create_worker_session', 'submit_task', 'get_task', 'wait_task', 'continue_task', 'cancel_task', 'get_result', 'list_worker_sessions'],
      completion: 'agent-quiescence-and-durable-turn', acceptanceIsVerification: false };
  }
  listSessions() { return Object.values(this.store.snapshot().sessions); }
  createSession(input) {
    return this.exclusive(async () => {
      requireValue(!this.closing, 'bridge-closing', 'Bridge is shutting down.', 503);
      const cwd = await this.workspace(input.cwd);
      const title = `Codex: ${input.title || 'Worker'}`;
      const created = await this.adapter.create(cwd, title, input.agentPreset);
      const session = { ...created, cwd, title, createdAt: now() };
      await this.store.transaction(state => { state.sessions[session.sessionId] = session; return session; });
      return session;
    });
  }
  submit(input) { return this.exclusive(() => this.submitOwned(input)); }
  async submitOwned(input) {
    requireValue(!this.closing, 'bridge-closing', 'Bridge is shutting down.', 503);
    const session = this.session(input.sessionId);
    await this.workspace(session.cwd);
    const payload = { sessionId: input.sessionId, objective: input.objective, constraints: input.constraints ?? [], acceptance: input.acceptance ?? [], parentTaskId: input.parentTaskId ?? null };
    const hash = fingerprint(payload);
    const previous = Object.values(this.store.snapshot().tasks).find(task => task.requestId === input.requestId);
    if (previous) {
      requireValue(previous.fingerprint === hash, 'request-conflict', 'requestId already belongs to a different task.', 409);
      return this.publicTask(previous);
    }
    requireValue(!Object.values(this.store.snapshot().tasks).some(task => ACTIVE.has(task.status)),
      'execution-busy', 'Version 0.1 allows one active bridge task at a time.', 409);
    const baseline = await this.adapter.prepare(session.sessionId, session.cwd);
    const task = { taskId: randomUUID(), requestId: input.requestId, ...payload, fingerprint: hash,
      status: 'submitting', startSeq: baseline.nextSeq, createdAt: now(), updatedAt: now(), events: [], result: null, verified: false };
    await this.store.transaction(state => { state.tasks[task.taskId] = task; return task; });
    const prompt = [
      '[Codex managed task]', `Task: ${task.taskId}`, `Workspace: ${session.cwd}`,
      'Codex owns planning and final acceptance. Execute this bounded assignment and report evidence.',
      'Do not delegate the same assignment back to the coordinating Codex. Do not change the worker working directory.',
      'Report changed files, checks actually performed, results, and unresolved blockers. Completion is not acceptance.',
      '', 'Objective:', task.objective, '', 'Constraints:', ...task.constraints.map(item => `- ${item}`),
      '', 'Acceptance criteria:', ...task.acceptance.map(item => `- ${item}`),
    ].join('\n');
    try {
      await this.adapter.prompt(task.sessionId, task.requestId, prompt);
      await this.patch(task.taskId, { status: 'running' });
    } catch {
      // A lost acknowledgement is ambiguous: never automatically repeat a prompt.
      await this.patch(task.taskId, { error: 'Prompt admission uncertain. Observing without resending input.' });
      this.monitor(task.taskId);
      return this.getTask({ taskId: task.taskId });
    }
    this.monitor(task.taskId);
    return this.getTask({ taskId: task.taskId });
  }
  async patch(id, patch) {
    return this.store.transaction(state => Object.assign(state.tasks[id], patch, { updatedAt: now() }));
  }
  refresh(id) {
    const previous = this.refreshes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.refreshOwned(id));
    this.refreshes.set(id, next);
    next.finally(() => { if (this.refreshes.get(id) === next) this.refreshes.delete(id); }).catch(() => {});
    return next;
  }
  async refreshOwned(id) {
    const task = this.task(id);
    const inspection = await this.adapter.inspect(task.sessionId);
    const suffix = inspection.events.filter(event => event.seq >= task.startSeq);
    const admitted = suffix.some(event => event.type === 'user/message' && (event.data?.source?.rpcId === task.requestId || event.data?.message?.source?.rpcId === task.requestId));
    const summaries = suffix.filter(event => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)).map(event => ({
      seq: event.seq, type: event.type, time: event.time,
      ...(event.type === 'assistant/message' ? { text: textContent(event.data?.message).slice(0, 12000) } : {}),
      ...(event.type === 'turn/end' ? { reason: event.data?.reason } : {}),
    }));
    const answer = suffix.filter(event => event.type === 'assistant/message').map(event => textContent(event.data?.message)).filter(Boolean).at(-1) ?? '';
    const end = suffix.findLast(event => event.type === 'turn/end');
    await this.patch(id, { events: summaries.slice(-500), result: answer || null, admitted, stopReason: end?.data?.reason ?? null });
    return { admitted, end };
  }
  monitor(id) {
    if (this.monitors.has(id)) return;
    const task = this.task(id);
    const monitor = (async () => {
      try {
        await this.adapter.wait(task.sessionId);
        const { admitted, end } = await this.refresh(id);
        const current = this.task(id);
        if (!ACTIVE.has(current.status)) return;
        const reason = end?.data?.reason?.kind;
        const status = current.status === 'cancelling' ? 'cancelled'
          : admitted && reason === 'completed' ? 'completed'
          : admitted && reason ? 'failed' : 'interrupted';
        await this.patch(id, { status, endedAt: now() });
      } catch {
        await this.patch(id, { status: 'interrupted', error: 'Worker observation ended unexpectedly. Inspect before retrying.', endedAt: now() });
      }
    })().finally(() => this.monitors.delete(id));
    this.monitors.set(id, monitor);
  }
  publicTask(task, afterSeq = -1) {
    const { fingerprint: _hash, events, ...rest } = task;
    return { ...rest, events: events.filter(event => event.seq > afterSeq), cursor: events.at(-1)?.seq ?? afterSeq };
  }
  async getTask({ taskId, afterSeq = -1 }) {
    if (ACTIVE.has(this.task(taskId).status)) await this.refresh(taskId);
    return this.publicTask(this.task(taskId), afterSeq);
  }
  async waitTask({ taskId, afterSeq = -1, timeoutMs = 25000 }, signal) {
    const deadline = Date.now() + Math.min(timeoutMs, 30000);
    while (true) {
      signal?.throwIfAborted();
      const task = await this.getTask({ taskId, afterSeq });
      if (!ACTIVE.has(task.status) || task.events.length || Date.now() >= deadline) return task;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
  continueTask(input) {
    return this.exclusive(async () => {
      const previous = this.task(input.taskId);
      requireValue(!ACTIVE.has(previous.status), 'task-active', 'Wait for or cancel the previous task before continuing.', 409);
      return this.submitOwned({ ...input, sessionId: previous.sessionId, parentTaskId: previous.taskId });
    });
  }
  cancelTask({ taskId }) {
    return this.exclusive(async () => {
      const task = this.task(taskId);
      if (!ACTIVE.has(task.status)) return this.publicTask(task);
      await this.patch(taskId, { status: 'cancelling' });
      this.adapter.cancel(task.sessionId);
      this.monitor(taskId);
      return this.getTask({ taskId });
    });
  }
  async recover() {
    for (const task of Object.values(this.store.snapshot().tasks)) {
      if (!ACTIVE.has(task.status)) continue;
      try {
        await this.refresh(task.taskId);
        if (this.adapter.live(task.sessionId)) this.monitor(task.taskId);
        else {
          const current = this.task(task.taskId);
          const reason = current.stopReason?.kind;
          await this.patch(task.taskId, { status: current.admitted && reason === 'completed' ? 'completed' : 'interrupted',
            error: 'Recovered from ledger without resending input. Inspect the worker before continuing.' });
        }
      } catch { await this.patch(task.taskId, { status: 'interrupted', error: 'Cannot reconcile worker after restart; no input resent.' }); }
    }
  }
  async close() {
    this.closing = true; await this.operations;
    for (const task of Object.values(this.store.snapshot().tasks)) {
      if (ACTIVE.has(task.status)) {
        try { this.adapter.cancel(task.sessionId); } catch { /* Host may already be unloading. */ }
        await this.patch(task.taskId, { status: 'interrupted', error: 'Bridge unloaded; inspect worker before continuing.' });
      }
    }
    await this.store.queue;
  }
}
