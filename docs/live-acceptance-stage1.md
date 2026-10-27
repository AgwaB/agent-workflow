# Live bundle 3: stage-1 acceptance (bundled workflows × executors)

Plan §5 item 4 (R#7): acceptance is a **support table**. Each executor × bundled workflow cell is
`completed`, `completed-degraded` (with the degraded capabilities) or `refused` (with the
requirement, per B4). A domain verdict such as `PARTIAL_REVIEW`, `INCONCLUSIVE`, `GAPS_FOUND` or
`BLOCKED` counts as **completed**: the workflow ran to its final render and reported a finding about
the target, not about the engine. Quality is not compared (F2 is stage 2).

- Date: 2026-10-27. Branch `live3-acceptance` from main `63671c7`.
- CLI: `node <HOME>/agent-workflow-live3/src/hosts/cli/cli.mjs run <workflow> --executor <id> [--model …] --json -- "<task>"`,
  run in the target directory with the real HOME and the real CLI logins. No `--permission-mode`
  (default `free`), no `--yes` (stdin was not a TTY, so degradations were recorded
  non-interactively).
- Executors and models: Pi 1.1.0 with its default model (`openai-codex/gpt-6.1-sol`, ChatGPT
  subscription; no `--model`); codex-cli 0.159.2 with `--model gpt-5.6-luna`; claude-code 2.1.310
  with `--model haiku` (resolved `claude-haiku-5-5`).
- Evidence: `test/fixtures/live3/<executor>-<workflow>-<attempt>/` holds, per run, the CLI JSON
  result (`cli-result.json`), the capability preview (`capability-preview.txt`), the `inspect`
  text (`inspect.txt`) and a summary extracted from the run record (`summary.json`: task summary,
  final task, failed tasks, usage rolled up from the run record, models seen in the raw worker
  streams). Scrubbed: home paths are `<HOME>`, `/private/tmp` is `/tmp`; no transcripts.

## Support table

| Executor | deep-review | spec-review | impact-review | deep-research |
|---|---|---|---|---|
| **pi** | **completed** — `PARTIAL_REVIEW`, 17/18 tasks (final render declared failed on partial coverage); no degradation | **completed** — `INCONCLUSIVE`, 8/9; no degradation | **completed** — `UNKNOWN` (risk floor high), 12/13; no degradation | **completed-degraded** — passed, 31/31; `webTools.safetyPolicy: unknown` (C2). First attempt blocked by product bug F1, fixed (M16) |
| **codex** | **completed-degraded** — `PARTIAL_REVIEW`, 24/25; `toolAllowlist.fine` missing (accepted: free mode), `readOnly` warning (151 allow rules in `<HOME>/.codex/rules`), `contextIsolation` warning (global `<HOME>/.codex/AGENTS.md`), `usage.cost` emulated | **completed-degraded** — `GAPS_FOUND`, 8/9; same four. First attempt corrupted by product bug F2 (M17) | **completed-degraded** — `BLOCKED`, 12/13; same four. First attempt corrupted by F2 (M17) | **completed-degraded** — passed, 28/28; same four + `webTools.safetyPolicy: unknown` |
| **claude** | **completed** — `NEEDS_WORK`, passed, 19/19 (1 output retry); no degradation. First attempt refused at launch by adapter bug F3, fixed | **completed** — `INCONCLUSIVE`, 8/9; no degradation (after F3) | **completed** — `BLOCKED`, 12/13; no degradation (after F3) | **completed-degraded** — passed, 30/30 (1 output retry); `webTools.safetyPolicy: unknown` (after F3) |

No cell is `refused`: no B4 refusal occurred. Every Codex cell records its degradations in
`run.capabilityNegotiation` (`confirmation: "non-interactive"`); Pi and Claude non-web cells are
`accepted` (`confirmation: "not-needed"`). The `usage.cost` row for Codex is listed in the preview as
"emulated by engine" but no cost is produced (open problem 4).

Compared with the offline support table in `docs/bundled-workflows.md` (pre-WP4e): in `free` mode
Codex no longer shows `forcedReadOnly`; the precise tool list is accepted as
`CAPABILITY_MISSING:toolAllowlist.fine` and the environment warnings of this machine (`readOnly`,
`contextIsolation`) appear as recorded degradations. Pi's probe found `pi-web-access`, so
deep-research degraded on `webTools.safetyPolicy` instead of refusing.

## Results per run (12 cells, final attempts)

| Cell | Run id | Status / domain verdict | Tasks done/total | Model attempts | Wall | Input (incl. cached for codex/claude) | Cache read | Output | Cost |
|---|---|---|---|---|---|---|---|---|---|
| pi deep-review | `workflow_mvq9jsuz_49ad93` | failed / PARTIAL_REVIEW | 17/18 | 12 | 496 s | 233,335 | 501,760 | 31,692 | $0.834 (Pi catalog estimate) |
| pi spec-review | `workflow_mvq9yf4p_fef659` | failed / INCONCLUSIVE | 8/9 | 6 | 789 s | 229,716 | 1,250,048 | 33,484 | $0.919 |
| pi impact-review | `workflow_mvqafci8_152f26` | failed / UNKNOWN | 12/13 | 12 | 907 s | 352,757 | 1,276,288 | 58,776 | $1.421 |
| pi deep-research | `workflow_mvqccbmv_0fa746` | completed / passed | 31/31 | 21 | 406 s | 257,288 | 631,552 | 25,454 | $0.832 |
| codex deep-review | `workflow_mvqbe6q1_9aae8e` | failed / PARTIAL_REVIEW | 24/25 | 19 | 300 s | 3,716,754 | 3,160,576 | 89,500 | not reported |
| codex spec-review | `workflow_mvqc1bo4_76dbe2` | failed / GAPS_FOUND | 8/9 | 6 | 204 s | 966,864 | 787,072 | 29,608 | not reported |
| codex impact-review | `workflow_mvqc5qde_21c2d2` | failed / BLOCKED | 12/13 | 12 | 303 s | 3,410,997 | 2,765,056 | 70,040 | not reported |
| codex deep-research | `workflow_mvqbxql6_3aa772` | completed / passed | 28/28 | 20 | 168 s | 1,671,953 | 1,184,128 | 29,723 | not reported |
| claude deep-review | `workflow_mvqcu32z_81ca1d` | completed / NEEDS_WORK | 19/19 | 14 | 116 s | 545,971 | 420,330 | 51,832 | $0.055 (notional, subscription) |
| claude spec-review | `workflow_mvqcwkuj_b2e103` | failed / INCONCLUSIVE | 8/9 | 7 | 283 s | 752,491 | 573,613 | 85,476 | $0.084 |
| claude impact-review | `workflow_mvqd2nya_61dafd` | failed / BLOCKED | 12/13 | 12 | 160 s | 932,627 | 733,840 | 82,404 | $0.088 |
| claude deep-research | `workflow_mvqd63jg_b70faf` | completed / passed | 30/30 | 23 | 390 s | 1,308,605 | 916,908 | 158,837 | $0.273 |

"failed / <verdict>": the run status is `failed` because the final render task declares failure
for these verdicts (`support_declared_failed`); every other task completed. "Tasks" counts engine
tasks (support, foreach and model tasks). "Model attempts" counts raw worker streams that name a
model. Token units differ per adapter: Pi reports input **without** cache reads; Codex and Claude
report input **including** cache reads.

Domain verdict details:

- deep-review `PARTIAL_REVIEW` (Pi, Codex): one devil-advocate verdict quoted bytes that are not in
  the cited range, so the deterministic ledger routed it to NEEDS_HUMAN
  (`verifier_evidence_unverified`). Pi: `src/workflow-terminal.ts:99-102` quoted `return {…`, which
  starts at line 98. Codex: quoted `isWorkflowAbortError(value)` at `workflow-cancellation.ts:21`,
  the file has `isWorkflowAbortError(candidate)`. Model/content, not fixed.
- spec-review: Pi `INCONCLUSIVE` (2 needsHuman: SPEC.md clauses 12/13 precedence for terminal
  direct-dynamic runs; the control-schema file `./schemas/…` was ENOENT, open problem 3); Claude
  `INCONCLUSIVE` (the same clause 12/13 ambiguity, twice); Codex `GAPS_FOUND` (1 final finding,
  1 needsHuman: schema file ENOENT). All end on the renderer gate `actionableEvidenceComplete: false`
  ("Local byte evidence or exact extracted-requirement reconciliation is incomplete…").
- impact-review: Pi `UNKNOWN`, Codex and Claude `BLOCKED`; blockers as in WP1a ("Known canonical
  impact risk floor is high", byte assurance limited, synthesis verdict/risk contradicts the
  required verdict).

## Failures, classification and fixes

| # | Run(s) | Classification | Evidence | Fix |
|---|---|---|---|---|
| F1 | pi deep-research a1 `workflow_mvqaysdz_29eda7` (blocked, 30/32) | **product bug** (WP10 bundled spec vs WP5b delivery limits) | task-9 `final-audit.main` `required_reads_missing_exhausted` after 3 output retries: "missing required workflow artifact reads: final-audit-packet.control path=$.packet.synthesisInput.pages[0] maxChars=24000 count=1". Read ledger: page 0 `returnedBytes` 18,040, `truncated: true`, `deliveryUnverified: true` (page 23,301 units vs Pi server `--max-output-chars 18432`); task-10 `final.main` blocked ("missing final-audit control source") | `89923fb` **M16**: synthesis pages 16 × 16,000, measured in UTF-16 units and UTF-8 bytes; specs, schema, README, tests. Regression test reads every page against the Pi, Claude and Codex server limits. Retry a2 `workflow_mvqccbmv_0fa746`: 17 reads, none truncated, completed |
| F2 | codex spec-review a1 `workflow_mvqbkm1o_f725e0` (INCONCLUSIVE), codex impact-review a1 `workflow_mvqbnjjn_577cbc` (BLOCKED) | **product bug** (engine worker prompt) | system prompt: "Only these tools are enabled for this workflow task: read, grep, find, ls, mcp__workflow_artifact__workflow_artifact" — Codex has no tools by those names. spec-review task-1 `extract-spec` made 0 tool calls: "SPEC.md was unavailable; … the permitted repository-reading tools were not exposed in this run". impact-review task-1 made 0 calls, tasks 2–12 only artifact calls (no code read). Codex deep-review workers did use `shell` | `aa22c21` **M17**: `renderWorkerPromptToolNames` adds an executor mapping note after the enabled-tools line (Codex → shell / apply_patch / hosted web_search; Claude → Read / Grep / Glob / WebSearch / WebFetch; Pi unchanged). Retries a2: spec-review workers ran `shell` in 5 of 6 model tasks (GAPS_FOUND); impact-review in 10 of 12 (BLOCKED) |
| F3 | claude ×4 a1: `workflow_mvqcmxfu_938ff6`, `workflow_mvqcmzg2_209480`, `workflow_mvqcn1kn_529acf`, `workflow_mvqcn3lj_4843bf` (2–4 s each, no model call) | **adapter bug** (Claude adapter vs engine session ids) | deep-review task-1/task-7 `launch_failed`: "executor refused the attempt before launch: sessionId must be a UUID (claude --session-id)". The engine requests `agent-workflow.<run>.<task>` for every artifact-graph task | `85b9fa6`: a non-UUID `sessionId` maps to a deterministic UUID (`claudeSessionUuid`, v4 layout over SHA-256); UUIDs pass through; empty refused. Retries a2: all four completed |

Not failures: the model/content verdicts above; Codex spec-review a1 and impact-review a1 each had
one output retry, Claude deep-review a2 and deep-research a2 one each (all repaired). No
environment, quota or rate-limit failure occurred; no B4 refusal.

Each fix commit passed `npm run validate` (run in a separate checkout so the live runs' `dist/`
was never rebuilt mid-run). One unrelated flake: `host-cli.test.mjs` "stop: a fresh process stops a
running detached run" failed once in the first validate of F1 (run reported `interrupted` before the
stop) while live runs loaded the machine; it passed on rerun and in every later validate.

