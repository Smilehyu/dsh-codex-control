import { randomUUID } from 'node:crypto';

/** Deliberately asynchronous fake of the actual DSH controller/Agent seam. */
export class FakeAdapter {
  constructor() { this.workers = new Map(); this.prompts = 0; }
  async create(cwd) {
    const sessionId = randomUUID();
    this.workers.set(sessionId, { events: [], running: false, cwd });
    return { sessionId, workspaceId: randomUUID() };
  }
  async prepare(sessionId) {
    const worker = this.workers.get(sessionId);
    if (worker.running) throw new Error('busy');
    return { nextSeq: worker.events.length };
  }
  push(worker, type, data) { worker.events.push({ seq: worker.events.length, type, data, time: Date.now() }); }
  async prompt(sessionId, requestId, text) {
    this.prompts++;
    const worker = this.workers.get(sessionId);
    worker.running = true;
    worker.idle = new Promise(accept => { worker.resolve = accept; });
    this.push(worker, 'user/message', { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] });
    this.push(worker, 'turn/start', { turn: 1 });
  }
  finish(sessionId, answer = 'Evidence: fixture passed.', reason = 'completed') {
    const worker = this.workers.get(sessionId);
    this.push(worker, 'assistant/message', { message: { content: [{ type: 'text', text: answer }] } });
    this.push(worker, 'turn/end', { reason: { kind: reason } });
    worker.running = false; worker.resolve?.();
  }
  async inspect(sessionId) { return { meta: {}, events: structuredClone(this.workers.get(sessionId).events) }; }
  live(sessionId) { return this.workers.get(sessionId); }
  async wait(sessionId) { await this.workers.get(sessionId).idle; }
  cancel(sessionId) { this.finish(sessionId, '', 'cancelled'); }
}
