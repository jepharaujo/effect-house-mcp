import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { isPidAlive, liveInstances, parsePortFile, scanRegistry } from '../src/registry.js';

const NOW = Date.parse('2026-10-28T18:00:00Z');

function portFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    port: 9100,
    host: '127.0.0.1',
    pid: 4242,
    startedAt: '2026-10-28T17:00:00Z',
    lastHeartbeat: '2026-10-28T17:59:50Z',
    heartbeatIntervalMs: 20000,
    mcpPath: '/mcp',
    healthPath: '/health',
    agentMode: false,
    appVersion: '5.16.0',
    ...overrides,
  });
}

const alive = () => true;

describe('parsePortFile', () => {
  it('builds loopback URLs and heartbeat age', () => {
    const record = parsePortFile('Instance1', 'f', portFile(), NOW, alive);
    assert.equal(record.mcpUrl, 'http://127.0.0.1:9100/mcp');
    assert.equal(record.healthUrl, 'http://127.0.0.1:9100/health');
    assert.equal(record.heartbeatAgeMs, 10_000);
    assert.equal(record.stale, false);
    assert.equal(record.appVersion, '5.16.0');
  });

  it('marks a heartbeat older than three intervals as stale', () => {
    const record = parsePortFile('I', 'f', portFile({ lastHeartbeat: '2026-10-28T17:58:00Z' }), NOW, alive);
    assert.equal(record.stale, true);
  });

  it('refuses hosts other than this machine', () => {
    assert.throws(() => parsePortFile('I', 'f', portFile({ host: '10.0.0.5' }), NOW, alive), /non-loopback/);
  });

  it('rejects an invalid port', () => {
    assert.throws(() => parsePortFile('I', 'f', portFile({ port: 'abc' }), NOW, alive), /invalid port/);
  });

  it('brackets IPv6 loopback', () => {
    assert.equal(parsePortFile('I', 'f', portFile({ host: '::1' }), NOW, alive).mcpUrl, 'http://[::1]:9100/mcp');
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for invalid pids', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
  });
});

describe('scanRegistry', () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function supportDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-registry-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      const folder = path.join(dir, 'Instances', name, 'MCP');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'mcp_port.json'), body);
    }
    await mkdir(path.join(dir, 'Instances', 'NoServer'), { recursive: true });
    return dir;
  }

  it('reports a missing registry without failing', async () => {
    const scan = await scanRegistry(path.join(os.tmpdir(), 'eh-does-not-exist'), NOW);
    assert.equal(scan.exists, false);
    assert.deepEqual(scan.instances, []);
  });

  it('keeps live instances, freshest first, and records broken files', async () => {
    const dir = await supportDir({
      Instance1: portFile({ pid: 1, lastHeartbeat: '2026-10-28T17:59:40Z' }),
      Instance2: portFile({ pid: 2, port: 9101, lastHeartbeat: '2026-10-28T17:59:55Z' }),
      Instance3: portFile({ pid: 3, port: 9102, lastHeartbeat: '2026-10-28T17:50:00Z' }),
      Instance4: portFile({ pid: 4, port: 9103 }),
      Instance5: '{not json',
    });
    const scan = await scanRegistry(dir, NOW, (pid) => pid !== 4);
    assert.equal(scan.exists, true);
    assert.equal(scan.instances.length, 4);
    assert.equal(scan.errors.length, 1);
    assert.deepEqual(
      liveInstances(scan).map((instance) => instance.name),
      ['Instance2', 'Instance1'],
    );
  });
});
