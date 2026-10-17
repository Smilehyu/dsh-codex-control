#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { operations } from '../src/protocol.js';
import { BridgeClient } from '../src/client.js';

const client = new BridgeClient();
const server = new McpServer({ name: 'dsh-codex-control', version: '0.1.0' });
for (const [name, operation] of Object.entries(operations)) {
  server.registerTool(name, { description: operation.description, inputSchema: operation.schema,
    annotations: { readOnlyHint: operation.readOnly ?? false, destructiveHint: !operation.readOnly,
      idempotentHint: operation.readOnly ?? false, openWorldHint: true } }, async (input, extra) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await client.call(name, input, extra.signal)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
await server.connect(new StdioServerTransport());
