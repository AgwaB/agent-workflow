# Replay acceptance (WP1b)

WP1b checks that the ported engine behaves like pi-workflow. It needs no model and no agent CLI. WP1a
recorded five pi-workflow runs (`test/replay/fixtures/{minimal,deep-review,spec-review,impact-review,deep-research}`):
the `runSubagent` calls, the worker attempt results, and the final run directory. WP1b runs each
fixture's **original** workflow spec through the agent-workflow engine and compares the new run
directory with the recorded one, difference by difference.

```
engine (src/core) → core task backend → runtime durable worker (fresh process) → replay executor
```

- Run everything: `npm run build && node test/replay/acceptance.mjs --write`. This rewrites
  `test/replay/acceptance/<fixture>.{md,json}`.
- One variant: `node test/replay/acceptance.mjs spec-review:state-path-migrated --keep`.
- Test: `test/unit/replay-acceptance.test.mjs`, which runs all fixtures (about 1 minute).

## Driver (`test/replay/replay-driver.mjs`)

- **Project.** The driver rebuilds the recorded project from the WP1a host pins in `fixture.json`:
  - `replayRoot` is the exact recorded path: `/private/tmp/piwf-replay-roots/<name>`, macOS only. Use of
    the path is serialized with the sibling lock `<replayRoot>.lock`.
  - `rootPathLength` is the length the project path is padded to.
  - Project files and agents are installed at `<project>/.pi/agents/<agent>.md`, the legacy location the
    engine reads (core-port WP4b "Legacy read").
- **Spec.** For bundled workflows the driver uses the frozen `run/bundle/` copy, placed at
  `<PKG>/workflows/<name>/`. That copy is byte-identical to pi-workflow `b83cc4f:workflows/<name>/`;
  `verifyBundleAgainstSource` checks this when `PI_WORKFLOW_SOURCE` points at a pi-workflow checkout.
  `minimal` uses the recorded `project/workflow.json`. The driver passes the same task, execution
  profile and input overrides as the recording, and maps the env pins `PI_WORKFLOW_*` to their
  `AGENT_WORKFLOW_*` renames.
- **Executor.** The replay descriptor is registered explicitly as executor `pi` (the first candidate of
  the installed-default order, WP17) for that run only. The real Pi adapter is never loaded.
- **Process.** Each variant runs in its own Node process. Two variants of one fixture use the same run
  id at the same pinned path, so in one process the ESM cache would hand the second variant the
  first variant's bundled helper modules.

## Replay executor (`test/replay/replay-executor.mjs`)

The replay executor is a normal executor module (`createExecutor(config)`) loaded from an
`ExecutorDescriptor`. The runtime durable worker reloads it in a fresh process.

**Match key:** `<taskId> NUL sha256(normalized prompt)`.

- `taskId` is field 3 of the engine attemptKey `awf1:<runId>:<taskId>:<hex>`. On the recorded side it
  is field 2 of the pi-subagent `correlationId` `<runId>:<taskId>`.
- The normalized prompt is `SubmitRequest.prompt` (recorded: the `runSubagent` `task`) after two
  steps. First the WP1a normalization policy runs (portable roots, id and timestamp placeholders). Then
  the literal renames of `allowed-differences.json` run (agent-workflow literal → pi-workflow literal).
  The system prompt is not part of the key; it is compared as a file (`system-prompt.md`).
- **Digest bindings** are tried only when no recording has the key (see below). They are proven
  against the in-flight replay run directory, replayed digests are replaced with the recorded ones, and
  the key is computed again. The serve entry lists every binding it used.
- If several recorded launches share a key, they are served in recorded order. The trace log is shared
  across worker processes. A resubmitted attemptKey gets the same call again.
- A miss throws `INVALID_REQUEST` before the authority is consumed, so no effect happens. The trace
  records the closest recorded prompt for the task and the first line that differs, and the run report
  lists them. The engine reports the miss at once (core-port WP1b change log 5).
