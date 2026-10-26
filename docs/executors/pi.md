# Pi executor (WP6)

`@agwab/agent-workflow/executors/pi` runs one workflow attempt as one `pi --mode json --print` process
(owner decision A2-3). Descriptor convention: `{ id: "pi", version: "0.1.0", module:
"@agwab/agent-workflow/executors/pi", config }` → `createExecutor(config)`.

The source is in `src/executors/pi/`:

| File | Content |
|---|---|
| `executor.ts` | The contract implementation |
| `argv.ts` | `buildPiArgv` and the tool mapping. Ported from pi-subagent `runners/headless-model.ts` and pi-workflow `workflowNativeLaunchTools` |
| `parse.ts` | The Pi JSON stream → `ExecEvent`. Ported from pi-subagent `PiJsonStreamParser` |
| `errors.ts` | The error table |
| `state.ts` | Durable attempt records |
| `run-extension.ts` | Code that runs inside Pi |
| `tool-result-budget.ts` | Ported from pi-subagent |
| `config.ts` | The descriptor config |

Ported files carry a header note.

## CLI and version

- **Verified with Pi 1.1.0** (`pi --version`), macOS, 2026-10-26.
- Live evidence: 18 model invocations, `test/fixtures/executors/pi/live-calls.md`.
- Offline evidence: the real Pi CLI with a scripted faux provider loaded by `-e`. There is no model call.
- `PI_MIN_CLI_VERSION = 1.1.0`. Native MCP (`pi.registerMcpServer`, `createMcpExtension`) needs 1.1. Older
  versions probe as `mcpInjection: none`.

## Invocation

```
pi --mode json --print
   (--no-session | --session-dir <state>/sessions/<id> (--session-id <id> | --session <kept file>))
   --exclude-tools subagent
   [isolation] --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve
   [--system-prompt <attempt>/pi-system-prompt.md] [--model <model>] [--thinking <effort>]
   (--tools <allowlist> | --no-tools)
   -e <attempt>/pi-extension.mjs [-e builtin:mcp -e builtin:codemode -e builtin:tool-search] [-e <pi-web-access>]
stdin: the prompt
```

| Flag / channel | Why |
|---|---|
| `--mode json --print` | A2-3. One run, JSONL events on stdout, then exit |
| prompt on **stdin** | Pi prepends piped stdin to the prompt; with no message argument, stdin *is* the prompt (verified offline). There is no argv length limit (Linux caps one argument at 128 KiB), and the prompt is never in `ps` |
| `--no-session` | D3. Default for every run |
| `--session-dir` + `--session-id` | D3/R#10. Only when `sessionId` is requested. The session lives under adapter state |
| `--session <file>` | Resume. `--session-id` only finds sessions of the current cwd. Pi's `--session <path>` opens the kept file whatever the cwd (verified offline and live, #10–#11) |
| `--exclude-tools subagent` | Ported. No recursive subagent tool when user extensions load (`inherit`) |
| isolation flags | B5, see below |
| `--system-prompt <file>` | Replace (capability `systemPrompt: replace`). A file avoids argv limits |
| `--thinking` | `effortLevels`: `off minimal low medium high xhigh max`. Pi clamps the level to the model |
| `--tools` / `--no-tools` | Fine allowlist. Plain names replace Pi's defaults. `mcp__<server>__*` declares the injected servers' tools |
| `-e <attempt>/pi-extension.mjs` | Generated per run (0600). It imports `dist/executors/pi/run-extension.js` and carries a non-secret JSON config: MCP servers with env **keys**, budget, fast tier, orphan guard |
| env `AGENT_WORKFLOW_PI_RUN_SECRETS_JSON` | MCP env values. The extension reads it and **deletes it at load**, so `bash` children never see it (verified offline). It is never on disk or on argv |
| env `PI_SKIP_VERSION_CHECK=1` | No `pi.dev` request per worker |
| fd 3 (pipe) | Orphan guard. When the owning process dies, the extension SIGTERMs Pi's process group (verified offline: SIGKILL of the driver ⇒ Pi gone) |

Raw output: `<artifactsDir>/pi-stdout.jsonl` and `pi-stderr.log`. They fall back to
`<stateDir>/runs/<sha256(attemptKey)>/` when the request has no `artifactsDir`. Values of `req.env` and
MCP env (≥ 6 chars) are redacted to `[redacted]` before writing and before normalizing. Normalized events
are a view over the raw stream (D3).

