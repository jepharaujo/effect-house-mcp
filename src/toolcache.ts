import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Remembers the kernel's tool list per installed app version, so listing tools
 * does not start the kernel in every agent session; the kernel then starts on
 * the first call that needs it.
 */
export class ToolCache {
  constructor(
    private readonly file: string,
    private readonly fingerprint: string,
  ) {}

  static in(stateDir: string, fingerprint: string): ToolCache {
    return new ToolCache(path.join(stateDir, 'kernel-tools.json'), fingerprint);
  }

  async load(): Promise<Tool[] | undefined> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as { fingerprint?: string; tools?: Tool[] };
      return data.fingerprint === this.fingerprint && Array.isArray(data.tools) && data.tools.length > 0
        ? data.tools
        : undefined;
    } catch {
      return undefined;
    }
  }

  async save(tools: Tool[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify({ fingerprint: this.fingerprint, tools }, null, 2)}\n`);
  }
}