- Before matching, the executor refuses requests exactly as the Pi adapter's pre-consume `plan()` does:
  it checks the thinking level, the tool mapping, MCP injection and server names, using the adapter's
  own tables from `dist/executors/pi`. Variant `deep-research:engine-only` turns these checks off.

On a hit the executor consumes the authority, then reproduces what the engine can observe:

1. **Artifact reads.** Every `read-ledger.jsonl` row that the recorded worker wrote during this attempt
   (by timestamp window; a row outside every window fails the fixture load) is re-issued as a
   `workflow_artifact` `tools/call`. The call goes to the real artifact MCP server, spawned from the
   request's `workflow_artifact` `McpServerSpec`. The server reads the task's `artifact-access.json`
   and writes the ledger itself, so no ledger row is written by hand.
2. **Events.**
   - `started`, with the session id the Pi adapter would report.
   - One `usage` event, made from the recorded Pi usage by the adapter's own `usageFromPi`.
   - Then either `completed`, with the recorded `output.log` text verbatim (host roots restored), or
     `failed`, with the failure class of the recorded `failureKind` (no fixture records a worker
     failure).
   - A requested session is reported as `ownedSession`, the way the Pi adapter reports it.

**What the replay cannot reproduce** (also listed in each report):

- The worker CLI's stderr. The runtime `stderr.log` holds runtime diagnostics only.
- Worker tool calls other than `workflow_artifact` reads (read/grep/find/ls, web tools). They only
  shaped the recorded final text, and that text is replayed verbatim.
- Pi session files, timing, process ids, and the provider/model metadata of an attempt.
- **Artifact delivery bound.** The recorded Pi worker received large reads whole (impact-review: 6
  reads over 8192 chars, spec-review: 4, deep-research: 2). The replay starts the server with
  `--max-output-chars 16777216` so the ledger rows match. A live Pi run launches the server with
  `--max-output-chars 18432` (WP5b, docs/mcp.md "Measured limits"): larger whole reads are served as
  a first page and a live model pages on with `offset`. Those page calls and rows are not in the
  recording, so a replay cannot reproduce them. (The committed reports still carry the pre-WP5b
  wording until the next `acceptance.mjs --write`.)
- The web-source cache that the removed web tools filled (deep-research, C2).

## Comparison (`test/replay/compare.mjs`, `digest-binding.mjs`)

**Recorded side.** The recorded `run/` is normalized with the WP1a policy. It must still produce the
committed `normalized/` tree (the test checks this).

**Replayed side.** The replayed `.agent-workflow/workflows/<runId>/` is normalized with the replay
host roots. Then the `renames` literals are applied. After that, proven digest bindings are applied.
Both sides then get the digest renaming of the `keys` entries.

**Digest bindings.** Some records digest bytes that contain a renamed literal. For example, a
`source-manifest.json` lists upstream artifacts under the run state path, and a helper quotes the
manifest's sha256 in its control. A replayed digest is replaced by the recorded one only after a
binding check that recomputes both digests:

- `file`: both files are hashed (the recorded bytes with the recorded host root restored). The files
  must be equal after normalization, the renames and the bindings already proven.
- `self`: on both sides, the control's `digest` is reproduced by a digest formula of the original
  bundled helpers, and the rest of the control is equal under the same steps.

Bindings are proven up to a fixpoint. Only fixtures that pin the recorded root can be checked. Each
binding appears in the report with its proof file.

Every leaf difference gets one class:

| Class | Rule |
|---|---|
| `allowed` | Covered by `test/replay/allowed-differences.json`: a `keys` digest entry (the equality structure must still match across the tree), a literal `renames` entry (the report lists every hit), a digest binding, or a `differences` pattern. Every WP1b entry names its decision/WP. |
| `explained` | Matches an entry in `test/replay/explained-differences.json`. Each entry cites a change-log entry in docs/core-port.md or docs/runtime-port.md. |
| `unexplained` | Anything else. Every unexplained difference was investigated: either it was fixed in product code with a regression test, or it got a change-log entry and moved to `explained`. |