## Isolation (B5)

- **Default (`isolation.inherit: false`):**
  `--no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`. Login is
  kept: `auth.json` / env keys are Pi's own (D1), no extension is needed for the providers used, and no
  credential file is touched by the adapter.
- **Evidence:**
  - Offline: the system message `sections` drop from `preamble, tools, rules, docs, project_context,
    skills, cwd, mcp_servers` to `preamble, tools, rules, docs, cwd`. User `~/.pi/agent/AGENTS.md`, project
    `AGENTS.md`, skills and personal MCP servers are gone.
  - Live: kit `live.isolation` passed (#8). AGENTS.md and CLAUDE.md with a marker token sat in the cwd, and
    the token was not followed.
- **MCP under isolation:**
  - `-e builtin:mcp` would read the user's `~/.pi/agent/mcp.json`: it connects personal servers and lists
    them in the system prompt.
  - The per-run extension therefore starts Pi's own MCP implementation (`createMcpExtension`, a public
    export of `@earendil-works/pi-coding-agent`) with `loadConfig: () => ({ servers: [] })`. Only the
    injected servers connect.
  - It also disables `/mcp` config writes.
- **`inherit: true`:**
  - No isolation flags. Pi loads the user's extensions, skills, context files and `mcp.json`.
  - Injected servers are registered on the user's built-in MCP.
- **Residual (not isolated):**
  - User `settings.json` values that no flag overrides still apply: retry, compaction, transport, shell
    prefix, `httpProxy`, cache warming. `--model` / `--thinking` / `--tools` override the defaults that
    matter.
  - Pi has no per-run settings flag. `PI_CODING_AGENT_DIR` would also move `auth.json`, which D1 forbids.
  - Context files: `--no-context-files` drops `AGENTS.md`/`CLAUDE.md` discovery (global and project).
    `.pi/` project resources need trust, and `--no-approve` ignores them.

## Tool mapping (Pi names → Pi executor)

Identity mapping: workflow specs use Pi names. `toolAllowlist: native, fine`.

