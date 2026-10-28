# Pi host (`@agwab/agent-workflow/hosts/pi`)

WP11b, WP16. A Pi extension over the host API (`docs/host-api.md`): the `/aw` command, four agent
tools (`aw_list`, `aw_run`, `aw_dynamic`, `aw_wait`), an unfinished-run notice at session start and
(WP16) a footer status line plus completion delivery into the session for runs it launched.
The parent agent is Pi; the workflow **workers** run on whichever executor is selected (`--executor`,
a profile, or the default `pi`). Every action calls one host API handler, so the Pi host, the
`agent-workflow` CLI (`docs/cli.md`) and the stage-2 MCP host behave the same.

Sources: `src/hosts/pi/` — `index.ts` (package entry and Pi presence check), `extension.ts`
(registration), `command.ts` (`/aw`), `tools.ts` (`aw_*`), `notices.ts` (session start),
`feedback.ts` (WP16 status line and completion delivery), `host.ts` (host context, confirmation,
profile choice, output), `names.ts`, `pi-types.ts` (the Pi API subset used).

## Install

Pi 1.1 or newer. The Pi packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`) are optional
peer dependencies: Pi provides them to extensions, nothing else in agent-workflow needs them.

```sh
# one invocation, without changing Pi settings
pi -e ./node_modules/@agwab/agent-workflow/dist/hosts/pi/index.js
pi -e npm:@agwab/agent-workflow

