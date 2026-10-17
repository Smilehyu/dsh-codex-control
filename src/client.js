import { readFile } from 'node:fs/promises';
import { defaultDirectory } from './plugin.js';
import { join } from 'node:path';

export class BridgeClient {
  constructor(connectionFile = process.env.DSH_CONTROL_CONNECTION_FILE ?? join(defaultDirectory(), 'connection.json')) { this.connectionFile = connectionFile; }
  async call(operation, input = {}, signal) {
    const connection = JSON.parse(await readFile(this.connectionFile, 'utf8'));
    const url = new URL(connection.url);
    if (connection.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(connection.token))
      throw new Error('Invalid local bridge connection file.');
    const response = await fetch(new URL(`/v1/${operation}`, url), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(`${value.error?.code ?? 'bridge-error'}: ${value.error?.message ?? 'Operation failed'}`);
    return value.result;
  }
}
