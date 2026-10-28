#!/usr/bin/env node
// Live check against a running Effect House: starts the built bridge over
// stdio like an agent host would and calls each tool family once, read-only.
// Usage: npm run build && npm run smoke

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, EH_MCP_LOG_LEVEL: process.env.EH_MCP_LOG_LEVEL ?? 'warn' },
  stderr: 'inherit',
});
const client = new Client({ name: 'effect-house-mcp-smoke', version: '0.0.0' });

const failures = [];
function text(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
async function step(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`ok   ${label} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label}: ${error.message}`);
  }
}
async function call(name, args = {}, timeout = 120_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (result.isError) throw new Error(text(result).slice(0, 600));
  return result;
}

await client.connect(transport);
const instructions = client.getInstructions() ?? '';

await step('instructions', async () => {
  if (!instructions.includes('`run`')) throw new Error('instructions do not mention the run tool');
  return `${instructions.length} chars`;
});

await step('tools/list', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const wanted of [
    'instances',
    'launch',
    'docs_search',
    'docs_read',
    'workspace_read',
    'run',
    'reset',
    'status',
  ]) {
    if (!names.includes(wanted)) throw new Error(`missing ${wanted}`);
  }
  return names.join(', ');
});

let running = false;
await step('instances', async () => {
  const report = JSON.parse(text(await call('instances')));
  running = report.instances.some((instance) => instance.health?.ok);
  const open = report.instances.find((instance) => instance.project)?.project;
  return `app ${report.app.version}, ${report.instances.length} instance(s), running=${running}, project=${JSON.stringify(open ?? null)}`;
});

await step('status (kernel)', async () =>
  text(await call('status'))
    .replace(/\s+/g, ' ')
    .slice(0, 160),
);

await step('run: eh.project.status()', async () => {
  if (!running) return 'skipped: Effect House is not running';
  return text(await call('run', { code: 'return await eh.project.status()' }, 180_000))
    .split('\n')[0]
    .slice(0, 200);
});

await step('workspace_read skills/', async () => {
  const listing = JSON.parse(text(await call('workspace_read', { path: 'skills' })));
  return `${listing.entries.length} entries`;
});

let firstUrl;
await step('docs_search "face mesh"', async () => {
  const result = JSON.parse(text(await call('docs_search', { query: 'face mesh', limit: 3 })));
  firstUrl = result.hits[0]?.url;
  if (!firstUrl) throw new Error('no hits');
  return `${result.totalPages} pages, top: ${firstUrl}`;
});

await step('docs_read top hit', async () => {
  const body = text(await call('docs_read', { url: firstUrl, maxChars: 2000 }));
  return body.split('\n').slice(0, 3).join(' | ').slice(0, 200);
});

await client.close();
if (failures.length) {
  console.log(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nsmoke passed');
