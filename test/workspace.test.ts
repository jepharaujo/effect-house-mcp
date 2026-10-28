import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildInstructions, prepareWorkspace, readGuide, readWorkspaceEntry } from '../src/workspace.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function template(): Promise<string> {
  const dir = await tempDir('eh-template-');
  await writeFile(path.join(dir, 'AGENTS.md'), '# Guide\n\nRun cells with `mcp__eh__run`.\n');
  await writeFile(path.join(dir, '.mcp.json'), '{"mcpServers":{"eh":{"command":"__EH_COMMAND__"}}}');
  await mkdir(path.join(dir, '.claude'));
  await writeFile(path.join(dir, '.claude', 'settings.json'), '{}');
  await mkdir(path.join(dir, 'skills', 'vfx'), { recursive: true });
  await writeFile(path.join(dir, 'skills', 'vfx', 'SKILL.md'), 'x'.repeat(5000));
  await writeFile(path.join(dir, 'skills', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  return dir;
}

describe('prepareWorkspace', () => {
  it('copies the template without agent-host configs and only once per fingerprint', async () => {
    const source = await template();
    const state = await tempDir('eh-state-');
    const first = await prepareWorkspace(source, state, '5.16.0');
    assert.ok(first);
    assert.equal(first.refreshed, true);
    assert.deepEqual((await readdir(first.path)).sort(), ['AGENTS.md', 'skills']);

    const second = await prepareWorkspace(source, state, '5.16.0');
    assert.equal(second?.refreshed, false);

    const upgraded = await prepareWorkspace(source, state, '5.17.0');
    assert.equal(upgraded?.refreshed, true);
  });

  it('keeps an earlier copy when the template disappears', async () => {
    const source = await template();
    const state = await tempDir('eh-state-');
    await prepareWorkspace(source, state, '5.16.0');
    const fallback = await prepareWorkspace(path.join(source, 'missing'), state, '5.16.0');
    assert.equal(fallback?.stale, true);
    assert.equal(await prepareWorkspace(path.join(source, 'missing'), await tempDir('eh-empty-'), '5.16.0'), undefined);
  });
});

describe('buildInstructions', () => {
  it('names the workspace and adapts the official guide', async () => {
    const source = await template();
    const workspace = await prepareWorkspace(source, await tempDir('eh-state-'), '5.16.0');
    const text = buildInstructions({
      workspace,
      guide: await readGuide(workspace?.path ?? ''),
      appVersion: '5.16.0',
      automationTools: false,
    });
    assert.match(text, /Effect House 5\.16\.0/);
    assert.ok(workspace && text.includes(workspace.path));
    assert.match(text, /Run cells with the `run` tool of this server\./);
    assert.doesNotMatch(text, /mcp__eh__run/);
  });
});

describe('readWorkspaceEntry', () => {
  it('lists folders, pages long files and flags binaries', async () => {
    const root = await template();
    const listing = await readWorkspaceEntry(root, 'skills');
    assert.equal(listing.kind, 'directory');
    assert.ok(listing.kind === 'directory' && listing.entries.includes('vfx/'));

    const page = await readWorkspaceEntry(root, 'skills/vfx/SKILL.md', { maxChars: 1000 });
    assert.equal(page.kind, 'file');
    assert.ok(page.kind === 'file' && page.content.length === 1000 && page.nextOffset === 1000);

    const binary = await readWorkspaceEntry(root, 'skills/image.png');
    assert.equal(binary.kind, 'binary');
  });

  it('refuses paths that leave the workspace, including through symlinks', async () => {
    const root = await template();
    const outside = await tempDir('eh-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'link'));
    await assert.rejects(readWorkspaceEntry(root, '../../etc/passwd'), /outside the workspace|Not found/);
    await assert.rejects(readWorkspaceEntry(root, 'link/secret.txt'), /outside the workspace/);
    await assert.rejects(readWorkspaceEntry(root, path.join(outside, 'secret.txt')), /outside the workspace/);
  });
});