| Pi name | Pi executor | ACP kind | Verified |
|---|---|---|---|
| `read` | `read` | read | **live** (#3, #5, #12–#17) |
| `grep`, `find`, `ls` | same | search, search, read | no (Pi built-ins per `docs/cli.md`) |
| `bash` | `bash` | execute | offline (real Pi CLI + faux provider ran it through the adapter) |
| `edit`, `write` | same | edit | no |
| `web_search` | `web_search` (pi-web-access) | fetch | **live** (#15, #18) |
| `fetch_content` | `fetch_content` (pi-web-access) | fetch | no (tool listed by pi-web-access 0.44.0) |
| `workflow_artifact` | MCP `mcp__workflow_artifact__workflow_artifact` (needs the injected `workflow_artifact` server) | read | **live** (#4) |
| other names | none → `CAPABILITY_MISSING:toolAllowlist` before consume | — | unit |

The table is `PI_EXECUTOR_TOOL_MAPPING`.

- **readOnly:** Pi has no sandbox, so `readOnly` is `emulated`. The adapter drops mutating kinds (`bash`,
  `edit`, `write`, `codemode`) from the allowlist. Live: kit `live.readonly_enforced` passed (#6), and
  `live.tool_allowlist` passed (#7, only `read`, no shell).
- **Web tools:** under isolation, `pi-web-access` is loaded explicitly with `-e <package dir>`. The path comes
  from `config.webAccessExtension`, or else from `pi list` (no model turn). If it is missing,
  `CAPABILITY_MISSING:webTools` is raised before consume.
- **`inheritHostTools`** (descriptor config, host-level opt-in; core-port WP4b):
  - It adds `codemode, tool_search, mcp__*, list_mcp_resources, list_mcp_resource_templates,
    read_mcp_resource`, exactly as pi-workflow `workflowNativeLaunchTools` did.
  - Under isolation it also loads `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`. These read the
    user's `mcp.json`: that is the point of inheriting host tools.
  - It is **ignored for readOnly requests**, because codemode can reach mutating tools.

## MCP injection (A2-4)

Method: Pi 1.1 **native MCP**, per run, with no change to global settings.

1. The generated extension calls `pi.registerMcpServer(name, { command, args, env, exposure: "direct" })`
   for every `SubmitRequest.mcpServers` entry.
2. `--tools … mcp__<server>__*` declares those tools.

Secret env values reach the server only through the deleted-at-load env channel. Server names must match
`[A-Za-z0-9_-]+`.

- **Visible tool name:** `mcp__workflow_artifact__workflow_artifact`. Verified live (#4): the model called it
  by that name. `src/mcp/visible-names.ts` still says `verified: false`. Its type is the literal `false`,
  and that file belongs to WP5/MCP, so the flip is left to the parent / WP9b.
- **Measured output limit:** Pi cuts MCP text results **above 20,480 UTF-8 bytes**
  (`MCP_OUTPUT_MAX_BYTES = 20 * 1024`, `truncateMiddle`). A cut keeps 10 KiB head + 10 KiB tail around
  `…N chars truncated…`, adds a "Warning: truncated output" header and a "[Full output: <tmp file>]" footer,
  and saves the full text to a temp file.
  - Offline, real Pi: 20,480 bytes were delivered unchanged; 20,481 were cut (delivered 20,698 chars with
    the notice).
  - Live (#4): the artifact server with `--max-output-chars 20480` and a 50,000-char artifact delivered
    exactly 20,480 chars with no Pi cut. The ledger row had `truncated: true, deliveryUnverified: true`.
  - `probe().mcpOutputLimitChars = 20480`. Pass it to `artifactMcpServerSpecWithOutputLimit`.
  - `probe().mcpOutputNoticeChars = 1024`. This is a new optional SDK field (own commit), sized to the
    notice Pi adds around a cut result. The kit's `mcp.delivery_bound` check allows it.
- Pi does not put MCP server `instructions` into the model context. Prompt rendering must include the
  artifact tool guidelines (as noted in `docs/mcp.md`).

## Capabilities

Each row lists the CLI version it was verified with (`verifiedWith`). Rows marked `probed` were confirmed
live or offline with the real CLI.

| Capability | Value | Source | Evidence |
|---|---|---|---|
| toolLoop / context | agent / agent | — | Pi runs its own loop |
| sessionBound | `true` | — | The attempt belongs to the process that owns Pi's stdout pipe. A fresh process can `reconcile` (found) and replay an **exited** attempt from the raw stream, but cannot attach to a running Pi. With adoption, reconcile therefore marks `needs_decision` |
| mcpInjection | native | probed | live #4 |
| readOnly | emulated | probed | allowlist without mutating tools, live #6 |
| toolAllowlist | native / fine | probed | live #7 |
| systemPrompt | native / replace | probed (offline) | `--system-prompt <file>` (also supports append, not used) |
| modelSelect | native | probed | `--model` (live, all runs) |
| effortLevels | off…max | — | `--thinking` |
| resume | native / native | probed | live #9–#11 (`live.session_ownership`, `live.resume`) |
| partialStream | native | probed | `text_delta` → `message_delta` |
| usage | native / cost | probed | per assistant request. `cost` is Pi's **catalog estimate** → `source: estimated`. A cost of 0 → `null`/`unknown` (Pi cannot tell free from unpriced). `cached` = `cacheRead` (cacheWrite not represented) |
| toolTelemetry | native | probed | `tool_execution_start/end` → `tool_call` running/completed/failed |
| cancel | native / kill | probed | SIGTERM to Pi's process group, then SIGKILL after `killGraceMs` (3 s). Live #16: exit 143 → `failed/cancelled`. `turn` and `owned` both stop the run: print mode has no turn interrupt |
| nativeSchema | none | declared | Pi has no structured-output flag |
| contextIsolation | native | probed | live #8 + offline sections |
| fastTier | native | **unverified** | `before_provider_request` sets `service_tier: priority` after a model-binding check (ported from pi-workflow). The provider-stream guard was not ported, and no live verification was done (the OpenAI key is stale) |
| toolResultBudget | native | probed (offline) | Per-run `context` hook (ported enforcer). Real Pi + faux: 3×40-char results, budget 60 → 2 evicted, state file written |
| webTools | native / search+fetch, safetyPolicy **unknown** | unverified (static) / probed via `pi list` | pi-web-access 0.44.0. `web_search` live #15/#18. Its URL/IP/redaction controls were not audited, so the policy is `unknown`, never `engine` |

`probe()` makes no model turn. It runs:

- `pi --version`;
- `pi --list-models` (→ `models`);
- `pi list` (→ `webAccessExtension`);
- optionally `pi auth check --model <config.authCheckModel> --json --no-refresh`.

Auth is a non-secret enum: `ready`→`ok`, `not_ready`→`missing`, else `unknown`. Never `--credentials`.
Note: `ready` only means "credentials present". Live #1 got a 401 on a key that `auth check` called ready.

## Errors (`PI_ERROR_RULES`; first match wins, else `unknown`)

Pi **exits 0** after a provider error. The terminal state comes from the last assistant `stopReason: "error"`
plus `errorMessage`, then from the exit code and stderr.

| Text | Class | Evidence |
|---|---|---|
| context length / window exceeded (pi-subagent pattern) | permanent | source |
| `Model "<x>" not found` (exit 1, before any request) | config | offline transcript `fail-config-model-not-found` |
| `Unknown option`, `Invalid thinking level` | config | source |
| `No API key found for <provider>` (exit 1, before any request) | auth | offline transcript `fail-auth-no-api-key` |
| `(401)`/`(403)`, `invalid_api_key` | auth | **live** #1 `fail-auth-openai-401` |
| OAuth expired/refresh | auth | source |
| `(404)`, `model_not_found`, `does not exist` | config | source |
| `"code": 429`, `RESOURCE_EXHAUSTED` | rate_limit | **live** #15 `fail-rate-limit-google-429` |
| `(429)`, rate limit, quota, usage limit | rate_limit | source |
| `"code": 5xx`, `Internal Server Error`, `Internal error encountered` | transient | **live** #2 `fail-transient-google-500` |
| `(500/502/503/504/529)`, overloaded, ECONNRESET, ETIMEDOUT, fetch failed, terminated | transient | source |
| anything else (e.g. `--session-id cannot be combined with --continue`) | unknown | offline transcript `fail-unknown-flag-conflict` |

Other terminal cases:

| Case | Terminal event |
|---|---|
| Cancelled by request | `failed/cancelled` (live #16, offline faux) |
| Unrequested SIGTERM/exit ≠ 0 | classified from stderr; usually `unknown` |
| `stopReason: aborted` | `unknown` |
| No assistant message | `unknown` |

## Durability, idempotency, fencing

Attempt records (`<stateDir>/attempts/<sha256(attemptKey)>.json`, default `~/.agent-workflow/executors/pi`):

1. `pending` is written exclusively **before** `consume()`.
2. Then `revoked`, or `consumed`.
3. Then `spawned` (pid, process group, birth identity), immediately before `spawn` returns.
4. Then `exited` (exit code, signal, cancelled).

| Call | Behaviour |
|---|---|
| `submit` with a known key | Returns the recorded ref. `consumed` without a spawn ⇒ `AUTHORITY_ALREADY_CONSUMED` |
| `submit` | Validation and refusals happen before consume |
| `reconcile` | none/revoked ⇒ `absent`; pending/consumed ⇒ `unknown` (also after a spawn ENOENT); spawned/exited ⇒ `found` |
| `cancel` from another process | Verifies the recorded process identity before signalling, then returns `uncertain` |
| `respond` | Always `unknown_request`. Pi asks no permission in print mode, so the allowlist *is* the engine's policy (D2) |

**Durable binding env:**

- `AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON` is passed whenever the authority has a binding.
- The legacy `PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON` has exactly one reader in pi-subagent:
  `orchestrate/run.ts:337`, which refuses inline runs inside a bound child. Only a Pi child that loads the
  user's pi-subagent extension can run that code, so the legacy name is set **only when
  `isolation.inherit` is true**. Nothing in an isolated worker reads it.

## Conformance

| Tier | Result | How |
|---|---|---|
| Offline | 30 pass, 4 skip (`approval.*`, justified: Pi has no approval channel), 0 fail | `test/unit/executor-pi-conformance.test.mjs`. Recorded transcripts replayed through `createStubCli`; `mcp_tool` uses `fake-pi-mcp.mjs` (emulates Pi's extension contract and its 20 KiB cut); `crash_after_consume` = missing binary after consume |
| Runtime | 3/3 pass | Same harness `runtime()`. The real detached durable worker reloads the adapter from its descriptor. `control_relay` exercises cancel(owned) only (no approvals) |
| Live | 5/5 pass + smoke | `AGENT_WORKFLOW_LIVE=1 node --test test/unit/executor-pi-live.test.mjs` (real HOME, not `run-unit`), run once: `live.readonly_enforced`, `live.tool_allowlist`, `live.isolation`, `live.session_ownership`, `live.resume`. Report: `test/fixtures/executors/pi/kit-live-report.json` |

The `errors.failure_classes` check stages transient/rate_limit/auth/config from real transcripts. Permanent
is not staged, because there is no real context-overflow transcript.

## Concurrency

Three parallel live runs (#12–#14) all completed within 4.0–4.6 s, each with its own file's content. There
were no shared-state conflicts: attempt records, sessions and run dirs are per attempt, and `--no-session`
is used. The 4th–5th parallel run and long runs are untested.

## Web tool result

- `web_search` (pi-web-access 0.44.0, loaded explicitly under isolation) completed live in #15 and #18,
  returning 2,893 chars of results in #18.
- Safety policy: `unknown`.
- Deviation: the web tool ran twice, against a budget of one (live-calls.md).

## Known limits

- **No approvals.** Tools are either allowed (in the allowlist) or nonexistent. An interactive approval
  bridge would need a per-run `tool_call` gate extension plus a file channel. It is not built.
- **`sessionBound`:** no live re-attach after the owning process dies. The orphan guard stops Pi instead.
- **Settings residue:** non-overridable user settings apply under isolation (see Isolation).
- **Fast tier is unverified.** Neither the provider-stream guard nor a live check was done.
- `cacheWrite` tokens are not represented in `usage`.
- Model matching: Pi's `--model` accepts fuzzy matches. An unknown `provider/id:suffix` is sent as a custom id
  (live #1). The engine should pass exact `provider/id`.
- Pi's free-tier/subscription billing is not reflected: cost is a catalog estimate.

## Permission mode (WP4e)

Pi has no approval prompts in `--mode json --print` and no sandbox, so `free` and `safe` produce the
same argv: every requested tool (D2 revised, [`../permissions.md`](../permissions.md)). A readOnly
request drops mutating tools from `--tools` in both modes. The conformance harness documents this as
`equivalent` (`PI_PERMISSION_MODE_SETTINGS`, check `permission.mode_mapping`).

## Change log

- **WP4e (2026-10-26):** no adapter code change; `free` and `safe` map to the same invocation, readOnly
  unchanged. Tests: `executor-pi-adapter.test.mjs` (argv equal across free/safe/absent, readOnly drops
  mutating tools in free), conformance `permission.mode_mapping`. Live #19 (1 call, free mode).

## What later work packages need

- **WP9b:**
  - Flip `ARTIFACT_TOOL_NAME_MAPPINGS.pi.verified` (live #4) in `src/mcp/visible-names.ts`; its type needs
    `boolean`.
  - Run the shared kit with `createPiStubHarness()` / `createPiLiveHarness()` from
    `test/fixtures/executors/pi/harness.mjs`.
  - Consider recording a context-overflow transcript (`fail_permanent`).
  - Codex and Claude adapters probably also wrap cut MCP results. They can set `mcpOutputNoticeChars`.
- **WP10:**
  - For Pi, deep-research web tools are `web_search` / `fetch_content` from pi-web-access. Under isolation
    the adapter loads it with `-e`, and refuses `CAPABILITY_MISSING:webTools` when it is not installed.
  - Results are model-reported (`safetyPolicy: unknown`).
- **WP11 (hosts):**
  - Pass `inheritHostTools`, `fast`/`fastApi` (from `resolveWorkflowFastModeConfig`) and `toolResultBudget`
    as **per-task descriptor config**. The descriptor is digested into the execution plan.
  - Never pass secrets in config.
  - Retention should call `deleteOwnedSession(ownedSession)`, which deletes only under `<stateDir>/sessions`.
- **WP4c:**
  - Pass `probe().mcpOutputLimitChars` (20480) into `artifactMcpServerSpecWithOutputLimit`.
  - Use exact `provider/id` models.
  - Expect `failed.class` per the table above, and `cancelled` for engine cancels.
