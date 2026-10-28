import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AppInfo } from './app.js';
import type { DocsStore } from './docs.js';
import { FALLBACK_KERNEL_TOOLS, type KernelState } from './kernel.js';
import { log } from './log.js';
import { type HealthResult, type InstanceRecord, liveInstances, type RegistryScan } from './registry.js';
import type { ToolCache } from './toolcache.js';
import { textResult, type Upstream } from './upstream.js';
import { readWorkspaceEntry, type WorkspaceInfo } from './workspace.js';

export interface KernelLike extends Upstream {
  state(): KernelState;
  takeRestartNotice(): string | undefined;
}

export interface BridgeDeps {
  version: string;
  instructions: string;
  workspace?: WorkspaceInfo;
  kernel: KernelLike;
  kernelToolCache?: ToolCache;
  automation?: Upstream;
  docs: Pick<DocsStore, 'search' | 'read'>;
  app: {
    info(): Promise<AppInfo>;
    launch(project?: string): Promise<void>;
    waitForInstance(timeoutMs: number, signal?: AbortSignal): Promise<InstanceRecord | undefined>;
  };
  registry: {
    scan(): Promise<RegistryScan>;
    health(instance: InstanceRecord): Promise<HealthResult>;
    projectStatus(instance: InstanceRecord): Promise<unknown>;
  };
}

const KERNEL_CELL_DEFAULT_MS = 600_000;
const KERNEL_GRACE_MS = 60_000;
const DEFAULT_CALL_MS = 60_000;
const AUTOMATION_CALL_MS = 660_000;
const LIST_TIMEOUT_MS = 20_000;

