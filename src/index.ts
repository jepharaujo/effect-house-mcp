#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getAppInfo, launchApp, waitForInstance } from './app.js';
import { AutomationUpstream, callAutomationOnce, resultJson } from './automation.js';
import { type Config, loadConfig } from './config.js';
import { DocsStore } from './docs.js';
import { KernelUpstream } from './kernel.js';
import { log } from './log.js';
import { checkHealth, liveInstances, scanRegistry } from './registry.js';
import { Bridge } from './server.js';
import { ToolCache } from './toolcache.js';
import { buildInstructions, prepareWorkspace, readGuide, type WorkspaceInfo } from './workspace.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const USAGE = `effect-house-mcp ${version} — unofficial MCP bridge to TikTok Effect House

Usage:
  effect-house-mcp              serve MCP over stdio (what agent hosts run)
  effect-house-mcp doctor       print what the bridge finds (app, instances, workspace)
  effect-house-mcp index-docs   cache every official docs page for full-text search
  effect-house-mcp --version

Environment (all optional):
  EH_APP_PATH, EH_EXECUTABLE_DIR, EH_FRONT_PATH, EH_SUPPORT_DIR, EH_WORKSPACE_TEMPLATE
  EH_PROJECT                 pin the kernel to the editor that has this project open
  EH_MCP_AUTOMATION_TOOLS=1  also expose the editor's automation tools directly
  EH_MCP_STATE_DIR, EH_MCP_CACHE_DIR, EH_MCP_LOG_LEVEL=debug|info|warn|error
`;

function docsStore(config: Config): DocsStore {
  return new DocsStore({
    cacheDir: config.cacheDir,
    userAgent: `effect-house-mcp/${version} (documentation reader)`,
  });
}

async function workspaceFor(config: Config, appVersion?: string): Promise<WorkspaceInfo | undefined> {
  try {
    return await prepareWorkspace(config.workspaceTemplate, config.stateDir, appVersion);
  } catch (error) {
    log('error', 'could not prepare the kernel workspace', error);
    return undefined;
  }
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const app = await getAppInfo(config);
  const workspace = await workspaceFor(config, app.version);
  const guide = workspace ? await readGuide(workspace.path) : undefined;

  const kernelArgs = [
    ...(workspace ? ['--workspace', workspace.path] : []),
    ...(config.pinnedProject ? ['--project', config.pinnedProject] : []),
  ];
  const kernel = new KernelUpstream({
    command: config.ehFrontPath,
    args: kernelArgs,
    cwd: workspace?.path,
    clientVersion: version,
  });

  const bridge = new Bridge({
    version,
    instructions: buildInstructions({
      workspace,
      guide,
      appVersion: app.version,
      automationTools: config.automationTools,
    }),
    workspace,
    kernel,
    kernelToolCache: workspace ? ToolCache.in(config.stateDir, `${version}|${workspace.fingerprint}`) : undefined,
    automation: config.automationTools ? new AutomationUpstream(config.supportDir, version) : undefined,
    docs: docsStore(config),
    app: {
      info: () => getAppInfo(config),
      launch: (project) => launchApp(config, project),
      waitForInstance: (timeoutMs, signal) => waitForInstance(config, timeoutMs, { signal }),
    },
    registry: {
      scan: () => scanRegistry(config.supportDir),
      health: (instance) => checkHealth(instance),
      projectStatus: async (instance) =>
        resultJson(
          await callAutomationOnce(
            instance,
            'project_status',
            { intention: 'effect-house-mcp: report which project is open' },
            { clientVersion: version },
          ),
        ),
    },
  });

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    log('info', `shutting down (${reason})`);
    await bridge.close();
    process.exit(0);
  };
  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('client disconnected');
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await bridge.server.connect(transport);
  log(
    'info',
    `ready (Effect House ${app.version ?? 'not found'}, workspace ${workspace?.path ?? 'unavailable'}${config.automationTools ? ', automation tools on' : ''})`,
  );
}

async function doctor(): Promise<number> {
  const config = loadConfig();
  const app = await getAppInfo(config);
  const scan = await scanRegistry(config.supportDir);
  const live = liveInstances(scan);
  const health = await Promise.all(
    live.map(async (instance) => ({ name: instance.name, ...(await checkHealth(instance)) })),
  );
  const workspace = await workspaceFor(config, app.version);
  const report = { version, config, app, registry: scan, health, workspace };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return app.installed && app.ehFrontExists && workspace ? 0 : 1;
}

async function indexDocs(): Promise<number> {
  const store = docsStore(loadConfig());
  const { fetched, failed } = await store.indexAll((done, total, url, error) => {
    if (error || done % 25 === 0 || done === total) {
      process.stderr.write(`${done}/${total}${error ? ` failed ${url}: ${error}` : ''}\n`);
    }
  });
  process.stderr.write(`Cached ${fetched} new pages${failed ? `, ${failed} failed` : ''}.\n`);
  return failed > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case undefined:
    case 'serve':
      await serve();
      return;
    case 'doctor':
      process.exitCode = await doctor();
      return;
    case 'index-docs':
      process.exitCode = await indexDocs();
      return;
    case '--version':
    case '-v':
      process.stdout.write(`${version}\n`);
      return;
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  log('error', 'fatal', error);
  process.exit(1);
});
