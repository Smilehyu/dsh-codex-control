#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const uninstall = args.includes('--uninstall');
const root = value('--root');
if (!uninstall && (!root || !isAbsolute(root))) throw new Error('Usage: node scripts/configure.mjs --root ABSOLUTE_WORKSPACE [--profile-dir DIR] [--codex-config FILE] [--data-dir DIR]');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = value('--profile-dir') ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const dataDir = value('--data-dir') ?? join(homedir(), '.dsh', 'codex-control');
const codexConfig = value('--codex-config');
for (const path of [profileDir, dataDir, ...(codexConfig ? [codexConfig] : [])]) if (!isAbsolute(path)) throw new Error('All configuration paths must be absolute.');
if (!uninstall) { await access(root); await access(join(packageRoot, 'node_modules', 'zod')); }
const begin = '# BEGIN dsh-codex-control'; const end = '# END dsh-codex-control';
// Preflight both destinations before changing either file.
for (const file of [join(profileDir, 'cordis.patch.yml'), ...(codexConfig ? [codexConfig] : [])]) {
  const existing = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const start = existing.indexOf(begin); const finish = existing.indexOf(end);
  if ((start < 0) !== (finish < 0) || finish >= 0 && finish < start || start >= 0 && existing.indexOf(begin, start + begin.length) >= 0)
    throw new Error('Malformed managed section. Preserve and inspect the original file.');
  if (file === codexConfig && !existing.includes(begin) && /\[mcp_servers\.dsh_control\]/.test(existing))
    throw new Error('Existing dsh_control MCP entry must be preserved; choose another server name manually.');
}
async function update(file, addition) {
  let original = '';
  try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const start = original.indexOf(begin); const finish = original.indexOf(end);
  if ((start < 0) !== (finish < 0) || finish >= 0 && finish < start) throw new Error('Malformed managed section. Preserve and inspect the original file.');
  let rest = start < 0 ? original : original.slice(0, start) + original.slice(finish + end.length).replace(/^\r?\n/, '');
  if (file === join(profileDir, 'cordis.patch.yml') && addition) rest = rest.replace(/^\s*\[\]\s*$/m, '');
  await mkdir(dirname(file), { recursive: true });
  let backup;
  if (original) { backup = `${file}.backup-${Date.now()}`; await copyFile(file, backup); }
  await writeFile(file, rest.trimEnd() + (addition ? `\n\n${begin}\n${addition}\n${end}\n` : '\n'));
  console.log(JSON.stringify({ updated: file, ...(backup ? { backup } : {}) }));
}
const yaml = uninstall ? '' : [
  '- insert:', '    - id: codex-control', `      name: ${JSON.stringify(join(packageRoot, 'src', 'plugin.js').replaceAll('\\', '/'))}`,
  '      config:', `        allowedRoots: ${JSON.stringify([resolve(root)])}`, `        dataDir: ${JSON.stringify(dataDir)}`,
].join('\n');
await update(join(profileDir, 'cordis.patch.yml'), yaml);
if (codexConfig) {
  const existing = await readFile(codexConfig, 'utf8').catch(() => '');
  if (!existing.includes(begin) && /\[mcp_servers\.dsh_control\]/.test(existing)) throw new Error('Existing dsh_control MCP entry must be preserved; choose another server name manually.');
  const toml = uninstall ? '' : [
    '[mcp_servers.dsh_control]', 'command = "node"', `args = [${JSON.stringify(join(packageRoot, 'bin', 'mcp.js'))}]`,
    'tool_timeout_sec = 45', '[mcp_servers.dsh_control.env]',
    `DSH_CONTROL_CONNECTION_FILE = ${JSON.stringify(join(dataDir, 'connection.json'))}`,
  ].join('\n');
  await update(codexConfig, toml);
}
console.log(uninstall ? 'Managed entries removed; task data and backups retained.' : 'Configured. Reload the DSH profile if necessary, then reconnect Codex MCP.');
