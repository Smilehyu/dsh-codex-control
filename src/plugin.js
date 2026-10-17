import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Store, atomicJson } from './store.js';
import { DshAdapter } from './adapter.js';
import { Controller } from './controller.js';
import { startServer } from './http.js';
import { requireValue } from './errors.js';

export const name = 'dsh-codex-control';
export const inject = ['sessionController', 'agents', 'sessions', 'workspaceRegistry'];
export const defaultDirectory = () => join(homedir(), '.dsh', 'codex-control');

async function acquireLock(directory) {
  const path = join(directory, 'bridge.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => { await handle.close(); await unlink(path).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = JSON.parse(await readFile(path, 'utf8'));
      requireValue(Number.isSafeInteger(lock.pid) && lock.pid > 0, 'invalid-lock', 'Invalid bridge lock; inspect the data directory.', 503);
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      requireValue(!alive, 'already-running', 'Another bridge owns this data directory.', 503);
      await unlink(path);
    }
  }
  throw new Error('Cannot acquire bridge lock');
}

export async function startBridge(ctx, config = {}, adapterOverride) {
  requireValue(Array.isArray(config.allowedRoots) && config.allowedRoots.length > 0, 'missing-roots', 'Configure non-empty allowedRoots before enabling the bridge.');
  const roots = await Promise.all(config.allowedRoots.map(async root => {
    requireValue(typeof root === 'string' && isAbsolute(root), 'invalid-root', 'allowedRoots must be absolute paths.');
    const canonical = await realpath(root);
    requireValue((await stat(canonical)).isDirectory(), 'invalid-root', 'allowedRoots must be existing directories.');
    return canonical;
  }));
  const directory = config.dataDir ?? defaultDirectory();
  requireValue(isAbsolute(directory), 'invalid-data-dir', 'dataDir must be absolute.');
  requireValue(config.port === undefined || Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535, 'invalid-port', 'port must be between 0 and 65535.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await acquireLock(directory);
  const connectionFile = join(directory, 'connection.json');
  let controller; let server; const token = randomBytes(32).toString('hex');
  try {
    const store = new Store(directory); await store.load();
    controller = new Controller(store, adapterOverride ?? new DshAdapter(ctx), roots);
    await controller.recover();
    server = await startServer(controller, token, config.port ?? 0);
    await atomicJson(connectionFile, { version: 1, url: server.url, token });
  } catch (error) {
    await server?.close(); await controller?.close(); await unlock(); throw error;
  }
  let closed = false;
  return { controller, connectionFile, async close() {
    if (closed) return; closed = true;
    await server.close(); await controller.close();
    const connection = JSON.parse(await readFile(connectionFile, 'utf8').catch(() => '{}'));
    if (connection.token === token) await unlink(connectionFile).catch(() => {});
    await unlock();
  } };
}

export async function apply(ctx, config) {
  const starting = startBridge(ctx, config);
  ctx.on('dispose', async () => { await (await starting.catch(() => undefined))?.close(); });
  await starting;
  ctx.logger.info('Codex control bridge ready (local connection file; no credentials logged).');
}
