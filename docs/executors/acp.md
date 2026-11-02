# ACP executor

Entry point: `@agwab/agent-workflow/executors/acp`. Source: `src/executors/acp/`.

- Factory: `createExecutor(config)` (descriptor convention, R#15); `createAcpExecutor({ config, faults })`
  is the typed form. `config.preset` picks the agent and the executor id.
- Adapter version: `0.1.0`. SDK contract: `0.1.0`. ACP protocol version 1.
- **Status: `antigravity` is a built-in executor (`--executor antigravity`, 2026-11-02); `gemini` is
  still a pilot preset.** Offline and runtime conformance pass against a scripted ACP agent
  (`test/unit/executor-acp-conformance.test.mjs`). For Antigravity, the live tier
  (`test/unit/executor-acp-antigravity-live.test.mjs`, `AGENT_WORKFLOW_LIVE=1`) passed on
  agy_acp_server 1.4.5 with gemini-3.8-flash (low):
  - smoke: a 200,000-char MCP result was delivered in full;
  - `live.readonly_enforced` and `live.isolation` passed, and `live.tool_allowlist` too once the
    allowlist existed (second run);
  - `live.session_ownership` and `live.resume` skip (declared none).
  
  A two-stage AW run (`--executor antigravity`: a file read, then an artifact read through
  `workflow_artifact`) completed cleanly. Capabilities stay `declared`.
- `doctor` lists it after pi, claude and codex (never the installed default); verified server 1.4.5.
- Built-in descriptor: `{ id: "antigravity", module: <dist>/executors/acp/index.js, config: { preset:
  "antigravity" } }`. The server must be on PATH as `agy_acp_server`, or named in
  `AGENT_WORKFLOW_AGY_ACP_SERVER`. The registry ships it as an archive with no installer. When the
  server is reached through a symlink, the adapter sets `ANTIGRAVITY_HARNESS_PATH` to the
  `localharness_external` beside the real file, as agent-orchestrator does.
- Presets: `gemini` (Gemini CLI, `gemini --acp`) and `antigravity` (Google Antigravity's separate ACP
  server `agy_acp_server`, ACP registry entry `antigravity-acp`). On 2026-11-02 Google refused Gemini
  CLI's free "Code Assist for individuals" tier (`IneligibleTierError`, "migrate to Antigravity"); the
  Antigravity server logs in with the same Google account (`authenticate` `oauth-personal`, a browser
  login the user completes once).

## Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `preset` | `gemini` | Agent preset; also the executor id |
| `command` | the preset's (`gemini`, `agy_acp_server`; antigravity: `$AGENT_WORKFLOW_AGY_ACP_SERVER` first) | Agent executable |
| `agentHome` | `<stateDir>/<preset>-home` | Engine-owned agent home (presets that isolate through it) |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/acp` (`~/.agent-workflow/…`) | Attempt records (reconcile) |
| `killGraceMs` | `2000` | Grace between closing the agent's stdin → SIGTERM → SIGKILL |
| `handshakeTimeoutMs` | `60000` | Limit for `initialize` and `session/new` |

Unknown keys are refused (`DESCRIPTOR_INVALID`). To try it, register a descriptor in process:
`registerWorkflowExecutor({ id: "gemini", version: "0.1.0", contractVersion: "0.1.0", module:
"@agwab/agent-workflow/executors/acp", config: { preset: "gemini" } })`, then run with
`executor: "gemini"`.

## One attempt

1. Before the authority is consumed: a readOnly request that injects an MCP server other than
   `workflow_artifact` is refused (its tools may mutate; same rule as the Claude adapter), and the
   launch argv is built.
2. The agent is started with the request env on top of the inherited environment. Gemini:
   `gemini --acp [--model <m>] --allowed-mcp-server-names <engine servers> --approval-mode <mode>`.
   - `--allowed-mcp-server-names`: ACP-supplied servers are merged into the user's settings
     servers; the allow list keeps only the engine's. Without engine servers it names
     `agent-workflow-none`, so no user server loads.
   - `--approval-mode`: readOnly → `plan`; `free` on a writing stage → `yolo`; otherwise `default`.
3. `initialize` (client offers no `fs` and no `terminal`: agents use their own tools) →
   `session/new { cwd, mcpServers }` (MCP env values travel only in this message, never on argv or
   on disk) → one `session/prompt`. ACP has no system prompt field: the system prompt is put ahead
   of the task, separated by `---`.
4. When the prompt settles the adapter closes the agent's stdin (SIGTERM / SIGKILL after the grace).

## Antigravity preset

- Launch: no arguments on macOS (`--uid=` on Linux), as agent-orchestrator's `agyacp` driver.
- After `session/new`: `session/set_mode` (`yolo` for `free` on a writing stage, else `default`),
  `session/set_config_option` `model` (refused when the session does not offer it, class `config`) and
  `thinking_level` from the effort (low / medium / high, nearest).
- No read-only mode and no MCP allow list: readOnly relies on the engine denying writing kinds in
  permission requests.
- `session/new` carries `_meta.antigravity` with a built-in tool allowlist built from the stage's
  tools (`antigravitySessionMeta`, `ANTIGRAVITY_TOOL_MAPPING`):
  - `read` → `view_file`; `grep`/`find`/`ls`/`bash` → `run_command`; `edit` → `edit_file`;
    `write` → `create_file`. A readOnly stage drops the writing tools.
  - Web tools are not mapped yet: their results are not captured as evidence, so `webTools` stays none.
  - `enabledTools` lists the result. When nothing maps, `disabledTools` lists all 15 names the filter
    knows instead, because what an empty allowlist does is not verified.
  - Every unlisted built-in is off: `run_workflow`, `schedule`, `invoke_subagent`, `ask_question`,
    `generate_image`. That means nothing starts agents or timers outside the engine, and nothing asks
    a question no one answers.
  - Live (2026-11-02, 1.4.5): `enabledTools` is a server-enforced allowlist (only the listed tools were
    offered); engine MCP tools are not affected. `toolAllowlist` is native, coarse (`run_command`
    covers several Pi tools).
  - The filter knows only the SDK `BuiltinTools` names and warns about any other name. A no-model
    probe found 15. `list_directory`, `search_directory` and `find_file` are not offered even when
    enabled. `_meta.agy` (documented since ACP server 1.2.1) is logged as legacy.
  - Without the filter, 1.4.2+ writes `skills/system/run-workflow/SKILL.md` into the cwd at
    `session/new`, which lands in the user's checkout or a worktree diff. With it: no file.
  - Input tokens per request: 13,619 with no filter, 8,531 with five tools off, 4,073 with only
    `view_file`.
- Workspace customizations, measured on 1.4.5 by input tokens and marker instructions, with and
  without a git repository:
  - `AGENTS.md`, `GEMINI.md` and `.agents/rules` in the cwd are **not** loaded into ACP sessions, even
    though the app/CLI docs list them.
  - `.agents/skills` **are** offered: the skill list adds about 290 tokens per skill, and the model
    can read the skill file.
  - No switch turns skills off, so `contextIsolation` stays `emulated` with a warning, recorded as a
    degradation on every run, like Codex's global `AGENTS.md`.
  - Workspace hooks need workspace trust (`AGY_ACP_DISABLE_WORKSPACE_TRUST`, removed by the env
    scrub). That they stay off is an inference from agent-orchestrator, not observed.
- Web tools: `web_search` → `search_web`, `fetch_content` → `read_url_content` + `view_file` (the
  model only gets the saved file's path, so it needs `view_file` to read the page); `webTools`
  search+fetch, safety unknown.
  - `search_web` returns a grounded summary with links, and its rawOutput is that text (receipt form
    search-results). Some links are `vertexaisearch.cloud.google.com/grounding-api-redirect/…`.
  - `read_url_content` reports only a title. The adapter releases the page instead: the transcript
    says "has been saved to: <session>/.system_generated/steps/<n>/content.md", and that Markdown
    becomes the output (receipt form page-text, keyed by its `Url`).
  - Titles "Run <tool>?" / "Running <tool>" are reported as the tool name. A `search_web` permission
    request (ACP kind `search`) is judged as `fetch`, the kind of the Pi web tools.
  - Live: a probe with `read_url_content` but no `view_file` could not read the saved page. It ran
    35 `search_web` calls for a verbatim quote: 37 requests, 0.97 M input tokens counted cumulatively,
    of which 0.76 M were cache reads. Hence the `view_file` pairing. With `read` in the stage (as in
    deep-research), workers read the saved pages with `view_file`.
- Built-in tool outputs (e.g. `view_file`) are display summaries in ACP ("Read workflow-stop.ts");
  only engine MCP results are recovered from the transcript. Their inputs (path, line range) are real.
- Tool names (live 2026-11-02): the model listed `view_file`, `write_to_file`,
  `replace_file_content`, `run_command`, `search_web`, `read_url_content`, `call_mcp_tool`,
  `list_resources`, `read_resource`, `manage_task`, `ask_question` and `generate_image`. It has
  no list, grep or find tool, so those go through `run_command`. That is an `execute` request,
  which the engine denies on a read-only stage. The worker prompt's tool note says so
  (`WORKER_TOOL_NAME_MAPPINGS.antigravity`).
- MCP tools are called through `call_mcp_tool(ServerName, ToolName, Arguments)`. Told to call
  `mcp__workflow_artifact__echo`, the model read the tool schema and called it, so the artifact tool
  keeps the common `mcp__workflow_artifact__workflow_artifact` name (`ARTIFACT_TOOL_NAME_MAPPINGS`).
- Tool results: for an engine MCP tool the server's ACP `rawOutput` is a display summary ("Echo
  tool"). The adapter holds such a call's closing report back. After the turn it takes the result
  the server recorded in the worker home: the step after the call in
  `antigravity-acp/brain/<session>/.system_generated/logs/transcript_full.jsonl`, or the
  `steps/<n>/output.txt` file that step names (only files inside that session's folder, at most
  8 MiB). The call is then reported once, with the result. Calls are matched by server, tool and
  arguments. An unmatched call closes without an output, and so does a call in an attempt that
  inherits the user's home. Shell `rawOutput` is an object (`combinedOutput`, `exitCode`) and is
  kept. The server itself truncates long shell output. What was released is written to the raw log
  (`{"agentWorkflow":"tool-results"}`), so a replay releases the same.
- Inherited variables that would switch the account, project or harness (`GEMINI_API_KEY`,
  `GOOGLE_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `ANTIGRAVITY_HARNESS_PATH`, `AGY_ACP_*`;
  Orca's list) are dropped for an isolated worker unless the request sets them. Their names are in
  `acp-invocation.json` `envRemoved`.
- An answer that is the server's failure report fails the attempt. "Usage Limit Reached" → class
  `rate_limit`; "Agent execution error: …" → classified; "The MCP server '…' failed to initialize" →
  `unknown`. The patterns come from OpenBot's 1.3.0/1.4.4 handling and have not been seen live here.
- Workers run with `GEMINI_HOME` set to an engine-owned home (`agentHome`, default
  `<stateDir>/antigravity-home`), so the user's global hooks (`config/hooks.json`), MCP servers
  (`config/mcp_config.json`), GEMINI.md and conversation history stay out (`contextIsolation`
  emulated). An attempt with `isolation.inherit` uses the user's home. In the first live check
  (2026-11-02) a user status hook in the shared home denied every tool call.
- The worker home needs a one-time `authenticateAcpAgent(config, "oauth-personal")`. If the user has
  already logged in to the Antigravity ACP server, no browser opens: the server keeps its Google
  credentials outside `GEMINI_HOME` and only writes the method to
  `<agentHome>/antigravity-acp/settings.json` (observed 2026-11-02, macOS). Otherwise it opens
  Google's login (the link is printed on stderr). `probe()` reports `auth` missing until that file
  records a method (only the method is read, never credentials).
- Tool events carry the raw arguments (`rawInput`), but `rawOutput` is a display summary, not the
  tool result (live check 2026-11-02): evidence from tool output must come from engine-side capture
  (an engine MCP server), not from these events.
- `probe()` asks ACP `initialize` for `agentInfo.version` (its `--version` prints build data only); no
  session, no model.

## Events

| ACP | SDK event |
|---|---|
| `agent_message_chunk` (text) | `message_delta`; the answer is their concatenation |
| `tool_call`, `tool_call_update` | `tool_call` (kinds as in ACP; `pending` / `in_progress` / `completed` / `failed` → `pending` / `running` / `completed` / `failed`; a rejected permission → `denied`) |
| `session/request_permission` | `approval_request`; `respond()` selects the agent's `allow_once` or `reject_once` option (never an `*_always` option; none offered → `cancelled`); unanswered → denied after `approvalPolicy.timeoutMs` |
| prompt result `usage` | `usage`: input = `inputTokens − cachedReadTokens`, output = `outputTokens + thoughtTokens`, cost unknown |
| stop reason `end_turn` | `completed` |
| `cancelled` | `failed` / `cancelled` |
| `max_tokens`, `max_turn_requests`, `refusal` | `failed` / `permanent` |

Tool input/output are the agent's `rawInput` / `rawOutput` when sent; otherwise the display fields
(title, locations, text content). **Gemini sends display text only** (its `tool_call_update` content
is the tool's `returnDisplay`, empty for a file read), so its tool events cannot serve as evidence
receipts: the web quote check re-fetches pages, and deep-review evidence is checked against file bytes
as for every executor.

Agent requests other than `session/request_permission` (`fs/*`, `terminal/*`) get JSON-RPC error
-32601. Failures without a stop reason are classified from the error text (auth, rate limit, config,
transient, else unknown).

Raw output: `<artifactsDir>/acp-stream.jsonl` (agent → client lines), `acp-stderr.log` and
`acp-invocation.json` (argv, env keys, MCP server names and env keys), with request env values of 8+
characters redacted. Another process replays the stream from these files; without a recorded prompt
result `reconcile` reports `unknown` (the ACP session belonged to the gone process).

## Capabilities (Gemini preset, declared)

`mcpInjection` native, `readOnly` emulated (`plan` mode + permission policy), `toolAllowlist` none,
`systemPrompt` emulated (append), `modelSelect` native, `partialStream` native, `usage` tokens,
`toolTelemetry` native, `cancel` notify (`session/cancel`), `contextIsolation` none (GEMINI.md memory
and user settings still load), `webTools` search+fetch with an unknown safety policy, `resume` none,
`sessionBound` true. `probe()` reads `--version`; auth is `unknown` (ACP `initialize` lists methods,
not whether one is set up).

## Not verified yet (live tier)

- The engine's server is connected and its tool called; a user server is absent (allow list).
- Gemini's MCP tool name for the artifact tool (`mcp_workflow_artifact_workflow_artifact` per its
  source) and the delivery limit of MCP results.
- Approval modes and permission requests on the real CLI; cancel; usage numbers.
