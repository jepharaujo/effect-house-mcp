import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** A server whose tools the bridge forwards unchanged. */
export interface Upstream {
  readonly id: string;
  listTools(): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}