**Exact match.** This content must match exactly, and no `allowed` or ordinary `explained` entry may
cover it (`EXACT_MATCH` in compare.mjs):

- task prompts (`task.md`, launch prompt digests) after the literal renames;
- task `output.log` / `raw.md` / `control.json` / `analysis.md` / `refs.json`;
- the output-contract verdict (`result.json` status, control digest, protocol, output validation, raw
  integrity);
- required-read verdicts and read evidence (ledger rows except `at`);
- task ids, specs, stages, statuses, status details and their order, and the task summary;
- retry and repair counts;
- the final run status;
- run usage totals (input/output/cache-read tokens, cost, task counts).

The rules match the index-free JSON path of a leaf difference (`tasks[0].status` is checked as
`tasks[].status`, `[3].returnedBytes` in a read ledger as `[].returnedBytes`), like the difference
patterns do (WP12d-1).

The only exception is an entry marked `divergence: true`. Such an entry must be scoped to a fixture
and a variant. It describes a variant whose expected outcome differs, and the acceptance test asserts
its cause separately.

## Per-fixture results

| Fixture:variant | Recorded → replayed | Allowed / explained / unexplained | Workers served, reads re-issued |
|---|---|---|---|
| minimal:original | completed → completed | 76 / 40 / 0 | 1/1, 0/0 |
| minimal:codex (WP37) | completed → completed | 76 / 41 / 0 | 1/1, 0/0 |
| deep-review:original | completed → completed | 587 / 279 / 0 | 12/12, 1/1 |
| impact-review:original | failed → failed | 597 / 394 / 0 | 12/12, 31/31 |
| spec-review:original | failed → failed (divergent) | 292 / 459 / 0 | 5/6, 43/57 |
| spec-review:state-path-migrated | failed → failed | 334 / 204 / 0 | 6/6, 57/57 |
| deep-research:original | completed → blocked (expected refusal) | 174 / 2209 / 0 | 1/11, 0/10 |
| deep-research:engine-only | completed → completed | 578 / 422 / 0 | 11/11, 10/10 |
| deep-research:engine-only-claude (WP37) | completed → completed | 578 / 431 / 0 | 11/11, 10/10 |

The `allowed` counts vary by a few rows from run to run. Supervisor progress snapshots depend on
timing, and the digest bindings of timestamped files (read ledgers) show up only when the run's
timestamps differ. The `unexplained` count is always 0.

All recorded statuses, task outputs, verdicts, retry counts and usage totals match, except in the two
divergent variants:

- **spec-review (original).** The original helper `spec-requirement-source.mjs` reads upstream state
  from the hard-coded `.pi/workflows/<run>/…`. Its evidence gate reports
  `missing_requirement_source_proof`. The task-6 control differs, so task 7's prompt has no recording
  and the replay refuses it. Task 8 renders the degraded partition (core-port WP1b change log 6).
  Variant `state-path-migrated` changes only that one template literal in the copied bundle; the
  comparison renames it back. That variant matches with 20 proven digest bindings.
- **deep-research (original).** This is the expected result for C2. The spec asks for the removed
  `workflow_web_*` tools. The Pi executor refuses tasks 11, 12, 13, 4 and 9 before any effect
  (`CAPABILITY_MISSING: Pi executor has no mapping for tools: workflow_web_search,
  workflow_web_fetch_source, workflow_web_source_read`). The foreach stage then gets no items and the
  final render blocks (core-port WP1b change log 7). Variant `engine-only` skips the adapter check.
  With it, every task output matches; only C2 artifacts (wrapper files, web-source cache) and foreach
  batch telemetry differ, all classified.

Main explained changes: the executor record and owned sessions; the WP10 worker-prompt rendering (the SubmitRequest names the artifact tool `mcp__workflow_artifact__workflow_artifact` for the `pi` replay executor, renamed back by the `wp10-artifact-tool-visible-name` literal rename; `system-prompt.md` gains the artifact tool guidelines section; the original deep-research system prompts lose the removed web-source hint); artifact MCP provenance instead of
the Pi extension wrapper; runtime stderr; executor exit code `null`; the executor usage contract (no
reasoning/total/cache-write tokens); cost rounding to 12 decimals; original helpers' sidecars written
to the legacy `.pi/workflows` path (byte-identical); and the resolved backend as an executor id.

