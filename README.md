# effect-house-mcp

**English** · [Português](README.pt-BR.md)

An **unofficial** MCP (Model Context Protocol) server that connects Claude Code, Codex and any other MCP client to
**TikTok Effect House**, so you can build and edit effects by conversation from your own AI sessions.

> Not affiliated with or endorsed by TikTok. It relies on internal, undocumented interfaces of Effect House 5.16 that
> may change with any app update. Effect House and TikTok are trademarks of their respective owners.

## Why it exists

Since version 5.16, Effect House includes an AI assistant (the **Effect House AI** panel) that launches Claude Code,
Codex or Cursor inside the app. Under the hood it relies on two local components, which this project reuses:

- **The `eh` kernel** (`Contents/MacOS/eh_front`): a stdio MCP server whose `run` tool executes JavaScript cells with
  an `eh` API already connected to the editor (scene, APJS scripts, assets, preview, screenshots, planning). It finds
  the editor on its own before every cell, so it survives app restarts.
- **The automation server** (HTTP on `127.0.0.1`, port announced in
  `~/Library/Application Support/EffectHouse/Instances/*/MCP/mcp_port.json`): 33 high-level tools
  (`get_scene`, `edit_by_dsl`, `capture_preview`, `generate_image`…).

The official docs only cover the in-app panel, which runs one agent at a time inside Effect House. This bridge lets
you use the same capabilities from outside: from your own sessions, with your skills, memory and other MCP servers
(Blender, image generation and so on).

## What the bridge adds