## Live-call ledger (19 workflow runs of ≤ 24)

| # | Executor | Workflow | Attempt | Run id | Model (raw streams × attempts) | Duration | Input | Cache read | Output | Cost | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pi | deep-review | a1 | `workflow_mvq9jsuz_49ad93` | gpt-6.1-sol ×12 | 496 s | 233,335 | 501,760 | 31,692 | $0.834 est. | failed / PARTIAL_REVIEW |
| 2 | pi | spec-review | a1 | `workflow_mvq9yf4p_fef659` | gpt-6.1-sol ×6 | 789 s | 229,716 | 1,250,048 | 33,484 | $0.919 est. | failed / INCONCLUSIVE |
| 3 | pi | impact-review | a1 | `workflow_mvqafci8_152f26` | gpt-6.1-sol ×12 | 907 s | 352,757 | 1,276,288 | 58,776 | $1.421 est. | failed / UNKNOWN |
| 4 | pi | deep-research | a1 | `workflow_mvqaysdz_29eda7` | gpt-6.1-sol ×22 | 540 s | 314,534 | 699,392 | 29,287 | $0.992 est. | blocked (F1) |
| 5 | codex | deep-review | a1 | `workflow_mvqbe6q1_9aae8e` | gpt-5.6-luna ×19 | 300 s | 3,716,754 | 3,160,576 | 89,500 | not reported | failed / PARTIAL_REVIEW |
| 6 | codex | spec-review | a1 | `workflow_mvqbkm1o_f725e0` | gpt-5.6-luna ×7 | 136 s | 701,477 | 483,072 | 19,419 | not reported | failed / INCONCLUSIVE (F2) |
| 7 | codex | impact-review | a1 | `workflow_mvqbnjjn_577cbc` | gpt-5.6-luna ×13 | 180 s | 987,530 | 736,640 | 53,094 | not reported | failed / BLOCKED (F2) |
| 8 | codex | deep-research | a1 | `workflow_mvqbxql6_3aa772` | gpt-5.6-luna ×20 | 168 s | 1,671,953 | 1,184,128 | 29,723 | not reported | completed |
| 9 | codex | spec-review | a2 | `workflow_mvqc1bo4_76dbe2` | gpt-5.6-luna ×6 | 204 s | 966,864 | 787,072 | 29,608 | not reported | failed / GAPS_FOUND |
| 10 | codex | impact-review | a2 | `workflow_mvqc5qde_21c2d2` | gpt-5.6-luna ×12 | 303 s | 3,410,997 | 2,765,056 | 70,040 | not reported | failed / BLOCKED |
| 11 | pi | deep-research | a2 | `workflow_mvqccbmv_0fa746` | gpt-6.1-sol ×21 | 406 s | 257,288 | 631,552 | 25,454 | $0.832 est. | completed |
| 12 | claude | deep-review | a1 | `workflow_mvqcmxfu_938ff6` | — (refused before launch) | 4 s | 0 | 0 | 0 | $0 | failed (F3) |
| 13 | claude | spec-review | a1 | `workflow_mvqcmzg2_209480` | — | 3 s | 0 | 0 | 0 | $0 | failed (F3) |
| 14 | claude | impact-review | a1 | `workflow_mvqcn1kn_529acf` | — | 2 s | 0 | 0 | 0 | $0 | blocked (F3) |
| 15 | claude | deep-research | a1 | `workflow_mvqcn3lj_4843bf` | — | 3 s | 0 | 0 | 0 | $0 | blocked (F3) |
| 16 | claude | deep-review | a2 | `workflow_mvqcu32z_81ca1d` | claude-haiku-5-5 ×14 | 116 s | 545,971 | 420,330 | 51,832 | $0.055 notional | completed / NEEDS_WORK |
| 17 | claude | spec-review | a2 | `workflow_mvqcwkuj_b2e103` | claude-haiku-5-5 ×7 | 283 s | 752,491 | 573,613 | 85,476 | $0.084 notional | failed / INCONCLUSIVE |
| 18 | claude | impact-review | a2 | `workflow_mvqd2nya_61dafd` | claude-haiku-5-5 ×12 | 160 s | 932,627 | 733,840 | 82,404 | $0.088 notional | failed / BLOCKED |
| 19 | claude | deep-research | a2 | `workflow_mvqd63jg_b70faf` | claude-haiku-5-5 ×23 | 390 s | 1,308,605 | 916,908 | 158,837 | $0.273 notional | completed |