# install as a Pi package (package.json "pi.extensions": ["./dist/hosts/pi/index.js"])
pi install npm:@agwab/agent-workflow        # personal; add -l for the project
```

The package manifest declares the extension and (WP33, owner decision Q10) two Pi skills with the
`aw-` prefix: `aw-workflow-guide` (workflow authoring, scaffolds) and `aw-execution-router` (route
recommendation). Pi resolves a skill by its frontmatter `name` (not the directory) and keeps the first
skill of a name, and pi-workflow ships `workflow-guide` and `execution-router`, so the Pi copies are
renamed: `node tools/release/plugins.mjs build` generates `plugins/pi/skills/aw-*/SKILL.md` from
`skills/` (the source of truth; only the name, the relative paths into the package and the skill
cross-reference change; `check` fails on drift) and package.json `pi.skills` lists them. The
`agent-workflow` skill (the MCP tool protocol) is not exposed in Pi: the `aw_*` tools carry their own
prompt guidelines. Use them with `/skill:aw-workflow-guide` or `/skill:aw-execution-router`.

Importing `@agwab/agent-workflow/hosts/pi` outside Pi without the peer fails with
`PiHostUnavailableError` ("… is a Pi extension and needs the Pi coding agent …") instead of a bare
module-resolution error. No other module of the package imports the Pi host (a unit test checks
`src/` and `dist/`).

## `/aw` command

`/aw help` lists the actions; `/aw help <action>` shows the shared help of one action (the CLI help
with `/aw`). Output is the handler's `text`, shown as a Pi notification (stdout/stderr in print/JSON
mode); errors are error notifications.

| `/aw …` | Host API handler |
|---|---|
| `help [action]` | `helpAction` (one action); the action list is Pi-specific |
| `list [--query T] [--offset N] [--limit N]` | `listWorkflowsAction` |
| `validate <workflow>`, `roles <workflow>` | `validateWorkflowAction`, `workflowRolesAction` |
| `agents` | `listAgentsAction` |
| `profile list \| show [name] \| set <name> … [--default] \| delete <name> \| default <name> \| default --clear` | `profileAction` (saved user profiles; same options as the CLI) |
| `run <workflow> <task> [options]` | `runWorkflowAction` |
| `dynamic <task> [options]` | `runDynamicAction` |
| `status [run]` | `statusAction` |
| `show <workflow>` / `show <run> [--raw]` | `showAction` |
| `inspect <run> [--failures] [--results]` | `inspectAction` |
| `logs <run> [--task <id>] [--lines N] [--stream output\|stderr\|events\|all]` | `logsAction` (WP16): bounded, redacted tail of task output, stderr and executor events (WP19: contained to `.agent-workflow/`, structured credentials redacted; the completion message is redacted the same way) |
| `wait <run> [timeout \| --timeout D]` | `waitAction` with `longWait` (WP28): until the run is terminal or needs action, or the timeout passes; default 60 s (pi-workflow `/workflow wait`), max 4 h; a bare number is milliseconds |
| `resume <run> [--detach]` | `resumeAction` |
| `approve <run> [--request <id>] [--reject] [--detach] [--yes]` | `approveAction` (WP29): answers a dynamic-controller approval the run waits on through `ctx.ui.confirm`; without a dialog UI `--yes` is required |
| `stop <run>` | `stopAction` |
| `prune [--keep N] [--older-than DAYS] [--yes]` | `pruneAction` |
| `notices list \| acknowledge <run> --state <sha256> --reason <text> \| clear <run>` | `noticesAction` |

Run options (leading or trailing, quoted text is literal; the host API parser
`parseWorkflowRunArgs`): `--executor <id> --profile <name> --permission-mode free|safe
--allow-unverified <a,b> --model <id> --effort <level> --input <key=value> (repeatable) --detach
--force-new`.

`/aw run` returns once the run is launched. The engine's in-process watcher keeps driving it while
the Pi session lives; `/aw wait`, `/aw status` or `aw_wait` show progress, `--detach` hands it to a
standalone supervisor that outlives the session. `supervise` is CLI-only (MCP: `workflow_supervise`).

Run texts name `/aw …` follow-up commands (`Open: /aw status <run>`, `Resume: /aw resume <run>`,
`/aw logs <run> --task <task>`): the Pi host passes `host: "pi"` and the host API picks the hints
(WP18b, [host-api.md](host-api.md#common-contract)). `piHostText` remains only as a fallback for the
few ported core messages that still name pi-workflow's `/workflow` (for example the `auto`/profile
messages): it points them at `/aw`, because `/workflow` belongs to pi-workflow and its own run store.

## Tools

Schemas, descriptions and prompt guidelines are adapted from pi-workflow's
`workflow_list/run/dynamic/wait` with executor-neutral wording.

| Tool | Parameters | Handler |
|---|---|---|
| `aw_list` | `query?`, `offset?`, `limit?` (1-20, default 20) | `listWorkflowsAction` |
| `aw_run` | `workflow`, `task`, `executor?`, `profile?`, `permissionMode?` (`free`/`safe`), `allowUnverified?` (string[]), `model?`, `effort?`, `detach?`, `forceNew?`, `inputs?` (object), `awaitTerminal?`, `timeoutMs?` (1000-14400000, needs `awaitTerminal`) | `runWorkflowAction` (+ `waitAction` with `awaitTerminal`) |
| `aw_dynamic` | `task` and the same options | `runDynamicAction` (+ `waitAction`) |
| `aw_wait` | `runId`, `timeoutMs?` (1000-14400000, default 1800000) | `waitAction` with `longWait` |

Exposure (WP28): with `AGENT_WORKFLOW_TOOL_EXPOSURE=deferred` every `aw_*` tool is registered with
`exposure: "deferred"`, so Pi keeps it out of each request until `tool_search` loads it (port of
pi-workflow's `PI_WORKFLOW_TOOL_EXPOSURE`; [environment.md](environment.md)). Unset or any other
value: normal registration.

Results: `content` is the handler text; `details` is the handler `data` plus `outcome`/`ok`.
Launches add `waitWith`; a refused launch is returned with `isError: true` (the refusal code is in
`details.refusal`). WP16: an identical launch while the first run is active (also with `detach`) is
not an error: `details.outcome` is `existing`, `details.runId`/`duplicateOf` name that run and
`waitWith` points at it; `forceNew: true` starts another run. `aw_wait` returns `terminal`, `actionRequired`, `stillRunning`, `semanticStatus`,
`preview` (bounded authoritative result), `reportArtifacts`, `taskSummary`, … and streams progress
through `onUpdate`. WP28 (owner decision Q9, ported from pi-workflow `workflow_wait`/`awaitTerminal`):
`aw_wait` waits until the run is terminal or needs action, or `timeoutMs` passes (default 30 min,
max 4 h; the host API `longWait`); `stillRunning: true` only means the timeout came first.
`aw_run`/`aw_dynamic` with `awaitTerminal: true` launch and then wait the same way and return the
wait result (`details` = wait data plus `launch` = the launch details); `detach` and `awaitTerminal`
are mutually exclusive and `timeoutMs` requires `awaitTerminal`. Cancelling a tool call cancels only
the wait. An awaited result is not delivered again as a completion message; when the wait ends
first (timeout or cancel) the run is tracked like a plain tool launch and reports back when it
settles. The MCP server keeps its 45 s cap; the CLI is unchanged.

`inputs` (WP12c) is the tool form of `--input`: an object of declared workflow inputs, passed to the
host API as `inputOverrides` and typed there like the CLI's strings (a string is converted for a
number, boolean or JSON default; any other value must already have the declared type; an undeclared
key is refused before anything starts; [`usage.md`](usage.md#workflow-inputs---input-keyvalue)).

Usage errors (unknown parameter, bad permission mode, undeclared or mistyped input, unknown run)
throw, so Pi reports a failed tool result with the host API message.

## Confirmation and profile choice

When the session has a dialog-capable UI (`ctx.hasUI`: TUI and RPC), launches from `/aw` and the
tools are interactive: a capability degradation that needs confirmation (WP4d) asks
`ctx.ui.confirm("Proceed with these executor capability degradations?", <preview>)`; declining
refuses the launch (`CAPABILITY_DEGRADATION_DECLINED`, no run). A workflow that declares execution
profiles and none is named offers them through `ctx.ui.select`. Without a UI (print/JSON mode)
launches are non-interactive: degradations are recorded (`non-interactive`) and the run proceeds.

Profile text fallback (WP16): without a dialog UI, a workflow that declares execution profiles and
none is named runs with the headless choice (the declared default, else the base spec) and the
launch output (command text or tool `content`) ends with

```
Execution profile (no dialog UI): the workflow declares execution profiles; this launch used "Profile: fast". Choose another with:
  --profile fast (used)
  --profile deep
  Base (no profile)
