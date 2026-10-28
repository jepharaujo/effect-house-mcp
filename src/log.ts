// Logging goes to stderr only: stdout carries the MCP protocol.

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const wanted = process.env.EH_MCP_LOG_LEVEL as Level | undefined;
  return (wanted && ORDER[wanted]) || ORDER.info;
}

export function log(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  let suffix = '';
  if (extra !== undefined) {
    try {
      suffix = ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
    } catch {
      suffix = ` ${String(extra)}`;
    }
  }
  process.stderr.write(`[effect-house-mcp] ${level}: ${message}${suffix}\n`);
}
