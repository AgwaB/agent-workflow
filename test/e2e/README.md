# End-to-end tests (`npm run e2e`)

Offline. No model call, no agent CLI, no network, no package install. `run.mjs` builds the package,
packs it once with `npm pack`, unpacks the tarball into a consumer project in a temporary directory
(no `npm install`, no Pi packages, isolated `HOME`, `AGENT_WORKFLOW_HOME`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, XDG directories), and runs every case against that packed artifact. Evidence
(per-step stdout/stderr, the process tree, the consumer's run records, the packed file list,
`report.md`) goes to `.tmp/test-results/e2e/run-*/`.

| Step | What it checks |
|---|---|
| `build`, `diff-check`, `pack`, `unpack` | The package builds and packs; whitespace errors in the diff |
| `forbidden-term-scan` | `forbidden-term-scanner.mjs` over the packed files: no Pi imports or Pi extension APIs or `PI_WORKFLOW_*`/`PI_SUBAGENT_*` names in the Pi-free entry points (`dist/` except `hosts/pi`), no pi-workflow tool names or `.pi/workflows` in the bundled workflows/skills/agents, no local home or temp paths and no secret-shaped values anywhere, no test/tools/internal files, no runtime dependencies |
| `forbidden-term-scanner-self-test` | The scanner reports a planted violation (exit 2) |
| `packed-install` | `cases/packed-install.mjs`: the consumer resolves the package to the tarball and no Pi package; every Pi-free entry point imports; the Pi host refuses to load without Pi; the bin answers `--help`/`--version`; the bundled workflows list, validate and compile with their schemas, helpers and agents; the docs the README links to are packed; only the two launchers ship under `src/`, export/type entries exist, dashboard UI and vendored hashes/notices are present, all bundled highlighting languages/themes work offline, and the native helper retains its hash/executable mode (process identity exercised on macOS/Linux) |
| `packed-cli-run` | `cases/packed-cli-run.mjs`: the packed `agent-workflow` bin runs a bundled-style workflow (`fixtures/e2e-review`: triage → foreach reviewers → support helper → reduce with a projected required read) against `fixtures/e2e-executor.mjs` through the guarded test-executor hook; the executor reads the required artifact through the packed `workflow_artifact` MCP server over stdio. Then `status`, `inspect`, a `safe`-mode detached run waited for from another process, and `stop` of a running detached run |
| `packed-mcp-host` | `cases/packed-mcp-host.mjs` (WP13): the packed `agent-workflow-mcp --host codex` bin over stdio with a raw JSON-RPC client: initialize, tools/list, `workflow_list`, `workflow_run` of `e2e-review` on the E2E test executor (detached by default), the bounded `workflow_wait` loop to completion, `workflow_inspect`, clean exit on EOF |
| `packed-durable-barrier-v2` | `cases/packed-durable-barrier-v2.mjs`: the packed runtime's durable launch barrier v2 — release (READY → decision → ACK → one effect → completed) and revoke after READY (no effect, cancelled/revoked) |
| `no-external-actions` | The process-tree log shows the guard ran, `npm` went through the shim, and no blocked command, network attempt or agent CLI (`pi`, `codex`, `claude`) occurred |

`no-external-actions-guard.mjs` is loaded into every Node process (`NODE_OPTIONS=--import`); it
blocks network connections and package-install, registry, network-fetch and agent-CLI child
processes before they start. `no-external-actions-command-shim.mjs` stands in for `npm`, `npx`,
`pnpm`, `yarn`, `bun`, `curl`, `wget`, `pi`, `codex` and `claude` on `PATH`; only allowed `npm`
subcommands reach the real npm.
