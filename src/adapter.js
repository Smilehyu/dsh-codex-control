import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireValue } from './errors.js';

/** DSH 0.2.1-rc.2 seam. All Host-specific calls stay in this adapter. */
export class DshAdapter {
  constructor(ctx) {
    this.ctx = ctx;
    for (const name of ['create', 'rename', 'prompt', 'inspect', 'resolveAgent']) {
      requireValue(typeof ctx.sessionController?.[name] === 'function', 'unsupported-host', `Missing sessionController.${name}`, 503);
    }
  }
  async create(cwd, title, agentPreset) {
    const registry = this.ctx.workspaceRegistry;
    let workspace;
    for (const candidate of registry.list()) {
      if (await realpath(candidate.path).catch(() => '') === cwd) { workspace = candidate; break; }
    }
    workspace ??= await registry.create(cwd, 'Codex execution');
    const result = await this.ctx.sessionController.create({ workspaceId: workspace.id, ...(agentPreset ? { agentPreset } : {}) });
    await this.ctx.sessionController.rename({ sessionId: result.sessionId, title });
    return { sessionId: result.sessionId, workspaceId: workspace.id };
  }
  async prepare(sessionId, cwd) {
    const found = await this.ctx.sessionController.resolveAgent(sessionId);
    if (found.error) throw found.error;
    const agent = found.agent;
    const inspection = await this.ctx.sessionController.inspect(sessionId);
    // The controller owns resume and preset policy. The bridge additionally verifies
    // that manual directory changes did not move this worker outside its grant.
    const recorded = inspection.meta?.cwd;
    requireValue(typeof recorded === 'string' && await realpath(resolve(recorded)) === cwd, 'workspace-changed', 'Worker directory changed; create a new worker.', 409);
    const fs = agent.ctx?.get('fs');
    if (fs) requireValue(await realpath(fs.processPath(await fs.resolve('.'))) === cwd,
      'workspace-changed', 'Worker current directory changed; create a new worker.', 409);
    requireValue(agent.status !== 'running', 'worker-busy', 'Worker is already running.', 409);
    return { nextSeq: Math.max(-1, ...inspection.events.map(event => event.seq)) + 1 };
  }
  prompt(sessionId, requestId, text) {
    return this.ctx.sessionController.prompt({ sessionId, requestId, mode: 'followup', content: [{ type: 'text', text }] }, new AbortController().signal);
  }
  inspect(sessionId) { return this.ctx.sessionController.inspect(sessionId); }
  live(sessionId) { return this.ctx.agents.get(sessionId); }
  async wait(sessionId) {
    const agent = this.live(sessionId);
    requireValue(agent && typeof agent.whenIdle === 'function', 'worker-unavailable', 'Worker is not attached.', 409);
    // Same stable-idle algorithm as the shipped headless runner: a parent's
    // first idle edge can precede child completion and the later summary turn.
    const subagents = this.ctx.get('subagents');
    while (true) {
      await agent.whenIdle();
      const seq = agent.session.seq;
      if (!await subagents?.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) break;
    }
    await this.ctx.sessions.flush(agent.session);
  }
  cancel(sessionId) {
    const agent = this.live(sessionId);
    requireValue(agent, 'worker-unavailable', 'Worker is not attached.', 409);
    // Unlike the UI stop operation, clear the bridge-owned pending inbox as well.
    agent.cancel({ kind: 'user' });
  }
}
