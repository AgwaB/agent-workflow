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
| `-e <attempt>/pi-extension.mjs` | Generated per run (0600). It imports `dist/executors/pi/run-extension.js` and carries a non-secret JSON config: MCP servers with env **keys**, budget, fast tier (WP35: plus Pi's OpenAI stream functions for the guard), orphan guard |
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
  - **WP35 (row 57): not bundled (C2), guided instead.** `probe()` adds a note `web tools: pi-web-access
    <path> (web_search, fetch_content)`, or `web tools missing: …` with the install command
    `` `pi install npm:pi-web-access` `` (`PI_WEB_ACCESS_INSTALL`); when `pi list` fails the note says the
    presence could not be checked. A missing package also sets the probed `webTools` level's
    `warning` to the same guidance, so the capability preview entry and the B4 refusal message
    (`CAPABILITY_MISSING:webTools … ; Install it: …`) carry it (`negotiateCapabilities` now copies an
    observed warning into a refused entry's note). The submit-time refusal names the command too,
    and `agent-workflow doctor` prints the note under `pi` and lists a missing package as a warning.
    Tests: `executor-wp35-web-access.test.mjs`.
- **`inheritHostTools`** (descriptor config, host-level opt-in; core-port WP4b):
  - It adds `codemode, tool_search, mcp__*, list_mcp_resources, list_mcp_resource_templates,
    read_mcp_resource`, exactly as pi-workflow `workflowNativeLaunchTools` did.
  - Under isolation it also loads `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`. These read the
    user's `mcp.json`: that is the point of inheriting host tools.
  - It is **ignored for readOnly requests**, because codemode can reach mutating tools.
  - **WP35: who sets it.** The Pi host (`docs/pi-host.md` "Host tools for Pi workers") offers it when its
    session has Pi 1.1 native codemode/MCP; the engine honors it only for runs on this executor and
    compiles readOnly stages without it. The task backend then passes `inheritHostTools: true` as
    **per-task descriptor config** (`workflowTaskExecutorDescriptor`, `src/core/task-backend.ts`) for each
    inheriting task; the run's descriptor stays unchanged. Launch provenance requires the run's
    executor to be `pi` for such a task (other executors fail closed). The capability preview records
    a `host tools: …` notice. Verified offline (`executor-wp35-host-tools.test.mjs`), not live.

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
  - `probe().mcpOutputLimitChars = 20480`. Since WP5b the engine launches the artifact server with
    `--max-output-chars 18432` (20480 − 1024 notice − 1024 margin; docs/mcp.md "Measured limits") and
    larger whole reads are paged.
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
| usage | native / cost | probed | per assistant request. `cost` is Pi's **catalog estimate** → `source: estimated`. A cost of 0 → `null`/`unknown` (Pi cannot tell free from unpriced). `cached` = `cacheRead`, `cacheWrite` = `cacheWrite` (since WP12a), `model` = the assistant message's model |
| toolTelemetry | native | probed | `tool_execution_start/end` → `tool_call` running/completed/failed |
| cancel | native / kill | probed | SIGTERM to Pi's process group, then SIGKILL after `killGraceMs` (3 s). Live #16: exit 143 → `failed/cancelled`. `turn` and `owned` both stop the run: print mode has no turn interrupt |
| nativeSchema | none | declared | Pi has no structured-output flag |
| contextIsolation | native | probed | live #8 + offline sections |
| fastTier | native | **unverified** | Ported from pi-workflow (WP35: complete). `session_start` re-registers the bound OpenAI provider with a guarded stream (`serviceTier: priority`, payload guard, reasoning clamp); `before_provider_request` also stamps `service_tier` after a model-binding check. Reported in `<attempt>/pi-fast-tier.json`; see "Fast tier" below. Offline only (fake provider streams); no live run yet (live bundle 5) |
| toolResultBudget | native | probed (offline) | Per-run `context` hook (ported enforcer). Real Pi + faux: 3×40-char results, budget 60 → 2 evicted, state file written |
| webTools | native / search+fetch, safetyPolicy **unknown** | unverified (static) / probed via `pi list` | pi-web-access 0.44.0. `web_search` live #15/#18. Its URL/IP/redaction controls were not audited, so the policy is `unknown`, never `engine` |

`probe()` makes no model turn. It runs:

- `pi --version`;
- `pi --list-models` (→ `models`);
- `pi list` (→ `webAccessExtension`, and the WP35 `web tools` note with install guidance);
- optionally `pi auth check --model <config.authCheckModel> --json --no-refresh`.

Auth is a non-secret enum: `ready`→`ok`, `not_ready`→`missing`, else `unknown`. Never `--credentials`.
WP19 (review #9): without `config.authCheckModel` the auth comes from `pi --list-models`, which lists
only models whose provider has configured auth in Pi (pi-ai `ModelRuntime.getAvailable` →
authenticated providers; Pi resolves its own credentials, the engine reads none, no model call): at
least one listed model → `ok` ("logged in to at least one provider", not validated by a request),
Pi's "No models available" → `missing`, a failing command → `unknown`. Rows count only after the
`provider model …` header.
Note: `ready` only means "credentials present". Live #1 got a 401 on a key that `auth check` called ready.

## Fast tier (WP35, feature-parity row 39)

`fast: "on"` (Pi-only, `src/core/fast-tier.ts` eligible OpenAI models, `service_tier: priority`):

- **Who sets it.** The task backend passes `fast: "on"` and `fastApi` (the API the compiler bound for
  the model) as per-task descriptor config, only when the task asks for it **and** the run's recorded
  negotiation accepted `fastTier`. `fastTier` is `unverified`, so a run needs
  `allowUnverifiedCapabilities: ["fastTier"]`; without it the preview records
  `fastTier: degraded — runs without fast tier` and the worker runs without it.
- **Guard** (generated wrapper → `registerFastTierGuard`, `run-extension.ts`; ported from pi-workflow
  `installWorkflowFastProviderGuard`/`createWorkflowFastProviderStream`):
  - The wrapper imports `streamOpenAIResponses`, `streamOpenAICodexResponses` and
    `clampThinkingLevel` from Pi's own `@earendil-works/pi-ai/compat` and hands them in, so the module
    stays Pi-free.
  - On `session_start` it re-registers the bound provider (`openai` or `openai-codex`) through
    `ctx.modelRegistry.registerProvider` with a stream that checks the model binding
    (provider/id/api), sends `serviceTier: priority`, chains any upstream `onPayload` and stamps
    `service_tier` on the payload, and clamps the reasoning level to the model.
  - `before_provider_request` still checks the binding and stamps `service_tier: priority`.
- **Failure:** any binding mismatch (model or payload) calls `ctx.abort()`, writes `status: failed`
  with the reason to `<attempt>/pi-fast-tier.json` and a `agent-workflow: fast tier failed: …` line to
  stderr. The attempt then fails as `config` with `fast tier failed: <reason>` (instead of Pi's
  generic `unknown` abort); the error table also maps the text to `config`.
- **Degrade:** without a provider registry (or stream functions) the guard reports
  `status: payload-only` (state file + `agent-workflow: fast tier degraded to the payload hook …` on
  stderr) and only the payload hook requests the tier. The attempt outcome does not change.
- State file fields: `status` (`pending` | `guarded` | `payload-only` | `failed`), the binding,
  `guardedRequests`, `payloadRequests`, `reason`.
- **Unverified:** tests use fake provider streams (`executor-wp35-fast-guard.test.mjs`). Live bundle 5
  must show a real OpenAI request served with `service_tier: priority`.

## Errors (`PI_ERROR_RULES`; first match wins, else `unknown`)

Pi **exits 0** after a provider error. The terminal state comes from the last assistant `stopReason: "error"`
plus `errorMessage`, then from the exit code and stderr.

| Text | Class | Evidence |
|---|---|---|
| context length / window exceeded (pi-subagent pattern) | permanent | source |
| `Model "<x>" not found` (exit 1, before any request) | config | offline transcript `fail-config-model-not-found` |
| `Unknown option`, `Invalid thinking level` | config | source |
| `workflow fast mode … binding mismatch`, `fast tier failed` (WP35 fast-tier guard) | config | offline (fake provider stream) |
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

Attempt records (`<stateDir>/attempts/<sha256(attemptKey)>.json`, default `~/.agent-workflow/executors/pi`;
WP18b: `exited`/`revoked` records, or `spawned` ones whose process is gone, older than 7 days are
pruned with the adapter's own `<stateDir>/runs/<h>/`, on submit at most every 6 h and by
`agent-workflow prune`; WP19 (review #2): a launched attempt's record (`spawned` or `exited`) is not deleted but replaced by a compact tombstone (`agent-workflow-attempt-tombstone-v1`: attemptKey, the exit as outcome, finishedAt, prunedAt); reconcile reads it as `unknown` ("launched, record pruned"), never `absent`, and submit refuses that attemptKey, so an orphaned workflow never retries an attempt that already ran. Tombstones are never pruned; only `revoked` (never-launched) records are removed. WP19 (review #3): the adapter's `runs/<h>/` dir is removed only when `runs/` and every other ancestor up to the state dir is a real directory and the parent resolves inside the state dir's real path; a symlinked ancestor is refused.):

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
- **Fast tier is unverified.** The provider-stream guard is ported (WP35) and tested with fake
  provider streams only; no live check was done.
- Model matching: Pi's `--model` accepts fuzzy matches. An unknown `provider/id:suffix` is sent as a custom id
  (live #1). The engine should pass exact `provider/id`.
- Pi's free-tier/subscription billing is not reflected: cost is a catalog estimate.

## Permission mode (WP4e)

Pi has no approval prompts in `--mode json --print` and no sandbox, so `free` and `safe` produce the
same argv: every requested tool (D2 revised, [`../permissions.md`](../permissions.md)). A readOnly
request drops mutating tools from `--tools` in both modes. The conformance harness documents this as
`equivalent` (`PI_PERMISSION_MODE_SETTINGS`, check `permission.mode_mapping`).

## Change log

- **WP35 (2026-10-28, feature-parity rows 39, 40, 57; offline only, no model call):**
  - Host tools: the Pi host lends native codemode/MCP; the engine honors `inheritHostTools` only on
    this executor; readOnly stages never inherit; per-task descriptor config `inheritHostTools`;
    preview notice. Test: `executor-wp35-host-tools.test.mjs`.
  - Fast tier: provider-stream guard ported, failure → `config`, degrade → `payload-only`, state in
    `pi-fast-tier.json`; per-task `fast`/`fastApi` only when negotiation accepted `fastTier`.
    `fastTier` stays `unverified`. Test: `executor-wp35-fast-guard.test.mjs`.
  - Web tools: `pi-web-access` stays unbundled; probe note/warning with the install command in the
    preview, refusals and `doctor`. Test: `executor-wp35-web-access.test.mjs`.
  - Live bundle 5 must check: a Pi host run whose worker calls an inherited `mcp__*`/codemode tool;
    a `fast: on` run whose OpenAI request carries `service_tier: priority` (state `guarded`); the
    generated wrapper's `pi-ai/compat` import loading in a real Pi.

- **WP12d-2 review #10:** same ordering checked: the `spawn` wait had its `error` listener, but the
  stdout/stderr/`close` handlers were attached after the awaited `spawned` record write, so a Pi that
  exited during that write was never observed (drain hung). Handlers are now attached before any
  await; record writes are serialized so `exited` lands after `spawned` and a late identity write
  never overwrites `exited`. Test: `executor-wp12d2-spawn-handlers.test.mjs`.

- **WP12d-2 review #9 (checked, no change):** Pi ownership is by location: sessions are created only
  under the adapter's private `<stateDir>/sessions/`, resume accepts only a session found there, and
  `deleteOwnedSession` refuses any path outside it, so a user session can neither be resumed as owned
  nor deleted.

- **WP12d-2 review #6:** injected MCP servers no longer bypass readOnly. `--tools` declares the
  engine's artifact server by its one read-only tool (`mcp__workflow_artifact__workflow_artifact`)
  instead of `mcp__workflow_artifact__*`. Pi has no approval gate, so a readOnly request that injects
  any other server is refused before consume with `CAPABILITY_MISSING:readOnly`; on non-readOnly
  requests a caller-injected server keeps `mcp__<server>__*`. The conformance kit's `mcp_tool`
  requests are now non-readOnly. Tests: `executor-wp12d2-mcp-readonly.test.mjs`,
  `executor-pi-adapter.test.mjs`.

- **WP12d-2 review #5:** same exposure checked: stdout lines were redacted per line, but stderr per
  chunk, so a value split across two chunks reached `pi-stderr.log` and the failure text. stderr now
  goes through the shared stream redactor (`src/executors/redact.ts`). Residual: `pi-mcp.log` is
  written by Pi's own MCP extension inside the child and is not post-processed. Test:
  `executor-wp12d2-secret-echo.test.mjs`.

- **WP12d-2 review #3:** unreadable launch evidence is no longer proven absence. `PiAttemptStore.lookup` returns `missing` only on
  ENOENT; a record that cannot be read, does not parse, has the wrong schema/phase or names another
  attemptKey is `unreadable`: `reconcile` answers `unknown` (the runtime records
  `failed/needs_decision`, `src/runtime/orchestrate/reconcile.ts` already maps every non-`absent`
  outcome there and is unchanged), `submit` refuses with `AUTHORITY_ALREADY_CONSUMED` before consuming
  the authority, and `cancel` answers `uncertain`. The first (`pending`) record is now created by hard-linking a fully written temp file; a lost claim race answers `AUTHORITY_ALREADY_CONSUMED` (was `INVALID_REQUEST`). Test: `executor-wp12d2-evidence.test.mjs`
  (malformed, empty, directory and mismatched records for all three adapters).

- **WP12a (2026-10-27):** usage events carry `cacheWrite` (Pi `usage.cacheWrite`) and `model` (the
  assistant message's model), so Pi tasks record their model; Pi's `input` already excludes cache
  reads and writes (docs/core-port.md WP12a change log 3). Tests: `executor-pi-parse.test.mjs`,
  `core-wp12a-usage-normalized.test.mjs`.

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
    the adapter loads it with `-e`, and refuses `CAPABILITY_MISSING:webTools` when it is not installed
    (WP35: with the install command in the preview, the refusal and `doctor`).
  - Results are model-reported (`safetyPolicy: unknown`).
- **WP11 (hosts):**
  - Pass `inheritHostTools`, `fast`/`fastApi` (from `resolveWorkflowFastModeConfig`) and `toolResultBudget`
    as **per-task descriptor config**. The descriptor is digested into the execution plan. (WP35:
    `inheritHostTools` and `fast`/`fastApi` done; `toolResultBudget` still open.)
  - Never pass secrets in config.
  - Retention should call `deleteOwnedSession(ownedSession)`, which deletes only under `<stateDir>/sessions`.
- **WP4c:**
  - Done in WP5b: the engine derives the artifact server limit (18432) from the recorded probe.
  - Use exact `provider/id` models.
  - Expect `failed.class` per the table above, and `cancelled` for engine cancels.