| Tool | What it does |
| --- | --- |
| `run`, `reset`, `status` | The official `eh` kernel, forwarded unchanged (text, images and errors). |
| `instances` | App install and version, running editors (port, heartbeat, health), the open project, kernel state and workspace folder. |
| `launch` | Opens Effect House (optionally with a project) and waits until it answers. Never starts a second editor. |
| `docs_search`, `docs_read` | Search and read the official docs at [effecthouse.tiktok.com/learn](https://effecthouse.tiktok.com/learn/) (every page in the sitemap), converted to Markdown and cached. |
| `workspace_read` | Reads the kernel references (skills, APJS declarations, planning flows) for clients that cannot read local files. |
| Automation tools | Optional (`EH_MCP_AUTOMATION_TOOLS=1`): the 33 HTTP tools exposed directly. Off by default: they add ~70 KB of tool definitions and the kernel already reaches them. |

The bridge also:

- reads the official workspace guide (`AGENTS.md`) of the installed version and serves it as the MCP server
  `instructions`;
- keeps its own copy of the kernel workspace in `~/Library/Application Support/effect-house-mcp/workspace`, without the
  app's agent-host config files, and refreshes it when Effect House is updated;
- restarts the kernel if it exits and says that `session` values were lost;
- refuses `run` with a clear message when Effect House is not open.

## Requirements

- macOS (tested on Apple Silicon). Other systems need the environment variables below and are untested.
- Effect House **5.16 or later**, installed and signed in.
- Node.js 20 or later.

## Install

```bash
git clone https://github.com/jepharaujo/effect-house-mcp.git
cd effect-house-mcp
npm ci
npm run build
npm run doctor
```

`doctor` prints what the bridge found: the app, its version, running instances and the workspace. It exits with code 1
when something essential is missing.

### Claude Code

Run this from the project folder (the absolute paths of Node and the server are stored in the registration):

```bash
claude mcp add effect-house -s user -- "$(which node)" "$(pwd)/dist/src/index.js"
```

A cell may take up to 10 minutes (building a scene, a script and a playtest in one call). If Claude Code stops long
calls earlier, raise the limit with `MCP_TOOL_TIMEOUT=660000`.

### Codex

In `~/.codex/config.toml`, with the paths of your machine (`which node` and the project folder):

```toml
[mcp_servers.effect-house]
command = "/opt/homebrew/bin/node"
args = ["/path/to/effect-house-mcp/dist/src/index.js"]
startup_timeout_sec = 30
# A cell may run up to the kernel's 10-minute limit.
tool_timeout_sec = 660
```

### Other clients

Any stdio MCP client: command `node`, argument `dist/src/index.js`. Desktop apps usually need the absolute path of Node.

## Usage

With Effect House open, ask your agent something like “open a new project and make a freckles face effect”. The agent
follows the official guide: it checks the project with `eh.project.status()`, fills and validates a plan
(`eh.plan.fromTemplate` / `eh.plan.validate`), builds the scene and verifies it with preview captures.

A cell for `run`:

```js
const status = await eh.project.status();
const scene = await eh.scene.getScene();
return { status, scene };
```

`help()` inside a cell lists the whole API (`help('scene')`, `help('EHObject')`, `help('preview.screenshot')`).

## Things to keep in mind

- The agent edits **the open project, live**, with no sandbox. Save before large changes.
- Use one agent at a time: do not run the Effect House AI panel and this bridge on the same project at once.
- Preview captures go to your client's AI provider, like any image the agent reads.
- Effect House requires a validated plan before building a scene; that rule comes from the official kernel and the
  bridge keeps it.
- `docs_read` only fetches pages under `effecthouse.tiktok.com/learn/`; the bridge only talks to the editor on
  `127.0.0.1`.

## Environment variables

| Variable | Use |
| --- | --- |
| `EH_APP_PATH` | App path (default: `/Applications/Effect House.app`, or what the app recorded in its `app.json`). |
| `EH_EXECUTABLE_DIR`, `EH_FRONT_PATH`, `EH_WORKSPACE_TEMPLATE`, `EH_SUPPORT_DIR` | Individual paths, for non-standard installs or other systems. |
| `EH_PROJECT` | Pins the kernel to the editor that has this project open (useful with several editors). |
| `EH_MCP_AUTOMATION_TOOLS=1` | Also exposes the editor's automation tools. |
| `EH_MCP_STATE_DIR`, `EH_MCP_CACHE_DIR` | Where the workspace copy and the docs cache live. |
| `EH_MCP_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`; logs go to stderr. |

## Architecture

```text
MCP client (Claude Code, Codex…)
        │ stdio
        ▼
effect-house-mcp ──────────────► docs: effecthouse.tiktok.com/learn (sitemap + cache)
   │        │
   │ stdio  │ HTTP (127.0.0.1, port from the instance registry)
   ▼        ▼
eh_front ─► eh kernel ─────────► Effect House automation server ─► open editor
```

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point and CLI (`serve`, `doctor`, `index-docs`). |
| `src/server.ts` | MCP server: lists and routes tools, the bridge's own tools. |
| `src/kernel.ts` | `eh_front` client: lazy start, restart, stderr kept for diagnostics. |
| `src/automation.ts` | Client of the editor's HTTP server; retries a call only when the connection was refused. |
| `src/registry.ts` | Instance registry, heartbeat and health check. |
| `src/workspace.ts` | Workspace copy, server instructions and `workspace_read` (never outside the folder). |
| `src/docs.ts`, `src/html.ts` | Sitemap, search, cache and HTML → Markdown conversion of the docs. |
| `src/toolcache.ts` | Remembers the kernel tool list per version, so listing tools does not start the kernel. |

## Development

```bash
npm run check        # lint (Biome), types and unit tests
npm run smoke        # live, read-only check with Effect House open (run npm run build first)
npm run docs:index   # cache every docs page for full-text search
```

Unit tests do not need Effect House. `smoke` starts the bridge the way an MCP client would and calls each tool family.

Tested with Effect House 5.16.0 on macOS (Apple Silicon), Node.js 25 and Claude Code. Issues and pull requests are
welcome, especially reports from other Effect House versions.

## Troubleshooting

- **"Effect House is not open"**: open the app or call `launch`; check with `instances`.
- **The kernel does not start**: `npm run doctor` should show `ehFrontExists: true`. Versions before 5.16 have no kernel.
- **Several editors open**: set `EH_PROJECT` to the folder of the project the agent should use.
- **Docs search matches only URLs**: full text joins the index as pages are read, or all at once with
  `npm run docs:index`.

## License

[MIT](LICENSE).
