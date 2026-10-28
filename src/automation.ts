import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { type InstanceRecord, liveInstances, scanRegistry } from './registry.js';
import type { Upstream } from './upstream.js';

/**
 * The editor's local automation server (HTTP MCP, named in the instance
 * registry). The kernel reaches it from inside cells; the bridge also uses it
 * for quick read-only checks and, when enabled, forwards its tools directly.
 */

async function connect(instance: InstanceRecord, clientVersion: string): Promise<Client> {
  const client = new Client({ name: 'effect-house-mcp', version: clientVersion });
  await client.connect(new StreamableHTTPClientTransport(new URL(instance.mcpUrl)));
  return client;
}

/** One short-lived call, for checks such as `project_status`. */
export async function callAutomationOnce(
  instance: InstanceRecord,
  name: string,
  args: Record<string, unknown>,
  options: { clientVersion: string; timeoutMs?: number },
): Promise<CallToolResult> {
  const client = await connect(instance, options.clientVersion);
  try {
    return (await client.callTool({ name, arguments: args }, undefined, {
      timeout: options.timeoutMs ?? 5000,
    })) as CallToolResult;
  } finally {
    await client.close().catch(() => {});
  }
}

export function connectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++, current = (current as { cause?: unknown }).cause) {
    if ((current as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
    if (current instanceof Error && /ECONNREFUSED/.test(current.message)) return true;
  }
  return false;
}

/** Parses the JSON text a tool returned, if it is JSON. */
export function resultJson(result: CallToolResult): unknown {
  const first = result.content?.[0];
  if (first?.type !== 'text') return undefined;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

export class AutomationUpstream implements Upstream {
  readonly id = 'automation';
  private client?: Client;
  private url?: string;
  private tools: Tool[] = [];

  constructor(
    private readonly supportDir: string,
    private readonly clientVersion: string,
  ) {}

  /** Tools of the editor that is open now; the last known list if none answers. */
  async listTools(): Promise<Tool[]> {
    try {
      const client = await this.connect();
      this.tools = (await client.listTools()).tools;
    } catch {
      // Keep the previous list: the editor may be restarting.
    }
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CallToolResult> {
    const attempt = async () => {
      const client = await this.connect();
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs,
        resetTimeoutOnProgress: true,
      })) as CallToolResult;
    };
    try {
      return await attempt();
    } catch (error) {
      // Retry only a refused connection (the editor restarted on another port). A call that
      // reached the editor may already have applied its edits, so it is never sent twice.
      if (options.signal?.aborted || !connectionRefused(error)) throw error;
      await this.drop();
      return attempt();
    }
  }

  async close(): Promise<void> {
    await this.drop();
  }

  private async drop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.url = undefined;
    await client?.close().catch(() => {});
  }

  private async connect(): Promise<Client> {
    const [instance] = liveInstances(await scanRegistry(this.supportDir));
    if (!instance) throw new Error('Effect House is not running (no live instance in the registry).');
    if (this.client && this.url === instance.mcpUrl) return this.client;
    await this.drop();
    this.client = await connect(instance, this.clientVersion);
    this.url = instance.mcpUrl;
    return this.client;
  }
}