Usage is rolled up from the run record's per-task `usage.aggregate` (the CLI's `data.wait.usage`
gives the same numbers when present; blocked runs have none). Retries used: Pi 1 (deep-research),
Codex 2 (spec-review, impact-review), Claude 4 (all; runs 12–15 made no model call).

Totals per executor (tokens processed = input + output, plus cache reads for Pi):

| Executor | Runs | Wall | Tokens processed | Cost |
|---|---|---|---|---|
| pi | 5 | 3,138 s | 5,925,363 (input 1,387,630 + cache 4,359,040 + output 178,693) | $4.998 Pi catalog estimate (ChatGPT subscription; not billed per token) |
| codex | 6 | 1,291 s | 11,746,959 (input incl. cache 11,455,575 + output 291,384; cache 9,116,544) | not reported (every attempt `costUsd: null`; open problem 4) |
| claude | 8 (4 without a model call) | 961 s | 3,918,243 (input incl. cache 3,539,694 + output 378,549; cache 2,644,691) | $0.501 notional `total_cost_usd` (subscription) |

## Comparison with the WP1a pi-workflow recordings (same targets, Pi)

| Workflow | WP1a (pi-workflow 0.16.4) | Live 3 Pi (agent-workflow) | Notes |
|---|---|---|---|
| deep-review | completed, NEEDS_WORK; 18 tasks / 12 model; 446 s; 1.03 M tokens; $0.92 | failed / PARTIAL_REVIEW; 18 / 12; 496 s; 0.77 M; $0.83 | Same graph shape. The verdict differs by one verifier off-by-one line citation (model). Claude reached NEEDS_WORK; Codex fanned out more reviewers (25 tasks) |
| spec-review | failed / INCONCLUSIVE (`missing_requirement_source_proof`, fixed as M1 in WP10); 9 / 6; 874 s; 1.78 M; $0.85 | failed / INCONCLUSIVE; 9 / 6; 789 s; 1.51 M; $0.92 | The M1 path blocker is gone; the verdict now comes from needsHuman rows (spec ambiguity, schema-file ENOENT) |
| impact-review | failed / BLOCKED; 13 / 12; 890 s; 5.62 M; $2.34 | failed / UNKNOWN; 13 / 12; 907 s; 1.69 M; $1.42 | Same 13 tasks and the same blocker family. WP1a ran inside the full pi-subagent-flow repository; here the target holds only the two changed files, hence fewer tokens. Codex and Claude: BLOCKED as in WP1a |
| deep-research | completed, passed; 21 tasks / 11 model; 343 s; 0.51 M; $0.50 (`depth: quick`, profile `low`) | completed, passed (after M16); 31 / 21; 406 s; 0.91 M; $0.83 (`depth: standard`, profile `low`) | The CLI cannot set `input.depth` (open problem 1), so the run used the spec's default `standard` (6 questions instead of 3) |

