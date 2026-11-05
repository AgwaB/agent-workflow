# Claude Code executor

Entry point: `@agwab/agent-workflow/executors/claude`; source: `src/executors/claude/`.
Use `createExecutor(config)`; the typed factory is `createClaudeExecutor({ config, faults })`.
Adapter and SDK contract version: `0.1.0`.

Verified with **claude-code 2.1.318** using claude.ai subscription login. Live coverage also exists
for **2.1.310** and **2.1.314**; protocol and output-limit details were established on 2.1.310.

## Config (descriptor `config`, JSON, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `claudePath` | `claude` | CLI binary |
| `stateDir` | `$AGENT_WORKFLOW_HOME/executors/claude` (`~/.agent-workflow/…`) | Attempt and kept-session records |
| `mcpOutputTokens` | `25000` | Overrides inherited/request `MAX_MCP_OUTPUT_TOKENS` |
| `mcpToolTimeoutMs` | unset | Sets `MCP_TOOL_TIMEOUT` |
| `systemPromptMode` | `append` | `--append-system-prompt` or `--system-prompt` (`replace`) |
| `listModels` | `true` | Lists models through `initialize` during probe |
| `killGraceMs` | `3000` | Grace between interrupt, SIGTERM and SIGKILL |
| `claudeConfigDir` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Used only to remove worker session files |

Unknown keys are refused (`DESCRIPTOR_INVALID`). Keep secrets in request/MCP environment, not config.

## Invocation

```text
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-mode (default | bypassPermissions) --permission-prompt-tool stdio
  --tools <mapped built-ins> [--allowedTools <web tools>,mcp__<server>…] [--disallowedTools Bash,Edit,Write,NotebookEdit]
  [--setting-sources "" --settings {"autoMemoryEnabled":false} --strict-mcp-config --disable-slash-commands]
  [--mcp-config <artifactsDir>/claude-mcp-config.json] [--model M] [--effort E]
  [--append-system-prompt S | --system-prompt S]
  (--session-id <uuid> --no-session-persistence | --session-id <requested> | --resume <id>)
```

The prompt is one stream-json `user` message on stdin. Stdin stays open for approvals and interrupts,
then closes after the `result` line. `--verbose` is required with print-mode stream-json output;
`--include-partial-messages` enables text deltas. `--permission-prompt-tool stdio` routes approval
requests to the engine instead of letting the CLI silently deny them.

`--tools` restricts built-ins. `--allowedTools` pre-allows requested web tools and injected MCP tools;
readOnly artifact access uses the exact `mcp__workflow_artifact__workflow_artifact` rule, not a
server-wide rule. ReadOnly also adds `--disallowedTools Bash,Edit,Write,NotebookEdit`.

## Permission mode

Safe/default and every readOnly stage use `--permission-mode default`. Free, non-readOnly stages
use `--permission-mode bypassPermissions`, not the `--dangerously-skip-permissions` alias.
The stdio approval channel stays enabled; the engine allows requests that still arrive in free mode
with audit reason `engine-policy:free`. ReadOnly argv is identical in both modes.
See [permissions](../permissions.md); mapping: `CLAUDE_PERMISSION_MODE_SETTINGS`.

## Isolation

`inherit: false` adds `--setting-sources "" --strict-mcp-config --disable-slash-commands
--settings {"autoMemoryEnabled":false}`. This disables user settings, hooks, commands, skills and
personal MCP configuration while preserving subscription login. Project `CLAUDE.md`/`AGENTS.md`
isolation is verified live. Auto-memory is disabled to avoid creating worker memory directories.
Built-in agents and plugins remain loaded.

User-level `~/.claude/CLAUDE.md` isolation has not been verified; the SDK documents `settingSources`
as controlling its loading. `inherit: true` drops isolation flags but still explicitly selects the
permission mode for the request; user allow rules can then apply. `--bare` is not used because it
does not preserve OAuth login.

## Tool mapping (Pi → Claude)

| Pi | Claude | Kind | Verified live |
|---|---|---|---|
| `read` | `Read` | read | yes, 2.1.310 |
| `grep` | `Grep` | search | listed in init, 2.1.310 |
| `find` | `Glob` | search | listed in init, 2.1.310 |
| `ls` | `Glob` (2.1.310 has no LS tool) | search | listed in init, 2.1.310 |
| `bash` | `Bash` | execute | yes, 2.1.310 |
| `edit` | `Edit` | edit | docs only |
| `write` | `Write` | edit | docs only |
| `web_search` | `WebSearch` (client tool) | fetch | yes, 2.1.310 |
| `fetch_content` | `WebFetch` | fetch | yes, 2.1.310 |
| `workflow_artifact` | MCP `mcp__workflow_artifact__workflow_artifact` | read | yes, 2.1.310 |

