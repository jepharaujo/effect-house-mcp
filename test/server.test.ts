import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KernelState } from '../src/kernel.js';
import type { InstanceRecord, RegistryScan } from '../src/registry.js';
import { Bridge, type BridgeDeps, findProjectFile, type KernelLike } from '../src/server.js';
import type { Upstream } from '../src/upstream.js';

const INSTANCE: InstanceRecord = {
  name: 'Instance1',
  file: '/x/mcp_port.json',
  pid: 4242,
  host: '127.0.0.1',
  port: 9100,
  mcpUrl: 'http://127.0.0.1:9100/mcp',
  healthUrl: 'http://127.0.0.1:9100/health',
  agentMode: false,
  appVersion: '5.16.0',
  heartbeatIntervalMs: 20000,
  heartbeatAgeMs: 1000,
  alive: true,
  stale: false,
};

const KERNEL_TOOLS: Tool[] = [
  {
    name: 'run',
    description: 'Run a cell.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
  },
  { name: 'reset', inputSchema: { type: 'object' } },
  { name: 'status', inputSchema: { type: 'object' } },
];

class FakeKernel implements KernelLike {
  readonly id = 'kernel';
  calls: { name: string; args: Record<string, unknown>; timeoutMs?: number }[] = [];
  failList = false;
  failCall = false;
  notice?: string;
  async listTools(): Promise<Tool[]> {
    if (this.failList) throw new Error('spawn ENOENT');
    return KERNEL_TOOLS;
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number },
  ): Promise<CallToolResult> {
    this.calls.push({ name, args, timeoutMs: options.timeoutMs });
    if (this.failCall) throw new Error('kernel exited');
    return {
      content: [
        { type: 'text', text: `kernel:${name}` },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    };
  }
  async close(): Promise<void> {}
  state(): KernelState {
    return { running: true, starts: 1, stderrTail: ['last kernel line'] };
  }
  takeRestartNotice(): string | undefined {
    const notice = this.notice;
    this.notice = undefined;
    return notice;
  }
}

function scan(instances: InstanceRecord[]): RegistryScan {
  return { dir: '/x/Instances', exists: true, instances, errors: [] };
}