const LOCAL_TOOLS: Tool[] = [
  {
    name: 'instances',
    description:
      'Find Effect House: the installation and version, every running editor instance (port, heartbeat, health), the project each one has open, the eh kernel state and the workspace folder. Call it first when a cell cannot reach the editor.',
    inputSchema: {
      type: 'object',
      properties: {
        includeProject: {
          type: 'boolean',
          description: 'Ask each live editor which project is open (default true).',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find Effect House', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'launch',
    description:
      "Open Effect House and wait until its automation server answers. With `project` (a project folder or its .ehproj file) the editor opens that project. When Effect House is already running nothing is launched; open projects from a `run` cell with `eh.project.open(path)` instead (see `help('project')`).",
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Absolute path of a project folder (the one holding effect.ehproj) or of its .ehproj file.',
        },
        waitSeconds: {
          type: 'number',
          minimum: 5,
          maximum: 300,
          description: 'How long to wait for the editor to answer (default 90).',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Open Effect House',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'docs_search',
    description:
      'Search the official Effect House documentation at effecthouse.tiktok.com/learn (getting started, workspace objects and components, editor panels, Visual Scripting nodes, APJS API reference, tutorials, publishing). Matches page paths and, for pages already read or indexed, titles and text. Returns URLs to pass to `docs_read`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, in English, e.g. "face mesh", "tween animation".' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum results (default 10).' },
        section: {
          type: 'string',
          description:
            'Restrict to a section path such as `api-reference`, `workspace/components` or `editor-panels/visual-scripting`.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search Effect House docs', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'docs_read',
    description:
      'Read one official Effect House documentation page as Markdown. Accepts a full URL or a path under /learn/, for example `guides/api-reference/scene/transform`. Long pages are paged with `offset`.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL or path under https://effecthouse.tiktok.com/learn/.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to continue a long page.' },
        maxChars: {
          type: 'integer',
          minimum: 2000,
          maximum: 60000,
          description: 'Characters to return (default 20000).',
        },
        refresh: { type: 'boolean', description: 'Fetch again instead of using the cached copy.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'Read an Effect House docs page', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'workspace_read',
    description:
      'Read a file or list a folder of the eh kernel workspace: AGENTS.md, flow/, skills/, APJS/ declarations, reference/, Planning/. Paths are relative to the workspace root, or absolute inside it. Use it when your client cannot read local files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or folder, e.g. `skills/vfx/SKILL.md` (default: the root).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to continue a long file.' },
        maxChars: {
          type: 'integer',
          minimum: 1000,
          maximum: 200000,
          description: 'Characters to return (default 40000).',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Read the kernel workspace', readOnlyHint: true, openWorldHint: false },
  },
];

const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((tool) => tool.name));
const RUN_NOTE =
  '\n\n(Bridge note: Effect House must be open. `instances` shows the editor the next cell uses; `launch` opens it.)';

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A project is a folder holding an `.ehproj` file; the editor opens that file. */
export async function findProjectFile(input: string): Promise<string> {
  const info = await stat(input).catch(() => undefined);
  if (!info) throw new Error(`Project not found: ${input}`);
  if (info.isFile()) {
    if (path.extname(input).toLowerCase() !== '.ehproj') {
      throw new Error(`Not an Effect House project (.ehproj): ${input}`);
    }
    return input;
  }
  const files = (await readdir(input)).filter((name) => name.toLowerCase().endsWith('.ehproj')).sort();
  const file = files.includes('effect.ehproj') ? 'effect.ehproj' : files[0];
  if (!file) throw new Error(`No .ehproj file in ${input}; is it an Effect House project folder?`);
  return path.join(input, file);
}

function summarize(instance: InstanceRecord) {
  return {
    name: instance.name,
    pid: instance.pid,
    port: instance.port,
    mcpUrl: instance.mcpUrl,
    appVersion: instance.appVersion,
    agentMode: instance.agentMode,
    startedAt: instance.startedAt,
    heartbeatAgeMs: instance.heartbeatAgeMs,
    alive: instance.alive,
    stale: instance.stale,
  };
}

export class Bridge {
  readonly server: Server;
  private kernelTools?: Tool[];
  private automationTools: Tool[] = [];
  private automationSignature = '';

  constructor(private readonly deps: BridgeDeps) {
    this.server = new Server(
      { name: 'effect-house-mcp', version: deps.version },
      { capabilities: { tools: { listChanged: true } }, instructions: deps.instructions },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.callTool(request.params.name, request.params.arguments ?? {}, extra.signal),
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.deps.kernel.close(), this.deps.automation?.close(), this.server.close()]);
  }

  private async loadKernelTools(): Promise<Tool[]> {
    if (this.kernelTools) return this.kernelTools;
    const cached = await this.deps.kernelToolCache?.load();
    if (cached) {
      this.kernelTools = cached;
      return cached;
    }
    try {
      const tools = await withTimeout(this.deps.kernel.listTools(), LIST_TIMEOUT_MS, 'Listing the eh kernel tools');
      this.kernelTools = tools;
      await this.deps.kernelToolCache?.save(tools).catch((error) => log('warn', 'could not cache kernel tools', error));
      return tools;
    } catch (error) {
      log('warn', 'eh kernel unavailable; listing fallback tool definitions', error);
      return FALLBACK_KERNEL_TOOLS;
    }
  }

  /** After a kernel call the live list is at hand: refresh the cache if the kernel changed. */
  private async syncKernelTools(): Promise<void> {
    try {
      const live = await withTimeout(this.deps.kernel.listTools(), LIST_TIMEOUT_MS, 'Listing the eh kernel tools');
      if (JSON.stringify(live) === JSON.stringify(this.kernelTools)) return;
      this.kernelTools = live;
      await this.deps.kernelToolCache?.save(live);
      await this.server.sendToolListChanged().catch(() => {});
    } catch {
      // Keep the current list.
    }
  }

  private async refreshAutomationTools(): Promise<void> {
    if (!this.deps.automation) return;
    try {
      const tools = await withTimeout(this.deps.automation.listTools(), 5000, 'Listing the automation tools');
      const taken = new Set([...LOCAL_NAMES, ...(this.kernelTools ?? FALLBACK_KERNEL_TOOLS).map((tool) => tool.name)]);
      this.automationTools = tools.filter((tool) => {
        if (!taken.has(tool.name)) return true;
        log('warn', `automation tool ${tool.name} hidden: the name is already used`);
        return false;
      });
    } catch (error) {
      log('debug', 'automation tools unavailable', error);
    }
    const signature = this.automationTools.map((tool) => tool.name).join(',');
    if (signature !== this.automationSignature) {
      const changed = this.automationSignature !== '';
      this.automationSignature = signature;
      if (changed) await this.server.sendToolListChanged().catch(() => {});
    }
  }

  async listTools(): Promise<Tool[]> {
    const kernelTools = (await this.loadKernelTools()).map((tool) =>
      tool.name === 'run' ? { ...tool, description: `${tool.description ?? ''}${RUN_NOTE}` } : tool,
    );
    await this.refreshAutomationTools();
    return [...LOCAL_TOOLS, ...kernelTools, ...this.automationTools];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      switch (name) {
        case 'instances':
          return await this.instances(args.includeProject !== false);
        case 'launch':
          return await this.launch(args, signal);
        case 'docs_search':
          return await this.docsSearch(args);
        case 'docs_read':
          return await this.docsRead(args);
        case 'workspace_read':
          return await this.workspaceRead(args);
      }
      const kernelNames = new Set((this.kernelTools ?? FALLBACK_KERNEL_TOOLS).map((tool) => tool.name));
      if (kernelNames.has(name)) return await this.callKernel(name, args, signal);
      if (this.deps.automation) {
        if (!this.automationTools.some((tool) => tool.name === name)) await this.refreshAutomationTools();
        if (this.automationTools.some((tool) => tool.name === name)) {
          return await this.deps.automation.callTool(name, args, { signal, timeoutMs: AUTOMATION_CALL_MS });
        }
      }
      return textResult(`Unknown tool: ${name}`, true);
    } catch (error) {
      return textResult(`${name} failed: ${message(error)}`, true);
    }
  }

  private async callKernel(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (name === 'run') {
      const scan = await this.deps.registry.scan();
      if (scan.exists && liveInstances(scan).length === 0) {
        return textResult(
          `Effect House is not open: no live editor in the instance registry (${scan.dir}). Call \`launch\` (or open Effect House), then run the cell again.`,
          true,
        );
      }
    }
    const cellMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : KERNEL_CELL_DEFAULT_MS;
    const timeoutMs = name === 'run' ? cellMs + KERNEL_GRACE_MS : DEFAULT_CALL_MS;
    let result: CallToolResult;
    try {
      result = await this.deps.kernel.callTool(name, args, { signal, timeoutMs });
    } catch (error) {
      const tail = this.deps.kernel.state().stderrTail.slice(-10);
      return textResult(
        [
          `The eh kernel call \`${name}\` failed: ${message(error)}`,
          'Check `instances` (is Effect House installed and open?). The kernel is started again on the next call.',
          tail.length ? `Kernel stderr (last lines):\n${tail.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        true,
      );
    }
    const notice = this.deps.kernel.takeRestartNotice();
    void this.syncKernelTools();
    if (!notice) return result;
    return { ...result, content: [{ type: 'text', text: `[effect-house-mcp] ${notice}` }, ...(result.content ?? [])] };
  }

  private async instances(includeProject: boolean): Promise<CallToolResult> {
    const [app, scan] = await Promise.all([this.deps.app.info(), this.deps.registry.scan()]);
    const live = new Set(liveInstances(scan));
    const instances = await Promise.all(
      scan.instances.map(async (instance) => {
        const entry: Record<string, unknown> = summarize(instance);
        if (!live.has(instance)) return entry;
        const health = await this.deps.registry.health(instance);
        entry.health = health;
        if (health.ok && includeProject) {
          entry.project = await withTimeout(this.deps.registry.projectStatus(instance), 6000, 'project_status').catch(
            (error) => ({ error: message(error) }),
          );
        }
        return entry;
      }),
    );
    const hints: string[] = [];
    if (!app.installed)
      hints.push(`Effect House was not found at ${app.appPath}; set EH_APP_PATH (or EH_EXECUTABLE_DIR).`);
    else if (!app.ehFrontExists)
      hints.push(`This Effect House has no eh kernel front (${app.ehFrontPath}); version 5.16 or later is needed.`);
    if (live.size === 0) hints.push('Effect House is not running: call `launch`.');
    if (live.size > 1)
      hints.push(
        'Several editors are open; cells go to the one the kernel picks from the registry. Set EH_PROJECT to pin a project.',
      );
    await this.refreshAutomationTools();
    return textResult({
      bridge: { version: this.deps.version, automationTools: Boolean(this.deps.automation) },
      app,
      registry: { dir: scan.dir, exists: scan.exists, errors: scan.errors },
      instances,
      kernel: this.deps.kernel.state(),
      workspace: this.deps.workspace ?? null,
      hints,
    });
  }

  private async launch(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const project =
      typeof args.project === 'string' && args.project.trim() ? path.resolve(args.project.trim()) : undefined;
    const waitSeconds = Math.min(Math.max(typeof args.waitSeconds === 'number' ? args.waitSeconds : 90, 5), 300);
    let projectFile: string | undefined;
    if (project) {
      try {
        projectFile = await findProjectFile(project);
      } catch (error) {
        return textResult(message(error), true);
      }
    }
    const [running] = liveInstances(await this.deps.registry.scan());
    if (running) {
      return textResult({
        launched: false,
        alreadyRunning: true,
        instance: summarize(running),
        note: projectFile
          ? `Effect House is already running, so the project was not opened from here. Open it from a cell: \`return await eh.project.open(${JSON.stringify(path.dirname(projectFile))})\`.`
          : 'Effect House is already running.',
      });
    }
    const app = await this.deps.app.info();
    if (!app.installed) return textResult(`Effect House was not found at ${app.appPath}; set EH_APP_PATH.`, true);
    const started = Date.now();
    await this.deps.app.launch(projectFile);
    const instance = await this.deps.app.waitForInstance(waitSeconds * 1000, signal);
    if (!instance) {
      return textResult(
        `Effect House was started but did not answer within ${waitSeconds} s. It may still be loading or waiting on a dialog (login, update). Call \`instances\` to check again.`,
        true,
      );
    }
    await this.refreshAutomationTools();
    return textResult({
      launched: true,
      project: projectFile ?? null,
      elapsedMs: Date.now() - started,
      instance: summarize(instance),
    });
  }

  private async docsSearch(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return textResult('`query` is required.', true);
    const result = await this.deps.docs.search(query, {
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      section: typeof args.section === 'string' ? args.section : undefined,
    });
    return textResult({
      query,
      ...result,
      note:
        result.indexedPages < result.totalPages
          ? `Titles and text are searched for ${result.indexedPages} of ${result.totalPages} pages (the ones read so far); the rest match on their URL path.`
          : undefined,
    });
  }

  private async docsRead(args: Record<string, unknown>): Promise<CallToolResult> {
    if (typeof args.url !== 'string' || !args.url.trim()) return textResult('`url` is required.', true);
    const page = await this.deps.docs.read(args.url, { refresh: args.refresh === true });
    const offset = Math.max(0, Math.floor(typeof args.offset === 'number' ? args.offset : 0));
    const maxChars = Math.min(
      Math.max(Math.floor(typeof args.maxChars === 'number' ? args.maxChars : 20_000), 2000),
      60_000,
    );
    const end = Math.min(page.markdown.length, offset + maxChars);
    const range =
      offset > 0 || end < page.markdown.length
        ? ` · characters ${offset}–${end} of ${page.markdown.length}${end < page.markdown.length ? ` · continue with offset ${end}` : ''}`
        : '';
    return textResult(`Source: ${page.url} (fetched ${page.fetchedAt})${range}\n\n${page.markdown.slice(offset, end)}`);
  }

  private async workspaceRead(args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.deps.workspace) return textResult('The kernel workspace is not available; see `instances`.', true);
    const entry = await readWorkspaceEntry(this.deps.workspace.path, typeof args.path === 'string' ? args.path : '.', {
      offset: typeof args.offset === 'number' ? args.offset : undefined,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
    });
    if (entry.kind !== 'file') return textResult(entry);
    const more = entry.nextOffset !== undefined ? ` · continue with offset ${entry.nextOffset}` : '';
    return textResult(
      `File: ${entry.absolutePath} (${entry.size} characters, from ${entry.offset}${more})\n\n${entry.content}`,
    );
  }
}
