import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { log } from './log.js';
import type { Upstream } from './upstream.js';

/**
 * Forwards the official eh kernel. `eh_front` is Effect House's own stdio MCP
 * front: it starts the kernel and re-reads the instance registry before every
 * cell, so an editor restart is followed without help from the bridge. The
 * bridge only spawns it lazily and respawns it if it exits.
 */

export interface KernelOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
}

export interface KernelState {
  running: boolean;
  pid?: number;
  starts: number;
  lastExit?: { at: string; afterStart: number };
  stderrTail: string[];
}

const STDERR_LINES = 40;

function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // The kernel runs on the editor's bundled Node; flags meant for this process must not leak in.
    if (key === 'NODE_OPTIONS' || key === 'NODE_REPL_EXTERNAL_MODULE') continue;
    result[key] = value;
  }
  return result;
}

export class KernelUpstream implements Upstream {
  readonly id = 'kernel';
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;
  private tools?: Tool[];
  private starts = 0;
  private lastExit?: { at: string; afterStart: number };
  private restartPending = false;
  private stderrTail: string[] = [];
  private stderrPartial = '';

  constructor(private readonly options: KernelOptions) {}

  state(): KernelState {
    return {
      running: this.client !== undefined,
      pid: this.transport?.pid ?? undefined,
      starts: this.starts,
      lastExit: this.lastExit,
      stderrTail: [...this.stderrTail],
    };
  }

  /** Set once when the kernel had to be started again; the caller reports it. */
  takeRestartNotice(): string | undefined {
    if (!this.restartPending) return undefined;
    this.restartPending = false;
    return `The eh kernel was restarted (previous one exited at ${this.lastExit?.at ?? 'an unknown time'}); \`session\` values saved by earlier cells are gone.`;
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    if (!this.tools) this.tools = (await client.listTools()).tools;
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CallToolResult> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal: options.signal,
      timeout: options.timeoutMs,
      resetTimeoutOnProgress: true,
    });
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.start().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async start(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: childEnv(this.options.env ?? process.env),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => this.recordStderr(chunk.toString('utf8')));
    const client = new Client({ name: 'effect-house-mcp', version: this.options.clientVersion });
    const startNumber = this.starts + 1;
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.transport = undefined;
      this.tools = undefined;
      this.lastExit = { at: new Date().toISOString(), afterStart: startNumber };
      log('warn', 'eh kernel exited; it will be started again on the next call');
    };
    await client.connect(transport);
    this.starts = startNumber;
    if (this.lastExit) this.restartPending = true;
    this.client = client;
    this.transport = transport;
    log('info', `eh kernel started (pid ${transport.pid ?? '?'})`);
    return client;
  }

  private recordStderr(text: string): void {
    const lines = (this.stderrPartial + text).split('\n');
    this.stderrPartial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      log('debug', `kernel: ${line}`);
      this.stderrTail.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    }
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_LINES);
  }
}

/** Shown when the kernel cannot be listed (app missing or failing to start). */
export const FALLBACK_KERNEL_TOOLS: Tool[] = [
  {
    name: 'run',
    description:
      'Run a JavaScript cell in the Effect House eh kernel, which drives the open editor through a pre-connected `eh` API. The kernel is not available right now; call `instances` to see why.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Cell source. Exactly one of `code` or `path`.' },
        name: { type: 'string', description: 'Optional save name for the cell.' },
        path: { type: 'string', description: 'Path of an existing .mjs cell to run.' },
        timeoutMs: { type: 'number', description: 'Per-cell timeout in milliseconds.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reset',
    description: 'Discard eh kernel state (session values and connection).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'status',
    description: 'Report eh kernel status: cells run, instance, project and connection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