## Procedure notes and deviations

- `agent-workflow validate` passed for all four workflows before the first run. The CLI has no
  command that prints the capability preview without launching, so each executor's first real
  run served as the start check (its preview is in the fixture).
- Order: Pi (4), Codex (3) sequentially; then F1/F2 fixes; Codex deep-research and the Codex and Pi
  retries; then Claude (4, refused by F3), the F3 fix, and the Claude retries. No two live runs
  overlapped.
- Targets (`/tmp/aw-live3/<executor>/<workflow>/`, one git commit each): deep-review and
  spec-review copy only `package.json`, `tsconfig.json`, `src/` (and `SPEC.md`) of the WP1a project
  dirs (the WP1a dirs also hold their old `.pi/` run state, which was left out). impact-review holds
  `src/subagent-backend.ts` **and** `src/subagent-api-recorder.ts` at `7e813aa` (the second file is
  the diff's new file; the WP1a task text names both). The task is WP1a's text with "(git range in
  this repository)" replaced by "(the commits are not in this repository's git history; the diff
  below is authoritative)"; the diff is byte-identical to `git diff b83cc4f..7e813aa`.
  deep-research: README only.
- Like WP1a, each target carries the bundled `scout.md` and `researcher.md` as project agents
  (`.agent-workflow/agents/`): this machine's legacy `~/.pi/agent/agents/{scout,researcher}.md`
  otherwise shadow the bundled agents (open problem 2).
