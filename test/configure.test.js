import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/configure.mjs', import.meta.url));

test('configuration installer preserves other entries, replaces its section and uninstalls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-'));
  const profile = join(root, 'profile'); await mkdir(profile);
  const patch = join(profile, 'cordis.patch.yml'); const codex = join(root, 'config.toml');
  await writeFile(patch, '# preserved\n[]\n'); await writeFile(codex, 'model = "keep-this-model"\n');
  const args = [script, '--root', root, '--profile-dir', profile, '--codex-config', codex, '--data-dir', join(root, 'data')];
  await run(process.execPath, args); await run(process.execPath, args);
  const yaml = await readFile(patch, 'utf8'); const toml = await readFile(codex, 'utf8');
  assert.match(yaml, /# preserved/); assert.equal((yaml.match(/BEGIN dsh-codex-control/g) ?? []).length, 1);
  assert.doesNotMatch(yaml, /^\[\]$/m); assert.match(toml, /keep-this-model/);
  assert.ok((await readdir(profile)).some(name => name.includes('backup-')));
  await run(process.execPath, [...args, '--uninstall']);
  assert.doesNotMatch(await readFile(patch, 'utf8'), /codex-control/);
  assert.doesNotMatch(await readFile(codex, 'utf8'), /dsh_control/);
});

test('configuration conflict is detected before any destination is modified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-conflict-'));
  const profile = join(root, 'profile'); await mkdir(profile);
  const patch = join(profile, 'cordis.patch.yml'); const codex = join(root, 'config.toml');
  await writeFile(patch, '# untouched\n'); await writeFile(codex, '[mcp_servers.dsh_control]\ncommand = "existing"\n');
  await assert.rejects(run(process.execPath, [script, '--root', root, '--profile-dir', profile, '--codex-config', codex]));
  assert.equal(await readFile(patch, 'utf8'), '# untouched\n');
});