Unknown tools fail before consume with `CAPABILITY_MISSING:tool:<name>`.
`workflow_artifact` requires the injected server or fails with `INVALID_REQUEST`.
ReadOnly removes `Bash`, `Edit`, `Write`, `NotebookEdit`; injected servers other than the engine's
read-only artifact server are refused before consume with `CAPABILITY_MISSING:readOnly`.

## Approvals

- `control_request can_use_tool` becomes `approval_request` with id, kind and tool detail.
- Allow returns `control_response {behavior: allow, updatedInput: <original input>}`;
  deny returns `{behavior: deny, message}` and a denied tool event.
- Unanswered requests are denied at `approvalPolicy.timeoutMs`.
- Unknown id → `unknown_request`; already answered or ended attempt → `too_late`.
- Unsupported control requests get an error response rather than hanging.

Claude auto-allows Read/Grep/Glob inside working directories and read-only shell commands without
asking the engine. These still produce tool events. ReadOnly stages have no Bash tool.

## MCP injection

`--mcp-config <artifactsDir>/claude-mcp-config.json` is mode 0600 and uses stdio servers.
Each MCP env value becomes `${AW_CLAUDE_MCP_<i>_<KEY>}` in the file; the value is passed in the CLI's
environment and expanded by Claude. Values never appear in the file or argv. Commands/arguments
containing `${` are refused to prevent unintended expansion. Servers inherit the CLI's full environment.
Visible names are `mcp__<server>__<tool>`, including
**`mcp__workflow_artifact__workflow_artifact`**.

`MAX_MCP_OUTPUT_TOKENS` is honored. At 2,000 tokens, 3,000 characters stayed inline and 12,000 spilled;
at the default 25,000 tokens, 22,500 and 45,000 stayed inline and 90,000 spilled.
Over-limit results are **not truncated**: a notice replaces them and the full result is saved under
`~/.claude/projects/<cwd>/<session>/tool-results/…`, even without session persistence.

The probe reports `mcpOutputLimitChars = floor(0.9 × tokens) = 22500` by default. The artifact server
bounds UTF-8 bytes as well as character length; the engine sets `--max-output-chars 21375`
(5% margin), paging larger whole reads. See [MCP](../mcp.md).
`MCP_TOOL_TIMEOUT` is honored; `MCP_TIMEOUT` startup behavior is unmeasured.
An injected server reported `failed` or `needs-auth` at init fails the attempt as `config`.

## Sessions

Default: `--session-id <attempt uuid> --no-session-persistence`. The UUID is deterministic per
attempt (SHA-256 UUID layout), providing launch identity without a kept transcript. After exit,
the adapter removes `<claudeConfigDir>/projects/*/<uuid>/` spill files and empty project directories,
never other session names. Ephemeral terminal events wait for CLI exit, cleanup and raw-log flush.

Requested `sessionId` enables persistence and records ownership under `stateDir/sessions/`.
UUIDs pass through; non-empty logical ids map through `claudeSessionUuid(id)` to a deterministic
UUID with v4 layout over SHA-256. Owned sessions are reported as
`ownedSession {kind: "claude-session", locator: <uuid>}`.

`resumeSessionId` uses `--resume <id>` and must reuse the session's original cwd. A resumed foreign
session is kept but never recorded or reported as owned. `deleteOwnedSession` refuses unrecorded
sessions; for owned sessions it removes `<uuid>.jsonl` and `<uuid>/` across project directories,
returning `deleted` or `absent`. It is an adapter extension, not part of the SDK interface.

## Events

| CLI event | ExecEvent |
|---|---|
| `system/init` | `started {sessionId}` |
| text delta / unstreamed assistant text | `message_delta` |
| `tool_use` / `tool_result` | `tool_call` running / completed, failed or denied |
| `can_use_tool` | `approval_request` |
| successful `result` | usage then `completed {finalText: result}` |
| error `result` | unknown usage then classified `failed` |

Usage is `input = input_tokens`, `cached = cache_read_input_tokens`,
`cacheWrite = cache_creation_input_tokens`, output as reported, and resolved model from `result.modelUsage`
or the last assistant message. `total_cost_usd` is reported cost, but on subscriptions it is notional
list price (`costBasis: "list"`). Interrupted/error results have unknown usage rather than misleading
zeros. Tool event input/output is capped at 65,536 characters; raw logs retain the full payload.

Synthetic assistant messages are skipped. `rate_limit_event`, `system/status`, `thinking_tokens`
and hook events stay only in raw logs. The `result` line is terminal; later exit code is ignored.

Raw files in `artifactsDir` (fallback `stateDir/attempts/<hash>/`): `claude-stream.jsonl`,
`claude-stderr.log`, `claude-invocation.json` (argv, env keys, tools), `claude-mcp-config.json`.
Request secrets of at least 8 characters are redacted in raw streams, stderr, argv and events;
split stderr chunks are handled by the shared stream redactor.

## Cancel

