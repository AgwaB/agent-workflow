# ACP executor

Entry point: `@agwab/agent-workflow/executors/acp`; source: `src/executors/acp/`.
Use `createExecutor(config)` or the typed `createAcpExecutor({ config, faults })`.
Adapter and SDK contract version: `0.1.0`; ACP protocol version: **1**.
`config.preset` selects the agent and executor id.

**Antigravity** is built in (`--executor antigravity`), verified with **agy_acp_server 1.4.5** and
`gemini-3.8-flash` (low). Live readOnly, tool-allowlist, isolation and artifact-MCP checks pass;
resume/session-ownership checks skip because those capabilities are none. Capabilities remain
`declared`. **Gemini CLI** (`gemini --acp`) is a pilot preset without a verified live CLI version.
Offline and runtime conformance use a scripted ACP agent.

## Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `preset` | `gemini` | Agent preset and executor id |
| `command` | `gemini` or `agy_acp_server`; Antigravity checks `$AGENT_WORKFLOW_AGY_ACP_SERVER` first | Executable |
| `agentHome` | `<stateDir>/<preset>-home` | Engine-owned login home for presets supporting isolation |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/acp` (`~/.agent-workflow/…`) | Attempt records |
| `killGraceMs` | `2000` | Grace between stdin close, SIGTERM and SIGKILL |
| `handshakeTimeoutMs` | `60000` | Bound for `initialize` and `session/new` |

Unknown keys fail with `DESCRIPTOR_INVALID`. Keep secrets in request/MCP environment, not descriptor
config. The built-in descriptor is
`{ id: "antigravity", module: <dist>/executors/acp/index.js, config: { preset: "antigravity" } }`.
To use Gemini, register in process:

```js
registerWorkflowExecutor({
  id: "gemini", version: "0.1.0", contractVersion: "0.1.0",
  module: "@agwab/agent-workflow/executors/acp", config: { preset: "gemini" }
});
```

Then select `executor: "gemini"`.

## One attempt

1. Build launch argv and validate before consuming authority. ReadOnly requests injecting servers
   other than the engine's read-only `workflow_artifact` server are refused.
2. Launch the agent with inherited environment plus request env, subject to preset isolation.
3. Send `initialize` without client `fs` or `terminal` capabilities: the agent uses its own tools.
4. Send `session/new {cwd, mcpServers}`, followed by preset mode/model/effort configuration and one
   `session/prompt`. MCP env values travel in `session/new`, never on argv or disk.
5. Close stdin when the prompt settles, then escalate through SIGTERM/SIGKILL after the grace.

ACP has no system-prompt field. The adapter prefixes the system prompt to the task, separated by `---`;
this is emulated append, not a privileged system message. Sessions are process-bound, not resumable.

## Gemini preset

Launch:

```text
gemini --acp [--model <m>] --allowed-mcp-server-names <engine servers> --approval-mode <mode>
```

ACP servers merge into user-configured servers. `--allowed-mcp-server-names` excludes ambient servers;
with no engine servers it uses the sentinel `agent-workflow-none`.
ReadOnly uses `--approval-mode plan`, free/non-readOnly uses `yolo`, and safe/default uses `default`.
Permission requests still pass through engine policy. GEMINI.md memory and user settings remain;
`contextIsolation` is none and no fine tool allowlist is offered.

The expected artifact name is `mcp_workflow_artifact_workflow_artifact` from Gemini source, not yet
verified live. Its MCP delivery limit, real approval behavior, cancellation and usage numbers are
also unverified. `probe()` reads `--version`; auth is `unknown`, because ACP initialization lists
methods rather than login status. Gemini tools send display text, not full results; these events
cannot serve as evidence receipts.

## Antigravity preset

Install the registry archive (`antigravity-acp`) and expose `agy_acp_server` on PATH, or set
`AGENT_WORKFLOW_AGY_ACP_SERVER`. There is no installer. `doctor` lists Antigravity after Pi, Claude
and Codex, but does not make it the installed default.

Launch uses no arguments on macOS and `--uid=` on Linux. For symlinked executables, the adapter sets
`ANTIGRAVITY_HARNESS_PATH` to `localharness_external` beside the real file.

After `session/new`, the adapter sends `session/set_mode`: `yolo` for free/non-readOnly, otherwise
`default`. Antigravity has no read-only mode; enforcement relies on tool filtering and engine
permission decisions, not a filesystem sandbox. `session/set_config_option` selects `model` and
`thinking_level`. Models outside the offered list fail as config; non-Google provider names are
refused before launch because 1.4.5 offers only Gemini models. Effort maps to low/medium/high:
`off`/`minimal`/`low` → low, `medium` → medium, `high`/`xhigh`/`max`/`ultra` → high, when offered.

### Tool mapping

`ANTIGRAVITY_TOOL_MAPPING` builds `_meta.antigravity.enabledTools` for `session/new`.
The server enforces this allowlist; engine MCP tools are unaffected.

| Pi tool | Antigravity built-in / MCP tool |
|---|---|
| `read` | `view_file` |
| `grep`, `find`, `ls`, `bash` | `run_command` |
| `edit` | `edit_file` |
| `write` | `create_file` |
| `web_search` | `search_web` |
| `fetch_content` | `read_url_content` plus `view_file` |
| `workflow_artifact` | MCP `workflow_artifact` / `workflow_artifact` |

ReadOnly drops `edit_file` and `create_file`. Shell access remains coarse and permission-gated;
`grep`/`find`/`ls` have no dedicated live tools in 1.4.5. `list_directory`, `search_directory`,
`find_file` are not offered even if enabled. The model may expose write tools as `write_to_file`
and `replace_file_content`; the table uses the server's filter names.

Every unlisted built-in is disabled, including `run_workflow`, `schedule`, `invoke_subagent`,
`ask_question`, `generate_image`. This prevents out-of-engine agents/timers and unattended questions;
disabling `run_workflow` also prevents its startup `skills/system/run-workflow/SKILL.md` write in cwd.
When nothing maps, `disabledTools` lists all **15** known filter names instead; empty-allowlist
semantics are unverified. Unknown filter names are warned about. The adapter uses `_meta.antigravity`,
not legacy `_meta.agy` (documented since server 1.2.1).

### Isolation and authentication

Isolated attempts set `GEMINI_HOME` to a fresh private `aw-antigravity-home-*` directory containing
only a copy of `<agentHome>/antigravity-acp/settings.json`. The temporary home is removed after server
exit. The shared worker home retains login configuration, not worker conversations. This excludes
user global hooks (`config/hooks.json`), MCP servers (`config/mcp_config.json`), GEMINI.md and history.
`isolation.inherit` instead uses the user's home.

Workspace `AGENTS.md`, `GEMINI.md` and `.agents/rules` are not loaded on 1.4.5, but `.agents/skills`
are offered with no disable switch. `contextIsolation` is therefore emulated with a warning.
Workspace hooks are expected to require trust, but their absence has not been observed directly.

Inherited `GEMINI_API_KEY`, `GOOGLE_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`,
`ANTIGRAVITY_HARNESS_PATH`, `AGY_ACP_*` are removed unless explicitly set in the request.
Removed names are recorded as `envRemoved` in `acp-invocation.json`.

Authenticate the worker home once with `authenticateAcpAgent(config, "oauth-personal")`.
The server manages Google credentials outside `GEMINI_HOME`; only the method is recorded in
`<agentHome>/antigravity-acp/settings.json` (verified on macOS). Existing server login can avoid a new
browser flow; otherwise the user completes Google login. The probe reads only the method, never
credentials, and reports missing auth until it is recorded.

Server starts refresh the login token. A cross-process lock per login home serializes startup from
spawn through `session/new`, with at most about 2 min waiting, reducing concurrent-refresh login
prompts. Workers get `BROWSER=true`. A server requesting interactive login fails immediately as
`auth`; authenticate the worker home again. Browser suppression itself is unverified live.

### MCP and web results

The artifact prompt name remains **`mcp__workflow_artifact__workflow_artifact`**. The model routes
MCP calls through `call_mcp_tool(ServerName, ToolName, Arguments)`.
Every session sets `_meta.antigravity.mcpMaxOutputBytes = 131072` (server ≥ 1.4.0);
`probe().mcpOutputLimitChars = 32768` (byte bound / 4). A 30,000-character result is verified inline.
Without this override, 1.4.5 spills on-demand MCP results over 4 KB to step files.

ACP MCP `rawOutput` is a display summary. The adapter holds completion until after the turn, then
matches server/tool/arguments against
`antigravity-acp/brain/<session>/.system_generated/logs/transcript_full.jsonl`.
Results come from the matching following step or its `steps/<n>/output.txt`, restricted to the
session directory and clipped at **8 MiB**. Transcripts over **64 MiB** are not read. An unmatched
call, or a call using an inherited home, closes without recovered output.
Released results are recorded in `acp-stream.jsonl` as `{"agentWorkflow":"tool-results"}` so replay
releases the same output.

`search_web` returns a grounded summary with links; some use
`vertexaisearch.cloud.google.com/grounding-api-redirect/…`. `read_url_content` reports a title and
saves page Markdown to `.system_generated/steps/<n>/content.md`; the adapter releases that page as
output keyed by `Url`. The model also needs `view_file` to read the saved page, hence the paired
mapping. `search_web` permission requests are treated as fetch, not ACP search.
Web safety policy is unknown.

Shell `rawOutput` retains `combinedOutput` and `exitCode`, but the server truncates long shell output.
Built-in reads retain real paths/ranges (`file_path`, `start_line`, `end_line`) but only display-summary
output. They are not recovered from transcripts. Evidence must use local file bytes, captured MCP
results, or the complete web outputs above, not display summaries.

## Events

| ACP | SDK event |
|---|---|
| `agent_message_chunk` text | `message_delta`; concatenated answer |
| `tool_call`, `tool_call_update` | `tool_call`; pending/in_progress/completed/failed → pending/running/completed/failed; rejected permission → denied |
| `session/request_permission` | `approval_request`; allow_once/reject_once only, never *_always; absent option → cancelled; timeout → denied |
| prompt result `usage` | input = `inputTokens − cachedReadTokens`, output = `outputTokens + thoughtTokens`, cost unknown |
| `end_turn` | `completed` |
| `cancelled` | `failed/cancelled` |
| `max_tokens`, `max_turn_requests`, `refusal` | `failed/permanent` |

Other agent requests (`fs/*`, `terminal/*`) receive JSON-RPC error **-32601**.
`cancel` sends `session/cancel`; process cleanup uses stdin close and signal escalation.

Raw files: `<artifactsDir>/acp-stream.jsonl` (agent-to-client lines), `acp-stderr.log`,
`acp-invocation.json` (argv, env keys, MCP server names/env keys). Request env values of at least
8 characters are redacted. Cross-process observe replays these files; without a prompt result,
reconcile reports `unknown` because the original process owned the session.

## Capabilities (Gemini preset, declared)

All capability levels remain declared. Source: `src/executors/acp/capabilities.ts`.
The Antigravity column includes its live-verified behavior without upgrading metadata to probed.

| Capability | Gemini | Antigravity | Basis |
|---|---|---|---|
| toolLoop / context | agent / agent | agent / agent | agent-owned loop |
| sessionBound | true | true | process-owned ACP session |
| mcpInjection | native | native | `session/new`; Antigravity live, 1.4.5 |
| readOnly | emulated | emulated | plan/default mode plus engine policy |
| toolAllowlist | none | native, coarse | Antigravity `enabledTools`, live 1.4.5 |
| systemPrompt | emulated, append | emulated, append | prompt prefix |
| modelSelect | native | native | CLI flag / session config |
| effortLevels | none | low, medium, high | preset config |
| partialStream | native | native | `agent_message_chunk` |
| usage | native, tokens | native, tokens | prompt result usage |
| toolTelemetry | native | native | ACP tool events |
| cancel | native, notify | native, notify | `session/cancel` |
| nativeSchema | none | none | source: capabilities declaration |
| contextIsolation | none | emulated | Gemini memory/settings; Antigravity workspace skills |
| fastTier | none | none | source: capabilities declaration |
| toolResultBudget | none | none | source: capabilities declaration |
| webTools | search+fetch, safety unknown | search+fetch, safety unknown | preset declaration; Antigravity web result capture |
| resume | none | none | source: capabilities declaration |

## Errors and retries

Failures without a stop reason are classified from error text as auth, rate_limit, config, transient,
or unknown. The engine decides retry eligibility; the adapter does not infer success from an
unrecorded result or automatically reattach to another process's session.

Antigravity failure-shaped answers are handled explicitly:

| Answer / condition | Class |
|---|---|
| `Usage Limit Reached` | rate_limit |
| `Agent execution error: …` | classified from detail |
| `The MCP server '…' failed to initialize` | unknown |
| Interactive Google login request on stderr | auth |
| Unsupported offered model | config |

The failure-answer patterns are source-based and have not been observed live here.

## Known limits

- Gemini live MCP naming/delivery, approvals, cancellation and usage remain unverified.
- Neither preset supports resume or session adoption after owner loss.
- Antigravity has no filesystem sandbox or native read-only mode; readOnly is emulated.
- Antigravity workspace skills remain visible under isolation; workspace-hook exclusion is unverified.
- Antigravity unknown/new built-ins and empty-allowlist semantics need verification on newer servers.
- Raw tool display summaries are not full evidence; result recovery is unavailable with inherited homes.
- Web safety policy is unknown for both presets.
- Startup serialization mitigates refresh contention but does not prove interactive login impossible;
  `BROWSER=true` suppression remains unverified live.