- deep-research used `--profile low` (the shallowest declared profile).

## Open problems for stage 2

1. **No input overrides on the CLI.** `run` has no `--input key=value`, so `deep-research` always
   runs at `input.depth: standard` from the CLI; `quick` is reachable only through the host API
   (`inputOverrides`).
2. **Legacy agents shadow bundled agents.** Agent resolution searches legacy
   `~/.pi/agent/agents/` before the bundled `agents/`; on this machine the user's `scout`/`researcher`
   (with tools such as `bash` and `mcp__aside__repl`) would replace the bundled ones. Decide whether
   bundled agents used by bundled workflows should win, or warn.
3. **Control-schema path in worker prompts.** The compiler line "Validate the control object
   against the workflow-local control schema file: ./schemas/…" (inherited, identical in WP1a) is
   relative to the run bundle, but the worker's cwd is the project; Pi and Codex spec-review workers
   reported ENOENT as a needsHuman row, and any needsHuman row sets the renderer gate
   `actionableEvidenceComplete: false`.
4. **Codex cost.** Every Codex attempt reports `costUsd: null`, the run rollup shows `0`, and the
   preview says "cost = tokens × model price table" although no price table exists. Report
   `unknown` (or add a table).
5. **Usage rollup.** `data.wait.usage.totalTokens` is always 0 (not summed); input means different
   things per adapter (Pi excludes cache reads, Codex/Claude include them); blocked runs return no
   usage in the wait result. Pi tasks record no model (status shows "model unknown"); Claude records
   the alias (`haiku`), not the resolved model.
