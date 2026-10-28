import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Effect House writes one port file per running editor instance:
 * `<supportDir>/Instances/<name>/MCP/mcp_port.json`. It names the local
 * automation server and is refreshed by a heartbeat. This module reads those
 * files; it never writes them.
 */

export interface InstanceRecord {
  name: string;
  file: string;
  pid: number;
  host: string;
  port: number;
  mcpUrl: string;
  healthUrl: string;
  agentMode: boolean;
  appVersion?: string;
  startedAt?: string;
  lastHeartbeat?: string;
  heartbeatIntervalMs: number;
  heartbeatAgeMs?: number;
  /** The editor process still exists. */
  alive: boolean;
  /** The heartbeat stopped: the editor is gone or hung. */
  stale: boolean;
}

export interface RegistryScan {
  dir: string;
  exists: boolean;
  instances: InstanceRecord[];
  errors: { file: string; error: string }[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function urlPath(value: unknown, fallback: string): string {
  const text = asString(value) ?? fallback;
  return text.startsWith('/') ? text : `/${text}`;
}

export function parsePortFile(
  name: string,
  file: string,
  raw: string,
  now: number,
  pidAlive: (pid: number) => boolean = isPidAlive,
): InstanceRecord {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const pid = Number(data.pid);
  const port = Number(data.port);
  const host = asString(data.host) ?? '127.0.0.1';
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port ${String(data.port)}`);
  }
  // The bridge only ever talks to this machine.
  if (!LOOPBACK.has(host)) throw new Error(`refusing non-loopback host ${host}`);

  const heartbeatIntervalMs = Number(data.heartbeatIntervalMs) > 0 ? Number(data.heartbeatIntervalMs) : 20_000;
  const lastHeartbeat = asString(data.lastHeartbeat);
  const beatAt = lastHeartbeat ? Date.parse(lastHeartbeat) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(beatAt) ? Math.max(0, now - beatAt) : undefined;
  const staleAfter = Math.max(3 * heartbeatIntervalMs, 60_000);
  const base = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

  return {
    name,
    file,
    pid,
    host,
    port,
    mcpUrl: base + urlPath(data.mcpPath, '/mcp'),
    healthUrl: base + urlPath(data.healthPath, '/health'),
    agentMode: data.agentMode === true,
    appVersion: asString(data.appVersion),
    startedAt: asString(data.startedAt),
    lastHeartbeat,
    heartbeatIntervalMs,
    heartbeatAgeMs,
    alive: pidAlive(pid),
    stale: heartbeatAgeMs !== undefined && heartbeatAgeMs > staleAfter,
  };
}

export async function scanRegistry(
  supportDir: string,
  now: number = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<RegistryScan> {
  const dir = path.join(supportDir, 'Instances');
  const scan: RegistryScan = { dir, exists: false, instances: [], errors: [] };
  let names: string[];
  try {
    names = await readdir(dir);
    scan.exists = true;
  } catch {
    return scan;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name, 'MCP', 'mcp_port.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue; // An instance folder without a port file has no server running.
    }
    try {
      scan.instances.push(parsePortFile(name, file, raw, now, pidAlive));
    } catch (error) {
      scan.errors.push({ file, error: (error as Error).message });
    }
  }
  return scan;
}

/** Instances that look reachable, freshest heartbeat first. */
export function liveInstances(scan: RegistryScan): InstanceRecord[] {
  return scan.instances
    .filter((instance) => instance.alive && !instance.stale)
    .sort((a, b) => (a.heartbeatAgeMs ?? Infinity) - (b.heartbeatAgeMs ?? Infinity));
}

export interface HealthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function checkHealth(instance: InstanceRecord, timeoutMs = 1500): Promise<HealthResult> {
  try {
    const response = await fetch(instance.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json().catch(() => ({}))) as { status?: unknown };
    return { ok: body.status === undefined || body.status === 'ok', status: response.status };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
