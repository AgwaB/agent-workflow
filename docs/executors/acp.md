# ACP executor (pilot)

Entry point: `@agwab/agent-workflow/executors/acp`. Source: `src/executors/acp/`.

- Factory: `createExecutor(config)` (descriptor convention, R#15); `createAcpExecutor({ config, faults })`
  is the typed form. `config.preset` picks the agent and the executor id.
- Adapter version: `0.1.0`. SDK contract: `0.1.0`. ACP protocol version 1.
- **Status: pilot, not a built-in executor.** Offline and runtime conformance pass against a
  scripted ACP agent (`test/unit/executor-acp-conformance.test.mjs`); nothing is live-verified yet,
  so every capability is `declared`. Like other ACP hosts, an agent becomes a built-in only after its
  live conformance (handshake, MCP, streaming, permissions, cancel) passed on the real CLI.
- Presets: `gemini` (Gemini CLI, `gemini --acp`).

## Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `preset` | `gemini` | Agent preset; also the executor id |
| `command` | the preset's (`gemini`) | Agent executable |
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