`cancel(turn)` sends the `interrupt` control request and yields `failed {class: cancelled}`.
Without a result within `killGraceMs`, stdin closes, then SIGTERM/SIGKILL escalation follows.
`cancel(owned)` interrupts, closes stdin and escalates. Results: `too_late` after terminal,
`no_active` for an unknown attempt, `uncertain` for another process's attempt.

## Capabilities

| Row | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | declared | CLI owns both |
| sessionBound | **true** | declared | spawning worker owns stdio/control |
| mcpInjection | native | probed | live, 2.1.310 |
| readOnly | native | probed | live conformance, 2.1.310 |
| toolAllowlist | native, fine | probed | live conformance, 2.1.310 |
| systemPrompt | native, `append` (or `replace` per config) | probed | live, 2.1.310 |
| modelSelect | native | probed | `--model`; live, 2.1.310 |
| effortLevels | low, medium, high, xhigh, max | declared | CLI help; minimal maps to low |
| resume | native, native | probed | live conformance, 2.1.310 |
| partialStream | native | probed | live, 2.1.310 |
| usage | native, cost | probed | `total_cost_usd` |
| toolTelemetry | native | probed | live, 2.1.310 |
| cancel | native, interrupt | probed | live, 2.1.310 |
| nativeSchema | none | declared | SDK has no schema field |
| contextIsolation | native | probed | project isolation, 2.1.310 |
| fastTier | none | declared | `fast_mode_disabled_reason: sdk_opt_in_required` |
| toolResultBudget | none | declared | source: capability declaration |
| webTools | native, search+fetch, **safetyPolicy `unknown`** | probed | live, 2.1.310; safety controls undocumented |

Capability metadata retains the original 2.1.310 baseline; latest verified CLI is 2.1.318.
The probe notes version differences. Unsupported efforts are refused; Pi `minimal` maps to `low`.

`probe()` makes no model call and reads no credentials. It reports installation, `claude --version`,
auth from `claude auth status --json` (`loggedIn` → `ok`/`missing`/`unknown`), models from `initialize`
(values plus `resolvedModel`), and the MCP output limit. `modelListComplete: false`: unlisted full
model ids are noted, not refused. Model listing starts one CLI for the control handshake, about 1–2 s.

## Error classification

`CLAUDE_ERROR_RULES` checks result text, subtype, `api_error_status`, `terminal_reason`, errors and stderr.

| Case | Source | Class |
|---|---|---|
| Not logged in / run login | live, 2.1.310 | auth |
| Invalid API key, expired OAuth, `authentication_error`, 401/403 | documented shapes | auth |
| Selected model issue, 404, `unrecognized_model` | live, 2.1.310 | config |
| Unknown option, injected server failure, CLI missing/ENOENT | adapter | config |
| 429, `rate_limit_error`, usage limit | documented | rate_limit |
| 500/502/503/504/529, overload, ECONNRESET/ETIMEDOUT/socket hang up | documented | transient |
| Prompt too long, 400 `invalid_request_error`, `error_max_turns` / `error_max_budget_usd` | documented | permanent |
| Adapter-requested interrupt or exit after stop | live, 2.1.310 | cancelled |
| Unrequested interrupt, exit without result and unrecognized stderr | offline / replay | unknown |

The engine decides retries from class; `unknown` is never automatically retried. The adapter does not
relaunch consumed attempts. Exclusive claims prevent duplicate launches; unreadable or mismatched
records mean unknown, refuse resubmission with `AUTHORITY_ALREADY_CONSUMED`, and make cancel uncertain.

## Known limits

- **Session-bound:** another process reconciles from raw output: recorded result → `found`, otherwise
  `unknown`. Either needs a decision, never automatic adoption/relaunch. Cross-process observe
  replays raw output and ends `failed unknown` without a result.
- **Auto-allow:** CLI read tools and read-only Bash can bypass engine approval; readOnly removes Bash.
- **Spills:** files exist during the run and are removed after ephemeral CLI exit. The artifact
  server's actual default bound is 21,375 characters/bytes, below the 22,500 probe limit.
- **Environment:** inherited `ANTHROPIC_API_KEY` switches to API-key billing. MCP env values are
  visible to CLI Bash children.
- **Unverified:** global `CLAUDE.md`, `Edit`/`Write` names, `MCP_TIMEOUT`. `deadlineMs` is not
  adapter-enforced; runtime timeouts apply. Web safety controls are undocumented.
- Three parallel attempts are verified; higher concurrency is unverified.
- Revoked or dead-process spawned records older than 7 days are pruned with their attempt directory,
  on submit at most every 6 h and by `agent-workflow prune`. Launched records become permanent
  `agent-workflow-attempt-tombstone-v1` tombstones (attemptKey, finishedAt, prunedAt; no outcome).
  Reconcile reports `unknown`, never `absent`; submit refuses the key. Only never-launched revoked
  records are removed.
