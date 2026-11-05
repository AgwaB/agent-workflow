# Documentation index

## Using agent-workflow

| Document | Content |
|---|---|
| [usage.md](usage.md) | Running and authoring workflows, profiles, artifacts, run records and troubleshooting |
| [cli.md](cli.md) | CLI commands, launch options and exit codes |
| [dashboard.md](dashboard.md) | Local web dashboard, controls and security |
| [host-mcp.md](host-mcp.md) | MCP server for Claude Code and Codex: tools, call protocol and confirmation |
| [plugins.md](plugins.md) | Claude Code and Codex plugin installation and host integration |
| [pi-host.md](pi-host.md) | Pi `/aw` commands, tools, waits, confirmation and notices |
| [permissions.md](permissions.md) | Permission modes `free` (default) and `safe` |
| [support.md](support.md) | Supported hosts and executors, CLI versions and known limits |
| [environment.md](environment.md) | Environment variables and defaults |
| [bundled-workflows.md](bundled-workflows.md) | Bundled workflows, skills and agents |

## Executors

| Document | Content |
|---|---|
| [executors/pi.md](executors/pi.md) | Pi invocation, isolation, tools, MCP and limits |
| [executors/codex.md](executors/codex.md) | Codex app-server executor |
| [executors/claude.md](executors/claude.md) | Claude Code stream-json executor |
| [executors/acp.md](executors/acp.md) | ACP executor and experimental Antigravity preset |

## Extending and integrating

| Document | Content |
|---|---|
| [sdk.md](sdk.md) | Executor adapter contract, capabilities, events and errors |
| [conformance.md](conformance.md) | Executor conformance kit and check catalog |
| [host-api.md](host-api.md) | Shared host API handlers |
| [mcp.md](mcp.md) | Artifact MCP server, read ledger, paging and delivery limits |
| [architecture.md](architecture.md) | Engine layers, durable workers, launch barrier and data layout |

## Tests

| Command | What runs |
|---|---|
| `npm run validate` | Script/release/public-surface checks, formatting, typecheck, unit tests (offline) |
| `npm run e2e` | Packs the package and runs it from an isolated install with a no-external-actions guard (offline; `test/e2e/`) |
| `npm run pack:dry` | Lists the files the package would publish |