async function connect(overrides: Partial<BridgeDeps> = {}) {
  const kernel = (overrides.kernel as FakeKernel | undefined) ?? new FakeKernel();
  let launched: string | undefined | null = null;
  const deps: BridgeDeps = {
    version: '0.0.0-test',
    instructions: 'test instructions',
    workspace: undefined,
    kernel,
    docs: {
      search: async (query) => ({
        hits: [{ url: 'https://effecthouse.tiktok.com/learn/guides/a', title: query, section: '', score: 1 }],
        indexedPages: 0,
        totalPages: 1,
      }),
      read: async (url) => ({ url, title: 'T', markdown: 'abcdefghij'.repeat(500), fetchedAt: '2026-10-28T00:00:00Z' }),
    },
    app: {
      info: async () => ({
        appPath: '/Applications/Effect House.app',
        installed: true,
        version: '5.16.0',
        ehFrontPath: '/x/eh_front',
        ehFrontExists: true,
        workspaceTemplate: '/x/ws',
        workspaceTemplateExists: true,
      }),
      launch: async (project) => {
        launched = project;
      },
      waitForInstance: async () => INSTANCE,
    },
    registry: {
      scan: async () => scan([INSTANCE]),
      health: async () => ({ ok: true, status: 200 }),
      projectStatus: async () => ({ hasActiveProject: true, path: '/p/effect.ehproj' }),
    },
    ...overrides,
  };
  const bridge = new Bridge(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  return { client, bridge, kernel, launched: () => launched };
}

function text(result: unknown): string {
  return ((result as CallToolResult).content ?? [])
    .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
    .join('\n');
}

describe('Bridge', () => {
  it('advertises instructions, its own tools and the kernel tools', async () => {
    const { client } = await connect();
    assert.equal(client.getInstructions(), 'test instructions');
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['instances', 'launch', 'docs_search', 'docs_read', 'workspace_read', 'run', 'reset', 'status'],
    );
    assert.match(tools.find((tool) => tool.name === 'run')?.description ?? '', /Bridge note/);
  });

  it('falls back to built-in kernel definitions when the kernel cannot start', async () => {
    const kernel = new FakeKernel();
    kernel.failList = true;
    const { client } = await connect({ kernel });
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'run' && /not available/.test(tool.description ?? '')));
  });

  it('forwards kernel calls unchanged, images included, with a cell-sized timeout', async () => {
    const { client, kernel } = await connect();
    await client.listTools();
    const result = (await client.callTool({
      name: 'run',
      arguments: { code: 'return 1', timeoutMs: 1000 },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.content?.map((item) => item.type),
      ['text', 'image'],
    );
    assert.equal(kernel.calls[0]?.timeoutMs, 61_000);
  });

  it('prefixes a restart notice once', async () => {
    const kernel = new FakeKernel();
    kernel.notice = 'kernel restarted';
    const { client } = await connect({ kernel });
    const first = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(text(first), '[effect-house-mcp] kernel restarted\nkernel:status\n[image]');
    const second = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(text(second), 'kernel:status\n[image]');
  });

  it('refuses to run a cell when no editor is open', async () => {
    const kernel = new FakeKernel();
    const { client } = await connect({
      kernel,
      registry: {
        scan: async () => scan([{ ...INSTANCE, stale: true }]),
        health: async () => ({ ok: false }),
        projectStatus: async () => null,
      },
    });
    const result = (await client.callTool({ name: 'run', arguments: { code: 'return 1' } })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(text(result), /not open/);
    assert.equal(kernel.calls.length, 0);
  });

  it('reports kernel failures as tool errors with the stderr tail', async () => {
    const kernel = new FakeKernel();
    kernel.failCall = true;
    const { client } = await connect({ kernel });
    const result = (await client.callTool({ name: 'run', arguments: { code: 'x' } })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(text(result), /kernel exited[\s\S]*last kernel line/);
  });

  it('describes instances with health and the open project', async () => {
    const { client } = await connect();
    const report = JSON.parse(text(await client.callTool({ name: 'instances', arguments: {} })));
    assert.equal(report.instances[0].health.ok, true);
    assert.equal(report.instances[0].project.path, '/p/effect.ehproj');
    assert.deepEqual(report.hints, []);
  });

  it('does not launch a second editor', async () => {
    const harness = await connect();
    const report = JSON.parse(text(await harness.client.callTool({ name: 'launch', arguments: {} })));
    assert.equal(report.alreadyRunning, true);
    assert.equal(harness.launched(), null);
  });

  it('launches when no editor runs and validates the project path', async () => {
    const harness = await connect({
      registry: { scan: async () => scan([]), health: async () => ({ ok: false }), projectStatus: async () => null },
    });
    const bad = (await harness.client.callTool({
      name: 'launch',
      arguments: { project: '/tmp/a.txt' },
    })) as CallToolResult;
    assert.equal(bad.isError, true);
    const report = JSON.parse(text(await harness.client.callTool({ name: 'launch', arguments: {} })));
    assert.equal(report.launched, true);
    assert.equal(harness.launched(), undefined);
  });

  it('pages docs_read output', async () => {
    const { client } = await connect();
    const result = text(await client.callTool({ name: 'docs_read', arguments: { url: 'guides/a', maxChars: 2000 } }));
    assert.match(result, /characters 0–2000 of 5000 · continue with offset 2000/);
  });

  it('routes automation tools when enabled and hides colliding names', async () => {
    const automationCalls: string[] = [];
    const automation: Upstream = {
      id: 'automation',
      listTools: async () => [
        { name: 'get_scene', inputSchema: { type: 'object' } },
        { name: 'run', inputSchema: { type: 'object' } },
      ],
      callTool: async (name) => {
        automationCalls.push(name);
        return { content: [{ type: 'text', text: `automation:${name}` }] };
      },
      close: async () => {},
    };
    const { client } = await connect({ automation });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name === 'run').length, 1);
    assert.ok(names.includes('get_scene'));
    assert.equal(text(await client.callTool({ name: 'get_scene', arguments: {} })), 'automation:get_scene');
    assert.deepEqual(automationCalls, ['get_scene']);
  });

  it('answers unknown tools with an error result', async () => {
    const { client } = await connect();
    const result = (await client.callTool({ name: 'nope', arguments: {} })) as CallToolResult;
    assert.equal(result.isError, true);
  });
});

describe('findProjectFile', () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('resolves a project folder to its .ehproj and accepts the file itself', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-project-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'effect.ehproj'), '');
    await mkdir(path.join(dir, 'Assets'));
    assert.equal(await findProjectFile(dir), path.join(dir, 'effect.ehproj'));
    assert.equal(await findProjectFile(path.join(dir, 'effect.ehproj')), path.join(dir, 'effect.ehproj'));
    await assert.rejects(findProjectFile(path.join(dir, 'Assets')), /No \.ehproj file/);
    await assert.rejects(findProjectFile(path.join(dir, 'missing')), /Project not found/);
  });
});