```

(the host API passes the headless option as `selectProfile(title, options, {headlessOption})`). A
saved per-workflow Pi preference or `--profile` skips the choice, as before.

Host context per call: `cwd` = Pi's cwd; `availableModels` = Pi's model registry (so saved
per-workflow Pi profile preferences apply; WP19 round 2: the preference, resolved once with its stage
overrides, is part of the duplicate-launch identity and the run is launched from that same
resolution, so changing it starts a new run); `runtimeDefaults` = Pi's current model and thinking level,
only when no executor or `pi` is selected — a `--executor codex` run does not inherit Pi's model.

## Dynamic-controller approval (WP29)

pi-workflow's `dynamicUiFromContext` ported: when the session has a dialog UI (`ctx.hasUI`, not
print/JSON mode), the host context carries `dynamicUi` (`host.ts` `piDynamicUi`), so a dynamic stage
whose controller declares `dynamic.permissions.approval: "ask"` is asked while this session drives
the run: attached `/aw run|dynamic`, `aw_run`/`aw_dynamic` (with `awaitTerminal`), `aw_wait`,
`/aw wait`, `/aw resume` and the session-start re-drive. The dialog is
`ctx.ui.confirm("Run dynamic workflow controller?", <scope>, {timeout: 300000, signal})`: yes runs
the controller (recorded as `decidedBy: {host: "pi", via: "prompt"}`), no rejects it for this run
(`dynamic_approval_rejected`, never asked again), a timeout leaves it blocked and resumable
(`dynamic_approval_timeout`). `--detach` launches and resumes never ask (their supervisor has no UI),
and print/JSON mode keeps `dynamic_ui_unavailable`; the blocked message, `/aw status` and `/aw wait`
name `/aw approve <run> --request <id>` (and `--reject`).

`/aw approve <run>` answers an open approval later (also one a detached run, the CLI or an MCP
client left): the same confirm dialog; yes approves and resumes the run (tracked for the status line
and completion delivery like `/aw resume`; completed tasks are not relaunched), no rejects. Without a
dialog UI it needs `--yes`, and the flags are the decision. Agents get no `aw_approve` tool: an
approval is the user's decision.

## Host tools for Pi workers (WP35)

A Pi 1.1 session with native MCP (`pi.getMcpServers`) and project trust (`ctx.isProjectTrusted`) — the
same check as pi-workflow's native host context — lends its native tools to Pi workers:

- `hostContext()` adds `hostTools: { projectTrusted }` (`piNativeHostTools`, `src/hosts/pi/host.ts`).
- The host API launch then sets the run option `inheritHostTools` and records the run's host context
  (`run.hostContext`: cwd, agent-workflow home, project trust; references only, never MCP
  configuration or credentials).
- The engine honors it only when the run's executor is `pi`; a `--executor codex|claude` run (or a
  profile that selects one) is unchanged. Codex/Claude user-MCP inheritance is a separate opt-in
  (B6), not this flag.
- Each non-readOnly Pi worker gets `codemode`, `tool_search`, `mcp__*`, `list_mcp_resources`,
  `list_mcp_resource_templates` and `read_mcp_resource` (Pi executor, `docs/executors/pi.md`).
  These are mutation-capable: the stage is classified so, and the worktree/approval rules of the
  permission mode apply.
- A stage that declares `readOnly` never inherits them (compile records `inheritHostTools: false`);
  a stage forced readOnly by negotiation gets none either (the Pi executor drops them).
- The capability preview and `run.capabilityNegotiation.notices` record a `host tools: …` notice
  naming the inheriting stages and the readOnly stages that do not inherit.
- Older Pi hosts (no native MCP) and the CLI/MCP hosts launch exactly as before.

## Session start

On `session_start` (not awaited, never delays startup; supervisor role only) the host first
re-drives running runs (WP28, port of pi-workflow `resumeSupervisors`, `src/engine.ts:2628`):
`redriveRunsAction` schedules every run of the project that still has scheduler work and that no
other live process drives (a held run lease, or a `supervisor.json`/`supervisor-lease.json`
heartbeat younger than 30 s from a live pid other than this Pi process), then keeps watching it in
this process. So an attached run whose Pi session (or CLI, or `detach: false` MCP server) ended
continues when Pi starts again in the project; a detached run whose supervisor is alive, or a run
another Pi session drives, is left alone. Re-driving only schedules: a blocked run stays blocked,
and an attempt whose worker died without a terminal record is reconciled by the engine, where an
`unknown` outcome blocks the task as `executor_needs_decision` (B3), never a relaunch. Delivery is
not taken over: nothing is bound, so the completion message still goes only to the run's WP16
audience session (when that session starts, its catch-up delivers it). Then the host calls
`noticesAction({argv: ["list"]})` and shows one warning notification listing unfinished runs (port of
pi-workflow `notifyUnfinishedRuns`): top-level failed/interrupted runs and blocked runs waiting for a
dynamic approval or an executor decision, excluding mock runs, runs with an active acknowledgement
and runs not updated for 7 days; at most 5 listed, each with `/aw resume <run>`. A run is notified
again only when its status/updatedAt changed, its acknowledgement became stale, or 6 hours passed
(state: `.agent-workflow/workflows/unfinished-notices.json`). Silence a run with
`/aw notices acknowledge <run> --state <sha256> --reason <text>`.

## Status line and completion delivery (WP16)

Port of pi-workflow's feedback delivery (`bindWorkflowFeedbackAudience`, `watchWorkflowFeedback`,
`deliverWorkflowFeedback`, `deliverMissedWorkflowFeedback`, per-epoch receipts) and of its active-run
status entry, without the board widget (WP33 adds the presentation lease, below). Only with a UI (TUI or RPC;
`ctx.hasUI`, not print/JSON mode).

- **Audience.** A run launched (or resumed, or returned as `existing`) by `/aw run|dynamic|resume`,
  `aw_run` or `aw_dynamic` in this session is bound to the Pi session id
  (`ctx.sessionManager.getSessionId()`) in `<run dir>/pi-feedback-audience.json`, created exclusively:
  the first session wins and no other session ever tracks or receives that run, not even through
  an identical launch that the duplicate guard answers with the same run.
- **Status line.** While at least one such run is `running`/`pending`, the footer entry
  `agent-workflow` shows `aw: <name> <completed>/<total> running` (`+N more` with several runs).
  One timer per session polls every second, reads only the tracked runs' `run.json` (the progress
  file the engine or the detached supervisor writes; it never drives a run), calls `setStatus` only
  when the text changes, clears the entry and stops when no tracked run is active, and stops at
  `session_shutdown`.
- **Delivery.** When a tracked run settles — terminal (`completed`, `failed`, `interrupted`) or
  action required (`blocked`) — the session gets one custom message (`customType:
  "agent-workflow-completion"`, `display: true`) with status, task counts, the first problem task,
  `Verdict: <domain verdict>` (WP18b: the output task's `verdict`, for example `NEEDS_WORK`; omitted
  when the workflow reports none) and `Run status: <semantic status>` as separate lines, report
  paths, the bounded result preview, next commands (`/aw status|logs`, or `/aw inspect … --failures`
  and `/aw resume`), and `details` `{runId, name, status, semanticStatus, verdict?, terminal,
  actionRequired, taskSummary, reportArtifacts}`, plus an info or
  warning notification. A run launched by `/aw` (the user) does not start an agent turn
  (`triggerTurn: false`); a run launched by `aw_run`/`aw_dynamic` (the agent) is delivered as a
  `followUp` turn with pi-workflow's "treat as data, summarize/present the result" instruction.
- **Once while Pi runs, at least once after a crash (WP19, review #5).** One delivery per run,
  session and settled state (epoch = SHA-256 of the run status and each task's status, timestamps,
  exit code and resume events; a resumed run that settles again is a new epoch). The receipt
  `<run dir>/pi-feedback-receipts/<epoch>.json` is first a *pending reservation* (`state:
  "pending"`, owner token and pid, written under a per-epoch lock before `pi.sendMessage`). WP19
  round 2 (N2): once `sendMessage` returned it is `state: "sent"`, not a durable acknowledgement
  (while the agent streams, Pi only queues the message in this process's memory); it becomes
  `state: "confirmed"` when Pi's session history (`ctx.sessionManager.getEntries()`) holds an
  `agent-workflow-completion` `custom_message` whose `details` carry this `runId` and
  `feedbackEpoch`. The tracker keeps polling for up to 10 min after a send to confirm it on a
  later tick. Every receipt records its sender: pid, host and a random per-process id (WP19 round
  3). A pending reservation whose owner is gone (a crash between reservation and send) is resolved
  like a `sent` receipt. A throwing send drops the reservation (retried on the next poll, at most 4
  attempts, then an error notification); WP19 round 5: only that unsent attempt is refunded, the
  receipt it replaced is restored with its attempt history (deleting it reset the budget below). An empty or corrupt receipt is never proof of delivery.
  Round-1 `"delivered"` receipts are read as `sent`; receipts written before WP19 count as
  delivered when the history holds the run's message or the history is unreadable.
- **Delivery decision (WP19 round 3 R2/R3, round 4 F1/F3/F4, round 5) — the exact guarantee.** On every
  delivery attempt, whatever the receipt says, in this order:
  1. *This OS process enqueued the epoch into the still-live queue of the current session
     runtime* → never sent again. Pi 1.1 keeps queued messages per session runtime
     (`AgentSession`: the agent's follow-up queue and pending custom messages). `/reload` keeps the
     runtime and its queue; `/new`, `/resume`, `/fork` and quit abort and dispose it
     (`AgentSessionRuntime.teardownCurrent`), dropping what is still queued. The queue lifetime is
     identified by the runtime's `ctx.sessionManager` object (assigned once per `AgentSession`;
     a WeakMap on `globalThis`, `Symbol.for("agent-workflow.pi-feedback.process-state.v2")`, so it
     survives an extension reload and holds no strong reference), and `session_shutdown` with
     `reason` `new`/`resume`/`fork`/`quit` ends it eagerly: that session's epochs become
     "unconfirmed, reconcile against the history", a durable queue-end tombstone is written
     (round 5: `.agent-workflow/pi-feedback-queue-ends/<lifetime>.json` under the session's cwd,
     whatever the bounded in-memory maps still hold), the receipts still in memory are published as
     `sent` with `queueEndedAt`, and their in-memory entries are dropped. `reload` (and an unknown reason)
     keeps them. The identity check also covers a replaced runtime whose shutdown event we missed.
     Suppression is in memory and in the receipt (`queueLifetime` + this process's id), so it
     survives eviction of the in-memory entry.
  2. *Otherwise, readable session history*: present → `confirmed`, nothing sent; absent → sent
     (again). A `confirmed` receipt written by another process does not overrule explicit absence
     (Pi 1.1's `getEntries()` is in memory: a message whose append to the session file failed was
     "seen" and confirmed, yet the restarted session lacks it). Exception: a `sent` (unconfirmed)
     receipt of another *live* Pi process on this host is left to that process only while its
     queue lifetime is confirmed alive: the receipt names a `queueLifetime`, the owner has not
     marked it ended (`queueEndedAt`) nor published a queue-end tombstone for it (round 5) and it
     was sent less than 10 min ago. Such a delivery is `deferred`, not settled: the tracker keeps
     it (also a catch-up one, which never starts a turn) and retries every poll until that queue
     ends, the history shows it or the 10 min pass. Otherwise it is reconciled like any other
     receipt (round 4; round 3 trusted any live owner).
  3. *Otherwise (history unreadable: no `getEntries`, or it throws)*: a `confirmed` receipt is
     final and another live process's `sent` receipt is deferred to it under the same queue
     lifetime/tombstone/10 min rule (round 5; round 4 deferred unconditionally); otherwise the
     epoch is sent again, but every reservation counts (`attempts`), including an orphaned
     `pending` one (sent, then the `sent` publication was lost): at most 2 enqueue attempts per
     epoch (round 4, F3). A reservation whose send provably did not happen (fence, or
     `sendMessage` threw) is refunded without erasing earlier attempts (round 5). Consequence: two consecutive crashes between reservation and `sendMessage` exhaust the
     budget without a message (at-least-once does not hold in that double-crash case).

  | Situation | Messages per epoch |
  |---|---|
  | Normal (one process; queued while streaming, then persisted) | exactly 1 |
  | `/reload` (module re-imported; Pi keeps the runtime and its queue) or tracker stop/restore | exactly 1 (never resent into the live queue) |
  | `/reload` that upgrades the module across a process-state schema (round 5) | at least 1, at most 1 duplicate (older state is only reconciled against the history) |
  | `/new`, `/resume`, `/fork` (queue disposed), session active again in this or a later process | exactly 1 in its history: present → nothing sent; absent (queue dropped) → sent once into the resumed session |
  | Another live Pi process queued it (same session) | deferred and retried while its queue lifetime is alive (≤ 10 min after its send, no tombstone); then reconciled: exactly 1 with readable history |
  | Crash/restart, history readable | 1 if the durable history has it; otherwise 1 more on restart (also after a `confirmed` receipt) |
  | Crash/restart, history unreadable | at most 2 successful enqueue attempts (pending reservations count; a refunded failed send does not erase earlier ones); at least 1 unless two attempts crashed before `sendMessage` |

  Upgrades (round 5): the process state is versioned (the `globalThis` key ends in `.v<schema>`
  and the state records `schema`). Rule: state left by another version of this module may cause
  at most one duplicate, never a loss. A module never reuses state of another key or schema for
  suppression (it starts a fresh state with a new sender id), and an in-memory entry without a
  concrete queue lifetime never counts as "enqueued into this queue": what the older module
  enqueued is reconciled against the history (present → confirmed, absent → sent again;
  unreadable → the receipt's attempt budget). Any incompatible change to the process state must
  bump the schema; older state is only ever downgraded to "reconcile against the history".

  Queue-end tombstones (round 5) are pruned at every write: older than 20 min (a receipt counts as
  queued in a live queue only within 10 min of its send, which precedes the queue end) or beyond
  1024 files (the oldest; a missing one only delays reconciliation to the 10 min window end).
  Round 6: the directory is written or pruned only when it is physically
  `<real cwd>/.agent-workflow/pi-feedback-queue-ends` — neither `.agent-workflow` nor
  `pi-feedback-queue-ends` may be a symlink — otherwise no tombstone is written (recovery waits for
  the 10 min window) and nothing is pruned. Pruning removes only files that are positively ours: a
  `<lifetime>.json` whose content carries the queue-end schema and that lifetime, or a writer's
  `<lifetime>.json.<pid>.<hex>.tmp`; any other file there is left alone.

  Catch-up (round 6): at session start at most 5 catch-up messages are sent in total. A catch-up
  deferred to another live owner reserves one of the 5 slots, so the tracker's later retries of
  deferred catch-ups never push the total past 5.

  Memory (round 4, F4): the confirmation watch (sent, not yet in the history, < 10 min, at most 64
  entries) is separate from the dedup map (epochs enqueued into live queues, at most 256; durable
  entries are evicted first, their receipts still suppress). Confirmed entries and the entries of
  an ended queue lifetime are dropped; durable receipts and the session history are the source of
  truth after eviction. Residual: evicting a *non-durable* entry (its `sent` publication failed)
  of a still-live queue, i.e. more than 256 such entries, falls back to the receipt rules.

- **Session-owned waits (WP33, parity row 20; pi-workflow `workflow_wait` session binding).** The
  session that owns a run (its audience) presents its completion. `aw_wait` refuses a run another
  Pi session owns (`run … is owned by another Pi session`; a context without a session id owns
  nothing); a run no session owns (CLI, MCP, print mode) can be waited on and nothing is recorded.
  While an agent of the owning session waits (`aw_wait`, or `aw_run`/`aw_dynamic` with
  `awaitTerminal`, which now track the run before waiting), the tracker holds an in-process
  *presentation lease* for that run: it keeps the status line but does not send the completion. A
  wait that returns the settled run is its presentation: the receipt of that epoch is written as
  `sent` with `channel: "tool-result"` and `presentedBy`, the run is no longer tracked and the tool
  result's `details.feedbackEpoch` lets the session history confirm it (an `aw_*` `toolResult`
  entry with that `runId` and epoch counts like the completion message). So every WP19 rule above
  applies unchanged: no completion message into the same live queue; after a crash or a disposed
  queue, a history without that tool result gets the message once. A wait that ends first
  (timeout, cancel) releases the lease and the tracker delivers as before. When the message reached
  the session before the wait returned, the result says so (`details.completionAlreadyDelivered`,
  "The completion message of this result was already delivered to this session."). `/aw wait` (a
  user command) does not present: the message still follows.
- **Concurrent deliveries (WP19 round 2, N3).** A delivery keeps in-process ownership of its
  reservation through its final `sent` transition; a concurrent delivery of the same epoch in this
  process returns `in-flight` without sending. Every receipt transition (reserve, drop, sent,
  confirmed) is serialized per receipt (an in-process queue plus the per-epoch directory lock) and
  only rewrites a receipt that still carries the transition's owner token.
- **Session fence (WP19, review #6).** Pi's `sendMessage` goes to the runtime's *current* session
  (there is no session-targeted form). Right before it, synchronously, the delivery re-checks the
  current session id against the audience and the tracker's session generation (bumped on
  `session_start`/`session_shutdown`); on a mismatch nothing is sent, the reservation is dropped
  (`session-changed`) and the delivery stays pending for the audience session's next catch-up.
- **Restart.** At `session_start` (after the unfinished-run notice, not awaited) the host tracks
  this session's runs that are still active and delivers, without a turn, those that settled while
  no Pi process of the session watched (top-level runs updated in the last 7 days, at most 5).
  WP19 round 2 (N7): a `session_shutdown` while this restore awaits a read wins: the restore
  re-checks the session generation and context after each await and right before scheduling, so it
  tracks nothing and starts no timer; a poll that finds no session context clears the timer.

## Active workflows widget and foreground loader (WP33)

Port of pi-workflow's `src/workflow-active-ui.ts` (parity row 23), with a UI only (TUI or RPC; print
and JSON mode show nothing):

- **Widget.** Next to the WP16 footer entry (kept as is) the tracker sets the widget
  `agent-workflow-active` (`ctx.ui.setWidget`, placement `belowEditor`; pi-workflow's is
  `pi-workflow-active`, so both can show): `Active workflows`, then one line per active run of this
  session (`● <name> <completed+running>/<total> <status> · <elapsed>`, newest first, at most 5,
  then `… and N more`). It lists only the runs this session tracks (its audience), not every
  running run of the project as pi-workflow did, is rewritten only when its text changes, and is
  cleared when no tracked run is active and at session shutdown.
- **Loader.** `/aw wait <run>` blocks the session, so in the TUI (`ctx.mode === "tui"`) it runs
  behind Pi's cancellable `BorderedLoader` (`ctx.ui.custom`; "Waiting for <run> (Esc stops
  waiting; the run continues)…"). Escape cancels only the wait (WP28): the command reports
  `Stopped waiting for <run>; the run continues …` and the run keeps going (tracked runs still
  report back). RPC mode has no `ctx.ui.custom` and runs the wait as before. `/aw run`, `dynamic`,
  `resume` and `approve` return once started, so they need no loader; the agent's `aw_wait` and
  awaited launches are tool calls (Pi shows their progress; aborting the turn cancels the wait).

## Parent-session usage (WP33)

Port of pi-workflow's `parent-usage.json` (`src/workflow-parent-usage.ts`, ported as
`src/core/workflow-parent-usage.ts`; parity row 33). A run that `/aw run|dynamic|resume|approve`,
`aw_run` or `aw_dynamic` started (or returned as `existing`) in this session is tracked under the Pi
session id; every parent assistant message (`message_end` with `usage`) while the run is active adds
its usage (input, output, total, cache read/write, reasoning tokens, cost) to
`<run dir>/parent-usage.json`, and the first assistant message after the run settled is counted once
as the wrap-up (`completedAt`). `session_start` resumes counting for this session's running runs,
`session_shutdown` flushes and detaches. The core module's rules apply (one writer under the run's
lease, replay receipts, a run owned by another session — its `pi-feedback-audience.json` — is never
written). The sidecar holds only numbers, timestamps, the session id and message hashes, never message
content. It needs a session id, not a UI (print mode counts too). `status <run>` and `inspect <run>`
(every host) show `Parent session usage: <total> tokens (in …, out …, cache read/write …/…), $<cost>,
<n> assistant messages` (`(counting)` while open) and return it as `parentUsage` (totals only). Other
hosts record none: an MCP server cannot see its host's usage.

## Process roles

With `AGENT_WORKFLOW_ROLE=worker` or `disabled` (a Pi worker that loads this package) the tools are not
registered and no notice is shown; `/aw help` and `/aw validate` still work and other actions are
refused by the host API.

## Coexistence with pi-workflow

pi-workflow (`@agwab/pi-workflow`) may be installed at the same time (A2-1/A2-2). The Pi host uses
`/aw` and `aw_*`, never `/workflow` or `workflow_*`; a unit test registers both name sets in one fake
`ExtensionAPI` (which throws on a duplicate) in both orders, and the live RPC check loads both
extensions in one real Pi. Run stores differ: agent-workflow uses `.agent-workflow/`, pi-workflow
`.pi/workflows/`; each command only sees its own runs.

## Verification

- WP33: `host-wp33-pi-owned-wait.test.mjs` (aw_wait presents the result of this session's run, no
  completion message follows; another session is refused; unowned runs; a timed-out wait leaves
  delivery to the tracker; already-delivered note; awaited duplicate launch; restart with and
  without the tool result in the history).
- WP33: `host-wp33-pi-active-ui.test.mjs` (widget lines, this session only, footer kept, cleared;
  no UI shows nothing; `/aw wait` loader in the TUI, Escape cancels only the wait; no loader in RPC).
- WP33: `host-wp33-pi-parent-usage.test.mjs` (totals of this session's assistant messages while the
  run is active, not other sessions', not content; wrap-up counted once; status/inspect line; CLI
  runs record nothing; print mode counts).
- WP33: `host-wp33-launch-capture.test.mjs` (launch capture from the CLI, `/aw`, `aw_dynamic` and
  MCP; redaction; show/inspect) and `host-wp33-pi-skills.test.mjs` (`pi.skills`, `aw-` names, no
  collision with pi-workflow's skills, generated copies in sync, relative paths resolve).
- WP28: `host-wp28-pi-waits.test.mjs` (long `aw_wait`, `awaitTerminal` on `aw_run`/`aw_dynamic`,
  cancel = only the wait, no second delivery of an awaited result, `/aw wait <run> [timeout]`),
  `host-wp28-pi-redrive.test.mjs` (a child process launches an attached run and exits; session start
  re-drives it, B3 decision instead of a relaunch after a killed worker, audience kept, live drivers
  skipped), `host-wp28-pi-exposure.test.mjs` (deferred tool exposure).
- WP29: `host-wp29-pi-approval.test.mjs` (confirm yes runs the controller, no rejects it, json mode
  blocks with the approve commands, `/aw resume` asks the open approval), `host-wp29-approve-later.test.mjs`
  (`/aw approve` through the dialog, `--yes` without one).
- WP35: `test/unit/executor-wp35-host-tools.test.mjs` (fake native Pi host → `hostTools`; Pi host +
  pi executor → per-task `inheritHostTools`, readOnly stage excluded, preview notice; Pi executor
  argv with/without readOnly; non-Pi host and non-pi executor unchanged; provenance fails closed for
  other executors).
- `test/unit/host-pi-extension.test.mjs`: fake `ExtensionAPI`; every action and tool delegates to the
  right handler with the right arguments (a recording wrapper over the real host API); runs use the
  WP11a guarded test-executor hook; confirmation (decline, accept, no UI); session-start notices
  (eligibility, dedup, acknowledgement, non-blocking); worker role; no-collision; entry guard and
  import isolation.
- WP16: `host-wp16-guard.test.mjs` (duplicate guard through the host API, the CLI, `aw_run` and the
  host MCP server: identical detached launches → one run, different inputs/options, `forceNew`, a
  terminal run, concurrent launches), `host-wp16-logs.test.mjs` (bounds, redaction, CLI and
  `/aw logs`), `host-wp16-pi-feedback.test.mjs` (fake Pi UI: status lifecycle, one delivery,
  receipts across a simulated restart and catch-up, other session never delivered, failed send
  retried, no UI, blocked message, profile dialog vs text fallback), `host-wp16-pi-rpc.test.mjs`
  (real Pi in RPC mode, no model turn: `/aw run` on the guarded test executor → `setStatus`
  `aw: wp16-rpc 0/1 running`, an identical `/aw run` → `Duplicate launch guard`, one
  `agent-workflow-completion` custom message, status cleared, `/aw logs <run>` and
  `/aw status <run>`; recorded transcript `test/fixtures/host-pi/rpc-wp16-transcript.jsonl`, live with
  `AGENT_WORKFLOW_PI_BIN`).
- `test/unit/host-pi-rpc.test.mjs`: real Pi 1.1 in RPC mode with no model turn — `/aw help`,
  `/aw list`, `/aw validate deep-review` are answered with `disposition: "handled"` and the expected
  notification text; nothing but responses and extension UI records is emitted. The scrubbed
  transcript `test/fixtures/host-pi/rpc-aw-transcript.jsonl` is checked on every run; the live check
  runs with `AGENT_WORKFLOW_PI_BIN=<path to pi>` (re-record with `AGENT_WORKFLOW_PI_RPC_RECORD=1`; add
  `AGENT_WORKFLOW_PI_WORKFLOW_EXTENSION=<pi-workflow src/extension.ts>` for the coexistence check).

## Limits

- No board or `/aw` with a bare run id (pi-workflow's board TUI is out of scope); the session's
  runs show in one footer entry and the active-workflows widget (WP33).
- The `/aw wait` loader shares Pi's editor slot with dialogs: a dynamic-controller approval asked
  during the wait (WP29) replaces the loader; the wait continues after the answer, without the
  loader (cancel it with a new `/aw wait` … Escape, or let it finish).
- A context without a session id gets no status line or delivery (Pi 1.1 has one in TUI and RPC,
  also with `--no-session`).
- No `/aw auto` or TUI profile picker (`/workflow profile`); `/aw profile` manages saved user
  profiles only.
- Runs left running by a gone process are re-driven at session start (WP28) only while Pi runs;
  for a run that should outlive every session use `--detach` (or `agent-workflow supervise`).
- Host tools (WP35) are file-configuration inheritance, as in pi-workflow: workers read the user's
  `mcp.json` themselves; live MCP connections and `registerMcpServer()` registrations of the parent
  session are not transferred. Under isolation (`--no-approve`) a trusted project's `.pi/mcp.json`
  is not loaded by the worker (pi-workflow loaded it); the recorded project trust is not yet used.
  Not live-verified (live bundle 5).
- `runtimeDefaults` follow the explicit executor only: a profile that selects a non-Pi executor still
  receives Pi's current model as the lowest-precedence default.
