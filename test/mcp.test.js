import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startBridge } from '../src/plugin.js';
import { FakeAdapter } from './helpers.js';

test('real stdio MCP handshake, tool discovery and call through authenticated HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-'));
  const bridge = await startBridge({}, { allowedRoots: [directory], dataDir: join(directory, 'data') }, new FakeAdapter());
  t.after(() => bridge.close());
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../bin/mcp.js', import.meta.url))],
    env: { ...process.env, DSH_CONTROL_CONNECTION_FILE: bridge.connectionFile }, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 9);
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).sessionPolicy, 'bridge-created-only');
  const invalid = await client.callTool({ name: 'submit_task', arguments: {} });
  assert.equal(invalid.isError, true);
});