6. **Kept sessions for every task.** The engine requests a kept session for every artifact-graph
   task (`agent-workflow.<run>.<task>`), against D3's "only when same-session repair is needed".
   After this bundle `<HOME>/.claude/projects/-private-tmp-aw-live3-claude-*` holds 59 kept Claude
   session entries and the adapter state 56 session records; Codex threads are non-ephemeral. Wire
   retention (`deleteOwnedSession`) or stop requesting sessions by default. The experimental
   same-session repair with Claude (`--session-id` on an existing session) is untested.
7. **Domain verdict vs run failure.** Final renders mark `PARTIAL_REVIEW`, `INCONCLUSIVE`,
   `GAPS_FOUND`, `UNKNOWN` and `BLOCKED` as `support_declared_failed`, so `run` exits 1 and the run
   is `failed` although the workflow worked. Hosts need a "completed with verdict" outcome.
8. **Tool names in task prompts.** M17 maps the enabled tools in the system prompt only; task
   prompts still say `read/grep/find/ls`, `web_search`/`fetch_content`. Codex and Claude followed
   the note in this bundle; a per-executor rendering of task prompts is not done.
9. **Codex environment degradations.** On this machine every Codex stage runs with recorded
   `readOnly` (151 allow rules) and `contextIsolation` (global `AGENTS.md`) warnings; free mode
   never refuses them. The offline support table in `docs/bundled-workflows.md` predates WP4e and
   still shows `forcedReadOnly` for Codex.
10. **Flaky CLI stop test** under load (see above).
