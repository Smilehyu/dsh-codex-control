import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlError } from './errors.js';

export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

/** One serialized writer; failures never silently replace an existing ledger. */
export class Store {
  constructor(directory) {
    this.directory = directory; this.file = join(directory, 'ledger.json');
    this.state = { version: 1, sessions: {}, tasks: {} }; this.queue = Promise.resolve();
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
      if (this.state.version !== 1 || !this.state.sessions || !this.state.tasks) throw new Error('invalid schema');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ControlError('ledger-invalid', 'Cannot read task ledger; preserve and repair it before starting.', 500);
    }
  }
  async transaction(operation) {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await operation(draft);
      await atomicJson(this.file, draft); this.state = draft;
      return structuredClone(result);
    });
    this.queue = next.catch(() => {}); return next;
  }
  snapshot() { return structuredClone(this.state); }
}
