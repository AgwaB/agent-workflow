# Documentation index

## Using agent-workflow

| Document | Content |
|---|---|
| [`../README.md`](../README.md) | What agent-workflow is, install, quick start, permission modes, executors |
| [`usage.md`](usage.md) | Workflows and specs, running, waiting, resuming, stopping, profiles, permission modes, capability preview, stage model and authoring, artifacts and required reads, run records, troubleshooting |
| [`cli.md`](cli.md) | `agent-workflow` CLI reference: commands, launch options, exit codes, test-executor hook |
| [`host-mcp.md`](host-mcp.md) | Host MCP server `agent-workflow-mcp` for Claude Code / Codex: tools, call protocol, `--host`, `cwd` rule, elicitation |
| [`plugins.md`](plugins.md) | Claude Code and Codex plugin: install, `mcp add` alternative, local dev plugin, timeouts, tool names, validation evidence |
| [`pi-host.md`](pi-host.md) | Pi host: `/aw` command, `aw_*` tools, install, confirmation, session-start notices |
| [`permissions.md`](permissions.md) | Permission modes `free` (default) and `safe`: behavior, selection, per-adapter mapping |
| [`support.md`](support.md) | Support matrix (live and offline), verified CLI versions, known limits per executor |
| [`environment.md`](environment.md) | Every `AGENT_WORKFLOW_*` environment variable |
| [`bundled-workflows.md`](bundled-workflows.md) | Bundled workflows, skills and agents: provenance, migration changes, generated offline support table |
| [`../workflows/README.md`](../workflows/README.md) | The bundled workflows in detail |

## Executors

| Document | Content |
|---|---|
| [`executors/pi.md`](executors/pi.md) | Pi executor: invocation, isolation, tool mapping, MCP, capabilities, errors, limits |
| [`executors/codex.md`](executors/codex.md) | Codex executor (`codex app-server`) |
| [`executors/claude.md`](executors/claude.md) | Claude Code executor (`claude -p` stream-json) |

## Extending and integrating

| Document | Content |
|---|---|
| [`sdk.md`](sdk.md) | Writing an executor adapter: contract, execution authority, capabilities, events, errors, descriptors, permission modes, MCP |
| [`conformance.md`](conformance.md) | Executor conformance kit: tiers, harness contract, check catalog |
| [`host-api.md`](host-api.md) | Host API handlers shared by every host |
| [`mcp.md`](mcp.md) | The `workflow_artifact` MCP server: protocol, read ledger, paged reads, delivery limits |
| [`architecture.md`](architecture.md) | Layers, durable worker, launch barrier, control mailbox, data layout |

## Port and maintenance records

How the code was ported from pi-workflow and pi-subagent, and how stage 1 was accepted.

| Document | Content |
|---|---|
| [`core-port.md`](core-port.md) | Core port from pi-workflow 0.16.4: module and test tables, renames, behavior changes |
| [`runtime-port.md`](runtime-port.md) | Runtime port from pi-subagent 0.7.2: executor seam, durable worker, control channel |
| [`replay.md`](replay.md) | Replay acceptance of recorded pi-workflow runs |
| [`live-acceptance-stage1.md`](live-acceptance-stage1.md) | Live stage-1 acceptance: bundled workflows × executors, evidence, failures and fixes, open problems |

## Tests

| Command | What runs |
|---|---|
| `npm run validate` | Script/release/public-surface checks, formatting, typecheck, unit tests (offline) |
| `npm run e2e` | Packs the package and runs it from an isolated install with a no-external-actions guard (offline; `test/e2e/`) |
| `npm run pack:dry` | Lists the files the package would publish |