Bugs the replay found and fixed (core-port WP1b change log 4 and 5):

- Runtime usage `cached`/`cost` were dropped from task usage (`core-usage-runtime-summary.test.mjs`).
- An executor refusal before consume waited for the full barrier timeout and lost the reason
  (`core-launch-barrier-worker-ended.test.mjs`).

## WP12d-1 change log

1. **Review #11: exact-match rules see generic paths.** `exactMatchRule` tested its index-free path
   regexes (`tasks[].status`, `[].returnedBytes`) against the indexed leaf-diff path
   (`tasks[0].status`), so it never matched indexed rows: task ids/specs/stages/statuses, retry
   counts, launch prompt digests and read-ledger evidence could be covered by an ordinary
   `allowed`/`explained` pattern. It now applies `genericPath` first. Test:
   `replay-wp12d1-exact-match.test.mjs` (indexed paths for every indexed rule; mutated task status,
   retry count and ledger rows of real recorded run records stay `unexplained` under a catch-all
   allowance). Acceptance re-run (`node test/replay/acceptance.mjs --write`): 0 unexplained in every
   variant. Re-classifying the same replays with the old and the new rule: no `allowed` difference
   moved; 38 leaf differences that were already `explained` by the scoped divergence entries now also
   count as exact-match divergences (deep-research:original 35 — task ids/specs/stages/kinds, statuses
   and status details, launch prompt digests of the refused tasks, rule
   `c2-original-deep-research-refused`; spec-review:original 3 — task 7 status, status detail and
   prompt digest, rule `original-spec-review-legacy-state-read`). Both are the documented divergent
   outcomes above. The committed reports were regenerated (`allowed` row counts vary by run, see
   above).

## WP37 change log

1. **Per-executor task prompts** (core-port WP37 change log 1). The `pi` replay executor sees no
   change: Pi's task-prompt rendering is the WP10 one, so every `original` variant still matches its
   recording key for key. To check the Claude and Codex renderings against the recordings too:
   - **Executor variants.** `minimal:codex` and `deep-research:engine-only-claude` register the replay
     descriptor under `codex` / `claude` (run flag `executor`) with the Pi adapter checks off (they
     are Pi's). The replay executor then re-keys every recorded prompt with
     `renderWorkerTaskPromptToolNames(recorded, id)` followed by the literal renames, so a request
     matches only if it is exactly the recorded prompt rendered for that executor. The serve trace
     records `rendering: {executor, changed, recorded, rendered}` (sha256 of the Pi and the rendered
     prompt).
   - **New explained rule `wp37-per-executor-task-prompt`** (variants `codex`, `engine-only-claude`).
     `compareReplay({renderedPrompts})` adds one difference `submit-request/<task>.prompt`, kind
     `executor-rendered`, for each served launch whose rendered prompt differs from the Pi text
     (minimal:codex 1 — the artifact tool's code-mode note; deep-research:engine-only-claude 9 — the
     WebSearch/WebFetch/Read/Grep/Glob names). Safe because the row exists only for a launch that was
     served, that is, proven equal to the recorded prompt under the renderer; any other prompt change
     still misses and fails the variant. `task.md` and the launch prompt digests stay in the
     exact-match set and do not differ.
   - **Extended rule `runtime-backend-executor-id`.** A second pattern, scoped to the same two
     variants, accepts the foreach batch receipt backend `claude`/`codex` (the resolved backend is
     the executor id, runtime-port change log 1; deep-research:engine-only-claude has 3 such rows).
   `replay-acceptance.test.mjs` asserts the full standard for both variants plus the number of
   `executor-rendered` rows and their executor. Reports regenerated with `--write` (the table above;
   the earlier `explained` counts were from before the reports were last regenerated).
