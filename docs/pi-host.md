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

The package manifest declares only the extension. The bundled `skills/` are not exposed through Pi:
their names (`workflow-guide`, `execution-router`) equal pi-workflow's skills.

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
| `wait <run> [--timeout D]` | `waitAction` — one call, at most 45 s |
| `resume <run> [--detach]` | `resumeAction` |
| `stop <run>` | `stopAction` |
| `prune [--keep N] [--older-than DAYS] [--yes]` | `pruneAction` |
| `notices list \| acknowledge <run> --state <sha256> --reason <text> \| clear <run>` | `noticesAction` |

Run options (leading or trailing, quoted text is literal; the host API parser
`parseWorkflowRunArgs`): `--executor <id> --profile <name> --permission-mode free|safe
--allow-unverified <a,b> --model <id> --effort <level> --input <key=value> (repeatable) --detach
--force-new`.

`/aw run` returns once the run is launched. The engine's in-process watcher keeps driving it while
the Pi session lives; `/aw wait`, `/aw status` or `aw_wait` show progress, `--detach` hands it to a
standalone supervisor that outlives the session. `supervise` is CLI-only.

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
| `aw_run` | `workflow`, `task`, `executor?`, `profile?`, `permissionMode?` (`free`/`safe`), `allowUnverified?` (string[]), `model?`, `effort?`, `detach?`, `forceNew?`, `inputs?` (object) | `runWorkflowAction` |
| `aw_dynamic` | `task` and the same options | `runDynamicAction` |
| `aw_wait` | `runId`, `timeoutMs?` (1000-45000) | `waitAction` |

Results: `content` is the handler text; `details` is the handler `data` plus `outcome`/`ok`.
Launches add `waitWith`; a refused launch is returned with `isError: true` (the refusal code is in
`details.refusal`). WP16: an identical launch while the first run is active (also with `detach`) is
not an error: `details.outcome` is `existing`, `details.runId`/`duplicateOf` name that run and
`waitWith` points at it; `forceNew: true` starts another run. `aw_wait` returns `terminal`, `actionRequired`, `stillRunning`, `semanticStatus`,
`preview` (bounded authoritative result), `reportArtifacts`, `taskSummary`, … and streams progress
through `onUpdate`. Each call waits at most 45 s (the host API cap); the guidelines tell the agent to
call it again while `stillRunning` is true. Cancelling a tool call cancels only the wait. Unlike
pi-workflow, `aw_run`/`aw_dynamic` have no `awaitTerminal`.

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

## Session start

On `session_start` (not awaited, never delays startup) the host calls
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
status entry, without the board widget or the presentation lease. Only with a UI (TUI or RPC;
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

  Memory (round 4, F4): the confirmation watch (sent, not yet in the history, < 10 min, at most 64
  entries) is separate from the dedup map (epochs enqueued into live queues, at most 256; durable
  entries are evicted first, their receipts still suppress). Confirmed entries and the entries of
  an ended queue lifetime are dropped; durable receipts and the session history are the source of
  truth after eviction. Residual: evicting a *non-durable* entry (its `sent` publication failed)
  of a still-live queue, i.e. more than 256 such entries, falls back to the receipt rules.

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

- No board, widgets or `/aw` with a bare run id (pi-workflow's board TUI is out of scope); the
  status line is one footer entry.
- No presentation lease or parent-usage tracking. `aw_wait` does not check delivery ownership: an
  agent that waited for the result still gets the completion message (for tool launches, a
  follow-up turn).
- A context without a session id gets no status line or delivery (Pi 1.1 has one in TUI and RPC,
  also with `--no-session`).
- No `/aw auto` or TUI profile picker (`/workflow profile`); `/aw profile` manages saved user
  profiles only.
- Runs left running by an earlier Pi session are not resumed at session start (only their status
  line and delivery are restored); attached runs of a gone Pi process need `/aw wait`, `/aw resume`
  or `agent-workflow supervise`.
- `runtimeDefaults` follow the explicit executor only: a profile that selects a non-Pi executor still
  receives Pi's current model as the lowest-precedence default.
