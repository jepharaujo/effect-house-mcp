import { cp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The eh kernel serves a workspace of references (skills, APJS declarations,
 * examples). Effect House ships a template inside the app bundle; the bridge
 * keeps its own copy so the kernel never runs against the signed bundle, and
 * refreshes it when the installed app changes.
 */

/** Agent-host configs in the template carry unfilled placeholders; the bridge does not need them. */
export const EXCLUDED_TOP_LEVEL = new Set(['.mcp.json', '.claude', '.codex', '.cursor', '.opencode']);

export interface WorkspaceInfo {
  path: string;
  appVersion?: string;
  fingerprint: string;
  refreshed: boolean;
  /** Set when the template is missing and an earlier copy is in use. */
  stale?: boolean;
}

interface Stamp {
  fingerprint: string;
  appVersion?: string;
  template: string;
  copiedAt: string;
}

async function fingerprintOf(template: string, appVersion?: string): Promise<string> {
  const guide = await stat(path.join(template, 'AGENTS.md'));
  const entries = await readdir(template);
  return [appVersion ?? 'unknown', Math.round(guide.mtimeMs), guide.size, entries.length].join('|');
}

async function readStamp(file: string): Promise<Stamp | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Stamp;
  } catch {
    return undefined;
  }
}

export async function prepareWorkspace(
  template: string,
  stateDir: string,
  appVersion?: string,
): Promise<WorkspaceInfo | undefined> {
  const target = path.join(stateDir, 'workspace');
  const stampFile = path.join(stateDir, 'workspace.json');
  const stamp = await readStamp(stampFile);

  let fingerprint: string;
  try {
    fingerprint = await fingerprintOf(template, appVersion);
  } catch {
    if (!stamp) return undefined;
    return {
      path: target,
      appVersion: stamp.appVersion,
      fingerprint: stamp.fingerprint,
      refreshed: false,
      stale: true,
    };
  }

  const current = await stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (current && stamp?.fingerprint === fingerprint) {
    return { path: target, appVersion, fingerprint, refreshed: false };
  }

  const staging = `${target}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await cp(template, staging, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(template, source);
      return !EXCLUDED_TOP_LEVEL.has(relative.split(path.sep)[0] ?? '');
    },
  });
  const previous = `${target}.previous-${process.pid}`;
  if (current) await rename(target, previous);
  await rename(staging, target);
  await rm(previous, { recursive: true, force: true });
  const next: Stamp = { fingerprint, appVersion, template, copiedAt: new Date().toISOString() };
  await writeFile(stampFile, `${JSON.stringify(next, null, 2)}\n`);
  return { path: target, appVersion, fingerprint, refreshed: true };
}

export async function readGuide(workspace: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
  } catch {
    return undefined;
  }
}

export function buildInstructions(options: {
  workspace?: WorkspaceInfo;
  guide?: string;
  appVersion?: string;
  automationTools: boolean;
}): string {
  const { workspace, guide, appVersion, automationTools } = options;
  const lines = [
    'Effect House MCP (unofficial bridge to TikTok Effect House).',
    '',
    `The \`run\`, \`reset\` and \`status\` tools are the official eh kernel shipped with Effect House ${appVersion ?? '(version unknown)'}, forwarded unchanged: \`run\` executes JavaScript cells with a pre-connected \`eh\` API that drives the open editor (scene, APJS scripts, assets, preview, screenshots).`,
    'Bridge tools: `instances` finds running editors and the open project; `launch` opens Effect House; `docs_search` / `docs_read` read the official docs at effecthouse.tiktok.com/learn; `workspace_read` reads the kernel workspace when you cannot read files yourself.',
  ];
  if (automationTools) {
    lines.push(
      'The editor automation tools (get_scene, edit_by_dsl, capture_preview, ...) are also exposed directly; prefer `run` for multi-step work.',
    );
  }
  lines.push(
    '',
    'Effect House edits the open project live, with no sandbox: save before large changes, keep Effect House open while working and avoid running a second agent (such as the built-in Effect House AI panel) on the same project.',
  );
  if (workspace) {
    lines.push(
      `Workspace references live in ${workspace.path}. Relative paths in the guide below (flow/BUILD.md, skills/..., APJS/...) are relative to that folder. Read ${path.join(workspace.path, 'AGENTS.md')} first if the guide below is cut off.`,
    );
  } else {
    lines.push('The kernel workspace could not be prepared; check `instances` for the app installation.');
  }
  if (guide) {
    const adapted = guide.replaceAll('`mcp__eh__run`', 'the `run` tool of this server');
    lines.push(
      '',
      `--- Official workspace guide (AGENTS.md from Effect House ${appVersion ?? ''}) ---`.trim(),
      '',
      adapted.trim(),
    );
  }
  return lines.join('\n');
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.ico',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.mp4',
  '.mov',
  '.glb',
  '.gltf',
  '.fbx',
  '.obj',
  '.onnx',
  '.bin',
  '.zip',
  '.ttf',
  '.otf',
]);

async function looksBinary(file: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export type WorkspaceEntry =
  | { kind: 'directory'; path: string; absolutePath: string; entries: string[]; truncated: boolean }
  | {
      kind: 'file';
      path: string;
      absolutePath: string;
      size: number;
      offset: number;
      nextOffset?: number;
      content: string;
    }
  | { kind: 'binary'; path: string; absolutePath: string; size: number };

/** Reads a file or lists a folder, refusing anything outside the workspace. */
export async function readWorkspaceEntry(
  root: string,
  requested: string,
  options: { offset?: number; maxChars?: number } = {},
): Promise<WorkspaceEntry> {
  const rootReal = await realpath(root);
  const candidate = path.isAbsolute(requested) ? requested : path.join(rootReal, requested || '.');
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new Error(`Not found in the workspace: ${requested}`);
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`Path is outside the workspace: ${requested}`);
  }
  const relative = path.relative(rootReal, real) || '.';
  const info = await stat(real);

  if (info.isDirectory()) {
    const dirents = await readdir(real, { withFileTypes: true });
    const names = dirents
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    const limit = 500;
    return {
      kind: 'directory',
      path: relative,
      absolutePath: real,
      entries: names.slice(0, limit),
      truncated: names.length > limit,
    };
  }
  if (await looksBinary(real)) {
    return { kind: 'binary', path: relative, absolutePath: real, size: info.size };
  }
  const text = await readFile(real, 'utf8');
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const maxChars = Math.min(Math.max(1000, Math.floor(options.maxChars ?? 40_000)), 200_000);
  const end = Math.min(text.length, offset + maxChars);
  return {
    kind: 'file',
    path: relative,
    absolutePath: real,
    size: text.length,
    offset,
    nextOffset: end < text.length ? end : undefined,
    content: text.slice(offset, end),
  };
}
