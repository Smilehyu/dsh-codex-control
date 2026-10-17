#!/usr/bin/env node
import { BridgeClient } from '../src/client.js';
try {
  const client = new BridgeClient();
  const capabilities = await client.call('get_capabilities');
  console.log(JSON.stringify({ connected: true, ...capabilities }, null, 2));
} catch (error) {
  console.error(`Not connected: ${error.message}`);
  console.error('Confirm DSH is running, the Host plugin is enabled, and DSH_CONTROL_CONNECTION_FILE points to its connection.json.');
  process.exitCode = 1;
}
