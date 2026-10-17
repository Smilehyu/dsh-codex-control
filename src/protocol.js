import { z } from 'zod';

const id = z.string().uuid();
const taskId = z.object({ taskId: id }).strict();
const assignment = {
  requestId: id.describe('Stable UUID for this submission; reuse the same UUID after a lost response.'),
  objective: z.string().trim().min(1).max(32000),
  constraints: z.array(z.string().min(1).max(4000)).max(50).optional(),
  acceptance: z.array(z.string().min(1).max(4000)).max(50).optional(),
};
export const operations = {
  get_capabilities: { description: 'Inspect the bridge capabilities and allowed project roots.', schema: z.object({}).strict(), method: 'capabilities', readOnly: true },
  list_worker_sessions: { description: 'List only sessions created by this bridge.', schema: z.object({}).strict(), method: 'listSessions', readOnly: true },
  create_worker_session: { description: 'Create a dedicated desktop-visible Harness worker in an allowed directory.',
    schema: z.object({ cwd: z.string().min(1), title: z.string().trim().min(1).max(120).optional(), agentPreset: z.string().min(1).max(120).optional() }).strict(), method: 'createSession' },
  submit_task: { description: 'Assign a bounded task to a bridge-owned worker; returns immediately. Reuse requestId when retrying.',
    schema: z.object({ sessionId: z.string().min(1).max(200), ...assignment }).strict(), method: 'submit' },
  get_task: { description: 'Read task status and evidence after an event cursor. Completed does not mean independently verified.',
    schema: taskId.extend({ afterSeq: z.number().int().min(-1).optional() }), method: 'getTask', readOnly: true },
  wait_task: { description: 'Wait up to 30 seconds for new evidence or a task terminal state.',
    schema: taskId.extend({ afterSeq: z.number().int().min(-1).optional(), timeoutMs: z.number().int().min(0).max(30000).optional() }), method: 'waitTask', readOnly: true },
  continue_task: { description: 'Create a new bounded assignment in the same worker conversation after the previous task ends.',
    schema: taskId.extend(assignment), method: 'continueTask' },
  cancel_task: { description: 'Cancel an owned task and clear pending input. Existing file changes are retained; wait for terminal status.', schema: taskId, method: 'cancelTask' },
  get_result: { description: 'Read the recorded answer and task evidence; inspect actual files and checks before accepting.', schema: taskId, method: 'getTask', readOnly: true },
};
