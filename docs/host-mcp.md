# Host MCP server (`agent-workflow-mcp`)

WP13. A stdio MCP server named `agent-workflow` that lets an agent host (Claude Code, Codex, any MCP
client) run and manage agent-workflow workflows during a conversation. Each tool is a thin call into
one [host API](host-api.md) handler, so results match the `agent-workflow` CLI's `--json` output.
Source: `src/mcp/host-server/` (`tools.ts` tools and schemas, `serve.ts` wiring, `server.ts` entry,
`bin.mjs` launcher). Protocol layer: `src/mcp/stdio-server.ts`, shared with the
[`workflow_artifact` server](mcp.md).

## Start

```
agent-workflow-mcp --host <claude-code|codex|generic>
node <package>/dist/mcp/host-server/server.js --host <claude-code|codex|generic>
```

- `--host` is required and names the calling host. It reaches every handler as
  `HostApiContext.host`; the stage-2 default-executor rule (host's own CLI, WP17) reads it.
- **Project = working directory.** The server's working directory (resolved through symlinks) is its
  project root. Register the server so the host starts it in the project.
- Registration without a plugin (the plugins are WP14/WP15, [plugins.md](plugins.md)):
  `claude mcp add agent-workflow -- agent-workflow-mcp --host claude-code`,
  `codex mcp add agent-workflow -- agent-workflow-mcp --host codex`.
- Exit codes: `2` usage (missing/unknown `--host`, unknown flag), `1` refused to start (a misconfigured
  test-executor hook), `0` on stdin EOF, SIGTERM or SIGINT (in-flight calls answer first; at most 5 s
  after a signal).
- stdout is protocol only; diagnostics go to stderr. The guarded test-executor hook of the CLI
  (`AGENT_WORKFLOW_TEST_EXECUTOR_MODULE` + `..._ACK=test-only`, [cli.md](cli.md)) works the same way.

## Call protocol (server `instructions`)

1. `workflow_list` when the workflow name is uncertain; never guess names.
2. `workflow_run {workflow, task}` (or `workflow_dynamic {task}`) launches and returns the `runId`.
3. `workflow_wait {runId}` waits **at most 45 s** per call (Codex `tool_timeout_sec` defaults to 60 s).
   While `stillRunning` is true, call it again with the same `runId`. `terminal: true` = finished;
   `actionRequired: true` = blocked (report it, use `workflow_inspect`; the user resumes with
   `agent-workflow resume <runId>`).
4. When finished, quote the result preview and give the report paths verbatim; do not paraphrase.
   A result headed `Workflow finished — verdict: X (report ready)` (`verdictGate: true`, footer
   `verdict=X`) is the workflow's result with a non-passing verdict, not a workflow failure (WP18b).
5. No completion push (WP18b): a run reports only through `workflow_wait`/`workflow_status`. If it is
   still running when the host stops waiting (for example a 15-minute rate-limit backoff; the wait
   result's `nextRetry` and the footer's `nextRetryAt=` give the retry time and reason), the host
   tells the user the `runId`, what the run waits for, and that they can ask again.

Permission mode is `free` by default ([permissions.md](permissions.md)); `safe` only on request.
Executor: omit it to use the workflow profile or the host default; set `executor`/`profile` only
when the user asks.

## Tools

Every tool takes an optional `cwd` (see below). Unknown parameters are refused.

| Tool | Arguments | Host API handler | `data` |
|---|---|---|---|
| `workflow_list` | `query?`, `offset?`, `limit?` (1-20, default 20) | `listWorkflowsAction` | `ListData` |
| `workflow_run` | `workflow`, `task`, launch options | `runWorkflowAction` | `LaunchData` |
| `workflow_dynamic` | `task`, launch options | `runDynamicAction` | `LaunchData` |
| `workflow_status` | `runId?` | `statusAction` | `StatusData` |
| `workflow_wait` | `runId`, `timeoutMs?` (1 000-45 000) | `waitAction` | `WaitData` (`terminal`, `actionRequired`, `stillRunning`, `status`, `preview`, `reportArtifacts`, …) |
| `workflow_stop` | `runId` | `stopAction` | `StopData` (`pending` when another supervisor applies it) |
| `workflow_inspect` | `runId`, `failures?`, `results?` | `inspectAction` | `{run, reliability, listed}`; `run` is the run summary plus brief task rows instead of the full run record |
| `workflow_logs` (WP18b) | `runId`, `task?`, `lines?` (1-400, default 20), `stream?` (`output`/`stderr`/`events`/`all`) | `logsAction` | `LogsData` (bounded, redacted tails per task; WP19: only files inside `.agent-workflow/`, tampered or symlinked paths are refused with a reason; structured credentials and Linux/Windows/macOS home paths redacted, also in `workflow_wait`/`workflow_status` text and previews) |
| `workflow_validate` | `workflow` | `validateWorkflowAction` | `ValidateData` |

Launch options (same as the CLI flags and Pi's `aw_run`): `executor`, `profile`, `permissionMode`
(`free`/`safe`), `allowUnverified` (capability keys), `model`, `effort`, `inputs` (declared workflow
inputs), `forceNew`, and `detach`, which **defaults to true** here: MCP calls are time-limited, so a
standalone supervisor (`agent-workflow supervise`, log `<run dir>/supervise.log`) keeps the run going
between calls and after the server exits. `detach: false` keeps the run in the server process only.
A retried identical launch (same workflow, task, inputs and options) while the first run is still
active returns that run with `outcome: "existing"` instead of starting another (WP16 duplicate guard,
`host-api.md`); `forceNew: true` starts a new run. `workflow_logs` (WP18b), `agent-workflow logs` and Pi's
`/aw logs` call the same `logs` handler.

Annotations: `list`, `status`, `inspect`, `logs`, `validate` are read-only; `run`, `dynamic`, `stop` are
destructive; `wait` drives scheduling (not read-only, not destructive). `title` is sent from
`2025-06-18`, `annotations` from `2025-03-26` (same gating as the artifact server).

## Results

- `content`: one text item, the handler's `text` (bounded to 50 000 characters) plus, for run,
  dynamic, wait and a pending stop, a short "next step" footer, for example
  `[workflow_wait] runId=… status=running terminal=false actionRequired=false stillRunning=true` and
  `Next: call workflow_wait {"runId":"…"} again.`
- `structuredContent` (from `2025-06-18`): `{action, ok, outcome, data, text, next?}`; `data` equals
  the host API's (and the CLI `--json`) `data`, except for the inspect projection above.
- **Per host (WP18b):** `--host claude-code` gets the text `content` only, never
  `structuredContent` (`HOST_MCP_TEXT_ONLY_HOSTS`). Evidence: live bundle 4 case 1
  ([live-acceptance-stage2.md](live-acceptance-stage2.md)), Claude Code 2.1.310 handed the model
  the serialized `structuredContent` JSON instead of `content`, so every result reached the model
  twice (`data` and the same `text`). The tools declare no `outputSchema`, so `structuredContent`
  is optional. `codex` and `generic` keep it (Codex's rendering is not observed live yet).
- `isError: true` for a refused launch (`outcome: "refused"`: capability refusal, unavailable
  executor, declined confirmation, an identical launch still starting) and for handler errors:
  `structuredContent: {ok: false, outcome: kind, error: {kind, message}}` with `kind` `usage`
  (`HostUsageError`, text prefixed `Usage error:`), `validation` (invalid spec) or `error` (for
  example an unknown run). Tool-level errors let the model correct the call (MCP guidance).
- JSON-RPC errors only for protocol problems: unknown tool or non-object `arguments` (`-32602`),
  unknown method (`-32601`), requests before `initialize` (`-32600`).
- Worker processes (`AGENT_WORKFLOW_ROLE=worker`) may only `workflow_validate` (host API role check).

## Degradation confirmation (elicitation)

A launch whose capability check needs confirmation (WP4d; for example environment warnings in
`safe` mode):

- If the client declared `capabilities.elicitation` with form mode (`{}` or `{form: …}`) and the
  session is `2025-06-18` or later, the server sends `elicitation/create` with message
  `Proceed with these executor capability degradations?` plus the capability preview and an empty
  form (`requestedSchema: {type: "object", properties: {}}`; `mode: "form"` on `2025-11-25`).
  `accept` proceeds (`capability.confirmation: "confirmed"`); `decline`, `cancel`, an error
  response, a cancelled tool call or a disconnect refuse the launch
  (`CAPABILITY_DEGRADATION_DECLINED`).
- Otherwise (no elicitation, URL-only elicitation, older revision) the launch is non-interactive:
  degradations are recorded (`confirmation: "non-interactive"`) and the run proceeds.

## `cwd`

Optional on every tool. Relative paths resolve against the root. After resolving symlinks the target
must be the root or an existing directory below it; anything else (`..`, an absolute path outside, a
symlink escaping the root, a missing path, a file) is a usage error. Runs launched with a `cwd` live
in that directory's run store (`<cwd>/.agent-workflow/`), so later calls must pass the same `cwd`.

## Cancellation and progress

`notifications/cancelled` for a running call aborts it (for `workflow_wait` only the wait, never the
run) and no response is sent. A `workflow_wait` call with `_meta.progressToken` gets
`notifications/progress` (`progress` counts updates, `message` = completed/total/running).

## Tests

`test/unit/mcp-host-tools.test.mjs` (fake client, in-process: every tool, equality with the host API
and CLI `--json`, wait cap and loop, progress, cancellation, elicitation accept/decline/error/absent,
cwd rule, usage errors, host identity, role check), `mcp-host-sdk-interop.test.mjs` (official SDK
client over stdio with the test-executor hook, including SDK elicitation), `mcp-host-protocol.test.mjs`
(startup arguments, framing and lifecycle), and the E2E case `packed-mcp-host` (packed bin: list →
run → wait loop → inspect).

## Open items

- WP14/WP15 ([plugins.md](plugins.md)): the plugin manifests register
  `agent-workflow-mcp --host claude-code|codex`. Offline checks: both hosts start the plugin
  server in the project directory. Live bundle 4 verified Claude Code (tool names, server cwd;
  it shows `structuredContent` when present, so it gets `content` only since WP18b). Still
  live-only: Codex's tool names in a model turn, whether Codex shows `content` or
  `structuredContent`, and elicitation support in practice.
- WP17: default executor from `ctx.host`; until then an omitted `executor` uses the engine default.
