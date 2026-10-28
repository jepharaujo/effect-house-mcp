import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { checkHealth, type InstanceRecord, liveInstances, scanRegistry } from './registry.js';

const execFileAsync = promisify(execFile);

export interface AppInfo {
  appPath: string;
  installed: boolean;
  version?: string;
  ehFrontPath: string;
  ehFrontExists: boolean;
  workspaceTemplate: string;
  workspaceTemplateExists: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readVersion(config: Config): Promise<string | undefined> {
  if (config.platform === 'darwin') {
    try {
      const plist = path.join(config.appPath, 'Contents', 'Info.plist');
      const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
      const version = stdout.trim();
      if (version) return version;
    } catch {
      // Fall through to app.json.
    }
  }
  try {
    const appJson = JSON.parse(await readFile(path.join(config.supportDir, 'app.json'), 'utf8')) as {
      appVersion?: unknown;
    };
    return typeof appJson.appVersion === 'string' ? appJson.appVersion : undefined;
  } catch {
    return undefined;
  }
}

export async function getAppInfo(config: Config): Promise<AppInfo> {
  const [installed, ehFrontExists, workspaceTemplateExists, version] = await Promise.all([
    exists(config.appPath),
    exists(config.ehFrontPath),
    exists(config.workspaceTemplate),
    readVersion(config),
  ]);
  return {
    appPath: config.appPath,
    installed,
    version,
    ehFrontPath: config.ehFrontPath,
    ehFrontExists,
    workspaceTemplate: config.workspaceTemplate,
    workspaceTemplateExists,
  };
}

/** Starts the editor without waiting for it; `project` is opened by the editor itself. */
export async function launchApp(config: Config, project?: string): Promise<void> {
  const projectArgs = project ? [project] : [];
  const [command, args] =
    config.platform === 'darwin'
      ? ['open', ['-a', config.appPath, ...projectArgs]]
      : [path.join(config.executableDir, 'Effect House.exe'), projectArgs];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Polls the instance registry until an editor answers its health check. */
export async function waitForInstance(
  config: Config,
  timeoutMs: number,
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<InstanceRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = options.pollMs ?? 1000;
  while (!options.signal?.aborted) {
    for (const instance of liveInstances(await scanRegistry(config.supportDir))) {
      if ((await checkHealth(instance)).ok) return instance;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return undefined;
}
