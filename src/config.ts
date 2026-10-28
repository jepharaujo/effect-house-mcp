import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where Effect House and this bridge keep their files.
 *
 * Defaults target macOS, where Effect House 5.16 was studied. Every path can be
 * overridden by an environment variable, which is also the way to try other
 * platforms (untested).
 */
export interface Config {
  platform: NodeJS.Platform;
  /** Effect House's own support folder: instance registry, logs, sessions. */
  supportDir: string;
  /** Folder that holds the editor executable and `eh_front`. */
  executableDir: string;
  /** The `.app` bundle on macOS; the install folder elsewhere. */
  appPath: string;
  /** The official stdio front of the eh kernel shipped with the editor. */
  ehFrontPath: string;
  /** Workspace template the editor copies for its built-in agents. */
  workspaceTemplate: string;
  /** This bridge's own state (managed workspace copy). */
  stateDir: string;
  /** This bridge's cache (documentation pages). */
  cacheDir: string;
  /** Pin the kernel to the editor that has this project open. */
  pinnedProject?: string;
  /** Also expose the editor's automation tools directly (large tool list). */
  automationTools: boolean;
}

const DEFAULT_MAC_APP = '/Applications/Effect House.app';

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/** `app.json` is written by the editor on start and names its executable folder. */
function executableDirFromAppJson(supportDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(supportDir, 'app.json'), 'utf8')) as {
      executableDir?: unknown;
    };
    return typeof parsed.executableDir === 'string' && parsed.executableDir ? parsed.executableDir : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const platform = process.platform;
  const home = os.homedir();
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';

  const supportDir =
    env.EH_SUPPORT_DIR ??
    (isMac
      ? path.join(home, 'Library', 'Application Support', 'EffectHouse')
      : isWin
        ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'EffectHouse')
        : path.join(home, '.config', 'EffectHouse'));

  const executableDir =
    env.EH_EXECUTABLE_DIR ??
    (env.EH_APP_PATH && isMac ? path.join(env.EH_APP_PATH, 'Contents', 'MacOS') : undefined) ??
    executableDirFromAppJson(supportDir) ??
    (isMac ? path.join(DEFAULT_MAC_APP, 'Contents', 'MacOS') : (env.EH_APP_PATH ?? ''));

  const appPath = env.EH_APP_PATH ?? (isMac ? path.resolve(executableDir, '..', '..') : executableDir);
  const resourcesDir = isMac ? path.resolve(executableDir, '..', 'Resources') : path.join(executableDir, 'resources');

  const stateDir =
    env.EH_MCP_STATE_DIR ??
    (isMac
      ? path.join(home, 'Library', 'Application Support', 'effect-house-mcp')
      : path.join(home, '.effect-house-mcp'));
  const cacheDir =
    env.EH_MCP_CACHE_DIR ??
    (isMac ? path.join(home, 'Library', 'Caches', 'effect-house-mcp') : path.join(stateDir, 'cache'));

  return {
    platform,
    supportDir,
    executableDir,
    appPath,
    ehFrontPath: env.EH_FRONT_PATH ?? path.join(executableDir, isWin ? 'eh_front.exe' : 'eh_front'),
    workspaceTemplate: env.EH_WORKSPACE_TEMPLATE ?? path.join(resourcesDir, 'ask-ai-ptc', 'workspace'),
    stateDir,
    cacheDir,
    pinnedProject: env.EH_PROJECT || undefined,
    automationTools: truthy(env.EH_MCP_AUTOMATION_TOOLS),
  };
}
