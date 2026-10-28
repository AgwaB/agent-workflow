# Live bundle 5 (WP39): live acceptance of the pre-release features

Live checks of WP28–WP38b on the real CLIs: Claude Code, Codex and Pi as hosts, the terminal CLI,
mixed runs, `auto`, dynamic approval, worktrees, the Pi board and profile picker, host tools, and
the progress/completion mechanisms of [host-ux-investigation.md](host-ux-investigation.md) (L1–L6).
Format and procedures as in [live bundle 4/4b](live-acceptance-stage2.md). A domain verdict
(`NEEDS_WORK`, `PARTIAL_REVIEW`) counts as completed. Quality is not compared.

- Date: 2026-10-28, 16:31–17:37Z. Branch `live5-feature-acceptance` from main `fc1f2a9`.
- CLIs: Claude Code 2.1.310 at the start; its own auto-updater installed **2.1.312** during the first
  print-mode turn (16:32Z), so the A1 interactive session ran 2.1.310 and every later Claude process
  2.1.312 (`doctor` flags the difference). codex-cli 0.159.2 (update prompt skipped), Pi 1.1.0
  (update notices ignored). Real HOME and logins, permission mode `free` unless stated. The driving
  session's `PI_*` variables and `OPENAI_API_KEY` were removed from every spawned host and CLI.
- Models: Claude `haiku` (`claude-haiku-5-5`); Codex `gpt-5.6-luna`, effort `low`; Pi
  `openai-codex/gpt-5.6-luna`, thinking `low` (`pi --model … --thinking low`; Pi's default
  `gpt-6.1-sol`/xhigh was never used).
- Plugin: `node tools/release/plugins.mjs dev /tmp/aw-live5/plugin --force`. Claude Code:
  `--plugin-dir /tmp/aw-live5/plugin/plugins/agent-workflow --settings /tmp/aw-live5/claude-settings.json`
  (status line `agent-workflow statusline`, `refreshInterval` 2). Codex: temporary
  `codex plugin marketplace add` + `plugin add`, removed at the end (below). Pi:
  `pi -e <checkout>/dist/hosts/pi/index.js --skill <checkout>/plugins/pi/skills/aw-workflow-guide
  --skill …/aw-execution-router --session-dir /tmp/aw-live5/pi-sessions --approve` (`--approve`:
  project trust for this process only, to load the target's `.pi/mcp.json`).
- Targets: `/tmp/aw-live5/<case>/` = `package.json`, `tsconfig.json`, `src/` of
  `internal/raw-recordings/projects/deep-review/` plus the bundled `scout.md` as a project agent,
  `git init`, one commit. Small specs for the feature checks are in `test/fixtures/live5/specs/`
  (`live5-approval`: one read stage + a dynamic controller with `approval: "ask"` whose helper only
  appends to `controller.log`; `live5-safe-min`; `live5-write`; `live5-profiles`; `live5-hosttools`).
- TUIs (Claude Code, Codex, Pi, the CLI prompts) ran in tmux; pane captures are the evidence.
- Codex limit gate: `account/rateLimits/read` (no model call) before every Codex run
  (`test/fixtures/live5/codex/rate-limit-gate.txt`): `ordinaryUsageAllowed: true`, no limit reached,
  7-day window 7 % at the start, 10 % after the bundle. No 429 anywhere.
- Evidence: `test/fixtures/live5/<check>/` (pane captures, streams, launch/stop/resume output),
  `run-summary.json` (every run's status, tasks, executors, models, wall time, usage roll-up),
  `codex/` (install/removal log, restore proof, limit gate, Codex session files), `specs/`.
  Scrubbed: `<HOME>`, `/private/tmp` → `/tmp`; no tokens, emails or account ids.

## Results per check

| # | Check | Result | Evidence (run ids) |
|---|---|---|---|
| A1 | Claude Code `workflow_auto` | **verified** (interactive); print mode cannot consent | `workflow_mvsc3sjr_7640f0` |
| A2 | L1 prompt hook | **verified** (line in context, quoted by the model; idle prompts start no CLI) | A1, A4 sessions |
| A3 | L2 status line | **verified** | A1, A4 panes |
| A4 | MCP dynamic approval | **verified** | `workflow_mvsc9e97_e96293` |
| A5 | L3 plugin monitor (push) | **verified**: an idle session started a turn on its own; asyncRewake not tried | 0 runs (copied finished run) |
| B1 | Codex `workflow_auto` | **verified** with `approval_policy="on-request"`; under the user's `never` the consent was auto-accepted without a dialog (O2) | `workflow_mvscgd9b_d9ba85` |
| B2 | L5 Codex prompt hook | **verified** | `codex exec` turn |
| B3 | L6 `codex queue` | **verified**: the idle TUI started a turn without a keypress | B1 session |
| B4 | `workflow_show`, `workflow_doctor`, `workflow_profile` set/delete | **verified** (elicitation confirm rendered for set and delete) | B1 session |
| C1 | Mixed profile run, stop/resume, D3 | **verified after fix F2** | `workflow_mvsck9xp_7a85b5`, `…qzqo_dd0550`; stop/resume `…u2vn_8ba300` (bug), `…d0auj_e30fed` (bug, 2nd layer), `…d4t60_4eb599` (fixed) |
| C2 | `agent-workflow auto` on a TTY | **verified after fix F1**; non-TTY sends nothing | `workflow_mvscqdrv_5d919e` |
| C3 | `--permission-mode safe` on Codex | **verified** (what safe enforced: below) | `workflow_mvsd6mfe_8ef1fb` |
| C4 | Direct dynamic on Codex / Claude | **ran on both**: Codex completed 8/8; Claude failed by output validation (model, O12) | `workflow_mvsd8ho2_d3ff4e`, `workflow_mvsd8jtz_2cc5f7` |
| C5 | Write stage in a worktree | **verified** (O7 for the lifecycle details) | `workflow_mvsd8zdz_064ad7` |
| C6 | Dynamic approval on a CLI TTY + later `approve` | **verified after fix F1** | `workflow_mvsda7m2_20ff5b` |
| C7 | `watch`, `statusline`, `notify-check` | **verified** | C1a run |
| D1 | `/aw auto` in the Pi TUI | **verified after fixes F4, F5** (consent, loader + Escape, select, confirm) | `workflow_mvsdonwy_a638a5` |
| D2 | Board | **verified after fix F5** (navigation, `v`, `c`, `s`/`u` on a running run, `a` on a pending approval, narrow width) | D1 run, `workflow_mvsdwvhx_835052` |
| D3 | `/aw profile` picker, chooser `Custom…` | **verified** | `workflow_mvse1wtr_fd06a6` |
| D4 | `aw_run` + `aw_wait` | **verified**: no completion message for the awaited run, `parent-usage.json` written | `workflow_mvse2trj_5b109f` |
| D5 | Host tool inheritance | **verified for the tool set**; the worker did not use the tools (O8); project `.pi/mcp.json` servers are not loaded by workers (O9) | `workflow_mvse2trj_5b109f` |
| D6 | `doctor` / web-access probe note | **verified after fix F3** | doctor output |
| D7 | `aw-` skills next to pi-workflow's | **verified** | Pi startup pane |
| E | Pi fast tier | **not verified (no API-key provider)**: the user's Pi lists no `openai/*` model; `openai/*` appears only with the driving session's `OPENAI_API_KEY`, which was not used | — |

### A. Claude Code host

- **A1 print mode** (`claude -p`, one haiku turn, no run): Claude Code declares form elicitation,
  but answers `elicitation/create` itself (MCP log: "Elicitation request received in print mode")
  with cancel, so `workflow_auto` returned `phase: "consent-declined"`, nothing sent. The text mixes
  two cases: "Not sent: you did not agree…" plus "This MCP client cannot show confirmation dialogs"
  and the footer "The user declined" (O1).
- **A1 interactive** (tmux, 2.1.310): the consent dialog "MCP server … requests your input — Send
  this task to claude to compare workflows?" with Accept/Decline; then the choice form with the
  required enum ("Workflow to start: ▸ 1. deep-review (recommended)", → expands the 9 options).
  Accept launched `deep-review` on claude/haiku (classifier claude haiku, consent `elicitation`);
  the model waited and quoted `Workflow finished — verdict: PARTIAL_REVIEW (report ready)` and the
  report path. Panes `a1/pane-01…05`.
- **A2 (L1)**: the plugin hook printed `agent-workflow: workflow "deep-review" (run …) finished —
  verdict PARTIAL_REVIEW …` at the next prompt (transcript `hook_success`, 228 ms). Claude Code
  prefixes it "UserPromptSubmit hook success: ", and haiku answered NONE to "lines starting with
  'agent-workflow:'"; asked for messages *containing* the text (A4 session) it quoted the line
  verbatim. Idle prompt: `hook-claude-code.stamp` mtime unchanged and no `.next` file → the CLI was
  not started. The run had already been returned by `workflow_wait`, but `wait` marks it seen only
  when `.agent-workflow/notify-check/` exists, and the hook creates it only at the first check after
  a run exists: the first run of a fresh project is announced once more (O5).
- **A3 (L2)**: `aw: deep-review 0/8 running 13s` → `2/9 running 1m` → `6/14 running 1m` → empty
  after completion; `aw: live5-approval 1/2 awaiting approval 41s` during A4.
- **A4**: `workflow_run` → `workflow_wait` returned `actionRequired` and the approval; the model
  showed the question and request id and stopped. `workflow_status` quoted the `Awaiting approval`
  block. `workflow_approve {…, decision: "approve"}` opened "Run dynamic workflow controller?" in an
  elicitation dialog; Accept → "Approved … (recorded for host claude-code); the run continues",
  controller ran once, run completed 2/2. The next prompt's hook delivered `… finished — status
  completed` and the model quoted it.
- **A5 (L3, optional)**: `monitors/monitors.json` (`notify-check --follow --host claude-code`) was
  added to the dev plugin for this one session (removed after; `claude plugin validate` passed).
  The monitor process started with the session. A finished run directory copied into the idle
  project produced "⏺ Monitor event: agent-workflow: workflow "live5-approval" … finished" and
  Claude **started a turn on its own** and relayed it (one haiku turn). `asyncRewake` and L4 (long
  backgrounded wait) were not tried.

### B. Codex host

Temporary plugin install as in live 4b; per-run inline `-c 'projects={…trusted…}'` (no trust entry
was written by these runs).

- **B1, first try** (user config `approval_policy = "never"`): no dialog appeared; the consent
  elicitation was **auto-accepted** by Codex (result `consent: "elicitation"`, classifier called) and
  the enum choice form auto-cancelled ("Auto selection cancelled"). No run (O2).
- **B1, retry** with `-c approval_policy="on-request"`: Codex asked to allow the tool call
  (`workflow_auto` is annotated destructive), then rendered the consent elicitation (task,
  candidates, classifier codex gpt-5.6-luna low; Allow/Deny/Cancel) and the enum form ("Workflow to
  start" with the 7 options, labels doubled as "1. 1. Dynamic workflow", O4). Both times the luna
  classifier output failed host validation (evidence field `facts.tools` instead of `facts`;
  model, O3), so no recommendation; deep-review chosen by hand ran on codex workers
  (`PARTIAL_REVIEW`). The whole `workflow_auto` call (tool approval, two dialogs, classifier,
  launch) took **30.8 s**, inside `tool_timeout_sec` 120; human think time counts against it.
- **B2 (L5)**: project `.codex/hooks.json` with the documented `UserPromptSubmit` hook (checkout
  CLI), `codex exec --dangerously-bypass-hook-trust …` → the model repeated `agent-workflow:
  workflow "deep-review" (run workflow_mvscgd9b_d9ba85) finished — verdict PARTIAL_REVIEW …`.
- **B3 (L6)**: `codex queue --thread <session id> --message "agent-workflow: workflow test finished —
  reply OK"` → "Queued message …"; the idle TUI showed the message and replied "OK" without a
  keypress (one turn). No separate daemon process was needed: the running TUI accepted it.
- **B4**: `workflow_show` (launch capture with `Auto selection: deep-review (no recommendation; …
  consent elicitation)`), `workflow_doctor` (3 of 3 usable, Claude version warning),
  `workflow_profile set` → "Save the agent-workflow user profile "live5-b4-test"?" elicitation →
  saved; `show`; `delete` → "Delete …?" → deleted. Each `workflow_profile` call, also `show`, first
  needed Codex's tool approval (O18).

### C. CLI

- **C1 mixed**: `profile set live5-mixed --role default=claude:haiku --role
  research-execution=codex:gpt-5.6-luna:low`. Preview `Capability check (mixed: claude@0.1.0 ×3 +
  codex@0.1.0 ×1, …)`, both probes (`claude … 2.1.312, auth ok`, `codex … 0.159.2, auth ok`), the
  Codex degradations only on `reviewers.item`, and the `Role profile` table. `status --json` and
  `watch` show `codex/gpt-5.6-luna` for reviewers and `claude/haiku` elsewhere. No model note
  (both models are in the probe lists; an unlisted model was not tried). Runs `…k9xp` and `…qzqo`
  completed (`NEEDS_WORK`).
  **Stop/resume:** `stop` during the Codex reviewers interrupted 8 tasks; `resume` reset them, but
  both reviewers failed at once (`launch_failed — launch-bootstrap provenance is malformed`) and the
  run finished without their findings (F2). After the first fix the second run failed with
  `workflow launch authority history is malformed`; after the full fix (`d5e76fd`) run
  `workflow_mvsd4t60_4eb599`: stop → resume → the three reviewers relaunched and completed, 16/16,
  `NEEDS_WORK`. **D3:** no `<HOME>/.claude/projects` entry for the target, `executors/claude/sessions`
  56 → 56, `executors/codex/sessions` 0, all 16 Codex `thread/start` requests `ephemeral: true`, no
  Codex rollout for the target.
- **C2**: non-TTY `auto --executor claude --model haiku` → "Not sent: agent-workflow could not ask
  for your consent here…", exit 1, no classifier attempt, no run directory. On a TTY, `y` to `Send
  this task to claude to compare workflows? [y/N]` printed **"Not sent: you did not agree"** (F1).
  After the fix: consent y → ranked list (deep-review recommended, fit complete) → Enter → run,
  `show` prints `Auto selection: deep-review (recommended; 7 candidates; classifier claude haiku;
  consent prompt)`.
- **C3 safe** (`live5-safe-min`: a read stage and a write stage with `tools: [read, write]`, spec
  `allowReadOnlyDowngrade`): the preview asked `Proceed with these capability degradations? [y/N]`
  (Codex rules and global `AGENTS.md` warnings; works after F1). What safe enforced: both stages
  `forcedReadOnly` (coarse allowlist), Codex `thread/start` with `sandbox: "read-only"` and
  `approvalPolicy: "on-request"` for both, a worktree for the write-capable stage
  (`…/worktrees/task-2`, branch `agent-workflow/<run>-task-2`) although it ran read-only; the worker
  answered "I could not create NOTES.md because file writing was unavailable"; the checkout stayed
  clean.
- **C4**: `dynamic --executor codex …` completed 8/8; `dynamic --executor claude --model haiku`: the
  planner made only a synthesis step, its refs named a file the step read itself, which the source
  ledger rejects; 4 output repairs, then `failed` (model, O12). Both previews say "0 stages" (O13).
- **C5** (`live5-write`, `worktreePolicy: "on"`, claude/haiku, `free`): worktree
  `.agent-workflow/workflows/<run>/worktrees/task-1` on branch `agent-workflow/<run>-task-1`,
  `NOTES.md` written there only (`?? NOTES.md` in the worktree, main checkout clean), worktree and
  branch kept after the run (no merge, as documented). Observations O7.
- **C6**: the foreground run asked `Run dynamic workflow controller? [y/n]` with the scope; an empty
  answer left it open → `blocked`, exit 1, with the `approve` commands. `agent-workflow approve <run>`
  on the TTY asked again; `y` → "Approved … (recorded for host cli); the run continues", resumed,
  2/2 completed, `decidedBy: {host: "cli", via: "approve"}`. (`y` directly at the in-run question was
  not pressed; it is the same prompt as the `approve` one.)
- **C7**: `statusline` with Claude Code's stdin JSON from another directory → `aw: deep-review 0/8
  running 6s` (≈ 46 ms); `watch <run> --once` frame with per-task executor/model; `watch <run>
  --bell` in tmux ran to `Finished: completed — verdict NEEDS_WORK` and the report path, exit 0;
  `notify-check` in the project printed nothing for the running run and created `baseline.json`.

### D. Pi host

- **D1**: `/aw auto "<task>"` showed the consent with the task as `auto "Review …"` (158 characters
  for a 151-character task, F4); declined. After F4: correct task, Yes → but **no loader** was shown
  and Escape did nothing (F5). The classifier (luna) again failed host validation (O3); deep-review
  chosen in the select, "Confirm selected workflow launch — Start deep-review (not the
  recommendation)?" → Yes → run on pi workers with the session's model; the `Active workflows`
  widget showed `● deep-review 1/8 running · 4s`. After F5 (`aa77ba1`): "⠼ Comparing workflow
  candidates… (Esc cancels; nothing starts)", Escape → "Comparison cancelled; its request was aborted
  and any answer is discarded. No workflow has been started." (no run created). The run itself ended
  `failed` (one reviewer's output invalid after repairs; model).
- **D2**: `/aw` board (runs → stages → tasks → detail with output/stderr/events tabs), `s` + `y`
  stopped the running D1 run (interrupted message delivered), `u` + `y` resumed it (reviewers
  relaunched: F2 also holds on Pi), `v` launch viewer (`/aw auto "…"`, redacted at capture, controls
  escaped). `c` said "Launch command copy failed" (F5); after F5 "Launch command copied" and the
  system pasteboard (`pbpaste`) held `/aw run live5-approval "…" --detach`. A detached `live5-approval` run blocked
  (`dynamic_ui_unavailable`); the board showed "Pending approval · a"; `a` → scope → `y` →
  "Approved … (recorded for host pi)", controller ran, run completed. At 84 columns the board
  stacks; `q` repaints the editor.
- **D3**: `/aw profile` → Every workflow → Mixed preview (colour table, `claude: 13 models listed;
  the list is partial`, ANSI capture `d3/pane-03-mixed-preview.ansi.txt`) → Back → Custom… → Edit
  role default: model from the 77 probed Pi models (`openai-codex/gpt-5.6-luna`), effort low; the
  other roles removed ("uses default") → Save as a new profile `live5-pi` (`ctx.ui.input`), not
  default. `/aw run live5-profiles "…"` → chooser `Profile: careful / quick / Base / Custom… (open the
  profile picker)` → Custom… → workflow scope → `Saved: live5-pi` → Save → the run started once
  ("Saved workflow preference … profile: live5-pi"), completed.
- **D4**: an agent turn called `aw_run {workflow: "live5-hosttools", …}` then `aw_wait`; the wait
  result was the presentation, the session history has **no** `agent-workflow-completion` message
  for this run (receipt `state: confirmed, channel: tool-result`), and `parent-usage.json` recorded
  2 assistant messages, 42,548 tokens, $0.0012.
- **D5**: the target's `.pi/mcp.json` server `live5echo` was connected in the host (`/mcp`: project).
  Preview: `probe.main … host tools: inherited (Pi host codemode, tool_search, mcp__*, MCP
  resources; mutation-capable)`, `check.main … not inherited (readOnly stage)`. The probe worker's
  tool list (its `pi-stdout.jsonl`): `read`, `mcp__workflow_artifact__workflow_artifact`,
  `codemode`, `tool_search`, `mcp__aside__repl`, `mcp__donsetch__web_fetch` (user-level servers);
  the readOnly worker: `read` and the artifact tool only. The worker made no tool call and answered
  "tool_search is not available": its system prompt's "Effective Tool Policy" lists only the stage's
  tools (O8). `live5echo` was not available to workers (`--no-approve`, O9; echo log empty).
- **D6**: `doctor` reported Pi `auth unknown` and "could not check for pi-web-access (`pi list`
  failed)" although pi-web-access 0.44.0 is installed: `pi --list-models` took 4.2–5.4 s and a cold
  `pi list` 4.1 s, over the 4 s probe bound (F3). After the fix: `pi usable … logged in`, `web tools:
  pi-web-access <HOME>/.pi/agent/npm/node_modules/pi-web-access (web_search, fetch_content)`. The
  missing-package path was not exercised (no uninstall).
- **D7**: Pi's startup list shows `aw-execution-router, aw-workflow-guide` next to pi-workflow's
  `execution-router, workflow-guide`; no collision warning. (`pi -e` loads the extension only; the
  `aw-` skills were added with `--skill`, as `pi install` would through `pi.skills`.)

## Bugs found and fixed

| # | Check | Bug | Fix (commit) | Regression test (fails on the old code) |
|---|---|---|---|---|
| F1 | C2, C3, C6 | Every y/N typed on a real terminal was read as no answer: the readline prompt closed before resolving, and the synchronous `close` resolved `""` first (auto consent "you did not agree", degradation confirmation declined, approvals left open) | `28196e6` `readlinePrompt` settles the typed line first; changelog `docs/cli.md` | `host-wp39-cli-readline-prompt.test.mjs` |
| F2 | C1, D2 | `resume` after `stop` with a dependency invalidation bumps the generation of tasks that had launched; their launch-bootstrap and launch-authority histories still named generation 0 → `launch_failed` ("provenance is malformed", then "launch authority history is malformed"), run finished without those tasks (ported pi-workflow code) | `d5e76fd` drop both histories when the generation changes; changelog `docs/core-port.md` | `core-wp39-resume-generation-provenance.test.mjs` (record level + stop/resume end to end on the executor fixture) |
| F3 | D6 | Pi probe bound 4 s too short under load; a failed `pi list` was cached for the executor's life | `1969fc9` 15 s bound, failures not cached; changelog `docs/executors/pi.md` | `executor-wp39-pi-probe-timeout.test.mjs` |
| F4 | D1 | `/aw auto "<task>"` sent `auto "<task>"` to the classifier (and as the run's task) | `040cf3e` `parseWorkflowAutoArgs`; changelog `docs/pi-host.md` | `host-wp32-auto.test.mjs` ("the task is the text after `auto`…"); the WP38b router test now puts its refused option inside the task |
| F5 | D1, D2 | Pi resolves its packages for an extension only while loading the entry; the late `import()` in `active-ui.ts`/`board-source.ts` failed → no loader for `/aw auto` and `/aw wait` (no Escape), board `c` failed | `aa77ba1` the entry registers Pi's module (`pi-runtime.ts`); changelog `docs/pi-host.md` | `host-wp39-pi-runtime-module.test.mjs` |

Retries caused by bugs: C2 (consent; no run started), C1 (runs 7 and 8 lost to F2), D1 (restarts
for F4/F5, no extra run). Not bugs: domain verdicts, output-validation failures (C4 Claude, D1
reviewer), the luna classifier's invalid evidence fields.

## Observations (fixed in WP39b except O9, O12, O15; see "WP39b fixes")

| # | Observation |
|---|---|
| O1 | Claude Code `-p` auto-cancels elicitations; `workflow_auto` then reports "you did not agree" and "This MCP client cannot show confirmation dialogs" together, footer "The user declined". The consent-declined text should not claim the user declined when the client cancelled. |
| O2 | **Codex with `approval_policy = "never"` auto-accepts an empty-form elicitation**: the auto consent was recorded as `elicitation` without any dialog and one classifier request was sent. The enum form was cancelled, so nothing started. The same applies to every confirm-by-elicitation tool (profile, prune, notices, approve) under that policy — needs an owner decision (e.g. a required boolean field in the confirm forms). |
| O3 | `gpt-5.6-luna` (low) classifier outputs failed host validation 3/3 (Codex 2, Pi 1: `facts.tools`, `facts.usesNetwork` instead of `facts`); haiku 2/2 valid. Model quality; the choice still works without a recommendation. |
| O4 | Codex numbers enum options itself: "1. 1. Dynamic workflow". |
| O5 | `wait` marks a state seen only when `.agent-workflow/notify-check/` exists, so in a fresh project the hook (and `codex exec` L5) announces the first run again although `workflow_wait` already returned it. |
| O6 | Claude Code prefixes `UserPromptSubmit` output with "UserPromptSubmit hook success: "; a "line starting with `agent-workflow:`" instruction misses it. |
| O7 | Worktrees: the attempt state of a worktree task is written inside the worktree (`<worktree>/.agent-workflow/workflow-subagents/…`); the dirty-checkout snapshot copies untracked `.agent-workflow/workflow-subagents/` (other tasks' attempt files) into the worktree unless `.agent-workflow/` is git-ignored; `show`/`inspect` do not name the worktree path or branch; worktrees stay after the run. |
| O8 | Pi host tools: the worker system prompt's "Effective Tool Policy" lists only the stage's tools ("unavailable tools cannot be called"), so a worker that has `codemode`/`tool_search`/`mcp__*` is told not to use them. |
| O9 | Project `.pi/mcp.json` servers are not loaded by Pi workers (`--no-approve`), as documented; only user-level servers reach them. |
| O10 | A run that settles inside the approve call (board `a`, `/aw approve`) gets no completion message: tracking only starts for `running`/`pending` results. |
| O11 | The Pi TUI showed the "Workflow blocked" message twice in the scrollback; the session history holds it once. |
| O12 | Claude direct dynamic (haiku): planner made only a synthesis step; refs to files the step read itself are not in the source ledger → failed after 4 repairs. Model quality. |
| O13 | Dynamic launch previews say "0 stages" (generated stages are negotiated later). |
| O14 | CLI foreground progress lines are printed on the same line as an open approval question. |
| O15 | Interactive Claude Code records workspace trust for each `/tmp/aw-live5/*` project in its own state file (not `settings.json`); needed for the status line; not reverted. |
| O16 | Classifier requests leave `.agent-workflow/workflows/auto-router-runs/` in the project. |

## WP39b fixes

Branch `wp39b-live5-fixes` from main `505fc78`; no model or agent-CLI call. Every behavior fix has a
test written first and run against the old code (stash of the fix, or `505fc78`'s `dist`) before
the fix. Not fixed: O9 (documented), O12 (model quality), O15 (Claude Code's own state; noted in
[support.md](support.md)). O2 is documentation only (owner decision 2026-10-28: Codex
`approval_policy = "never"` auto-accepting a confirm dialog counts as the user's consent, like
`free`).

| # | Fix | Commit | Test | Pre-fix failure confirmed |
|---|---|---|---|---|
| O1 | `workflow_auto`: an elicitation `cancel`/error (and a dialog that cannot be shown) is `phase: "consent-cancelled"`, "the client cancelled it or cannot ask here"; "declined" only for `decline` | `9303010` (+ `2e91083`: the ported headless `/aw auto` test now expects the cancelled text) | `host-wp32-auto.test.mjs` "a cancelled consent elicitation is the client's cancel …" | yes (`consent-declined`) |
| O2 | Docs: `host-mcp.md`, `plugins.md`, `support.md` — auto-accept under `never` is consent; `-c approval_policy="on-request"` to be asked | `87334ad` | — (docs) | — |
| O3 | Classifier evidence fields: flattened sub-fields (`facts.tools` → `facts`, `readiness.status` → `readiness`, `comparison.overhead.*`) and a unique unprefixed name normalize; anything else stays invalid; prompt unchanged | `84aebdb` | `core-workflow-router.test.mjs` "recorded luna classifier outputs …" on the three recorded live-5 outputs (`test/fixtures/live5/auto-router/`) | yes (all three `undefined`) |
| O4 | Auto choice enum values without a number prefix; equal names get their scope | `79f50f1` | `host-wp32-auto.test.mjs` "auto choice options: no number prefix …" + the MCP choice test | yes |
| O5 | `wait` creates `notify-check/` and the baseline when needed, then marks the settled state seen | `060f5a2` | `host-wp36-progress.test.mjs` "wait marks a returned settled state seen in a fresh project …" | yes (no receipts directory) |
| O6 | Server instructions and the `agent-workflow` skill: "a line containing `agent-workflow:`" (plugins rebuilt) | `4011d54` | `plugin-skills.test.mjs` "the completion-check line is described as a line containing …" | yes |
| O7a | A worktree task's attempt state is written under the project's `.agent-workflow/workflow-subagents/` (runtime `workspace: {mode: "shared", path}` = the worktree as execution directory); readers, recovery and the raw-artifact contract follow | `a4971f5` | `core-wp39b-worktree-state.test.mjs` (real runtime + fixture executor; runtime shared-path), `core-unit-dynamic-runtime.test.mjs` worktree test | yes (`artifactsDir` inside the worktree) |
| O7b | The dirty snapshot excludes the whole `.agent-workflow/` | `d537eb5` | `core-wp39b-worktree-state.test.mjs` "the dirty snapshot never copies .agent-workflow/ …" | yes |
| O7c | `status`/`show` list `Worktree: <path> (branch …)`; `inspect` a `worktree:` line per task | `334ebef` | `core-wp39b-worktree-state.test.mjs` "status, show and inspect name …" | yes |
| O7d | pi-workflow keeps managed worktrees (no auto-merge, `rm` of the run dir on prune); kept here too, documented (`usage.md` "Worktrees"); `prune` dry run lists them (branch, uncommitted changes, commits not in HEAD), `--yes` runs `git worktree remove --force` and `git branch -d` (unmerged branches kept); a failed removal keeps the run | `0208a10` | `core-wp39b-worktree-state.test.mjs` "prune: managed worktrees are listed …" | yes |
| O8 | With inherited host tools the Effective Tool Policy lists codemode, tool_search, `mcp__*`, the MCP resource tools as available; readOnly stages unchanged | `bb26d91` (+ `2e91083`: list moved to core for import isolation, ported prompt-policy test updated) | `executor-wp35-host-tools.test.mjs` "the Effective Tool Policy of a worker that inherits host tools …" | yes |
| O10 | Pi: a settled `approve`/`resume` result is tracked too (delivery receipts keep it exactly once) | `dd0531a` | `host-wp29-approve-later.test.mjs` "Pi /aw approve: a run that settles inside the approve call …" | yes (no message) |
| O11 | Cause: the tracker sends the custom message and then `ctx.ui.notify`s its notice; the TUI prints both. TUI: no notify | `759ef2b` | `host-wp16-pi-feedback.test.mjs` "TUI: the completion is shown once …" | yes |
| O13 | Preview: "stages are generated at run time; each is negotiated when generated" instead of "0 stages" | `e2d9555` | `core-wp39b-dynamic-preview.test.mjs` | yes |
| O14 | CLI: progress and "still running" output held while a question is open, newest line printed after the answer | `75b29e5` | `host-wp29-cli-approval.test.mjs` "no progress line is printed while the approval question is open" | yes (two lines on the open question) |
| O16 | `prune` handles `auto-router-runs/run_*` with the run filters (terminal, `--keep`, `--older-than`, `--yes`); the directory no longer makes retention "uncertain" (every run was protected); never listed as a run | `e6a65db` | `core-wp39b-auto-router-retention.test.mjs` | yes ("uncertain run references") |
| flaky | `host-wp33-pi-parent-usage`: the wrap-up was decided from the debounced run index, so a message right after completion counted as during-run and the next as wrap-up (3 → 4); now the run record; completion wait 120 s | `7744738` | `core-wp39b-parent-usage-wrapup.test.mjs` (index lags on purpose) | yes (`3 !== 2`) |

Validation (final commit): `npm run validate` exit 0 twice at the default concurrency (11 on this
12-core machine) and once with `AGENT_WORKFLOW_TEST_CONCURRENCY=4`; six concurrent runs of
`host-wp33-pi-parent-usage` + `core-unit-dynamic-runtime` passed; `npm run e2e` exit 0; replay
acceptance 0 unexplained in every fixture and variant; `node tools/release/plugins.mjs check`
passes.

## WP42 review round 1 fixes

Branch `wp42-review-fixes-1` from main `3ebf279` (WP39b included); no model or agent-CLI call.
Input: the pre-release feature review of `505fc78` (2 High, 3 Medium; reviewer's probes adapted
into the tests below). One commit per finding; every regression test was written first and run
against the unfixed code, where it failed as listed.

| # | Finding | Fix | Commit | Test | Pre-fix failure confirmed |
|---|---|---|---|---|---|
| 1 | High: auto launch dropped the session signal | `autoAction` keeps `signal` on the launch request; the launch re-checks it after the snapshot, the profile chooser and the launch fence, and passes it as the engine's `launchSignal` (fence after the capability confirm, before publication and dispatch; exact-run stop once published); an aborted launch is `LAUNCH_CANCELLED` → auto `phase: "cancelled"`; the engine also removes an unpublished run directory of a cancelled launch | `25d2024` | `host-wp42-auto-late-cancel.test.mjs` (shutdown inside the profile chooser; inside the capability-degradation confirm) | yes (1 run published, worker submitted) |
| 2 | High: consent did not bind the classifier packet | core `prepareWorkflowAutoComparison` builds the packet (catalog scan, bounded descriptions, task) once before consent; the preview lists exactly its candidates; `sendPreparedWorkflowAutoComparison` sends that frozen packet (no rescan) | `ed534b7` | `host-wp42-auto-consent-packet.test.mjs` (workflow added during consent; description changed during consent; preview list = transmitted list) | yes (sentinel description transmitted) |
| 3 | Medium: lost updates in workflow preferences | every set/clear runs its read–modify–write under the runtime dir-lock (`store-lock.ts`, `acquireDirectoryLock` as the launch guard); the saved user profiles (`set`, `delete`, `default`) had the same pattern and use it too | `22f9ffa` | `host-wp42-preferences-lock.test.mjs` (paused-before-rename interleavings: two saves keep both; set/clear does not resurrect; same for user profiles set/set and default/delete) | yes (all four) |
| 4 | Medium: notification writers followed symlinks | `containedProjectStateDir(create)` checks `.agent-workflow` is a real directory (or creates it as one, non-recursive) and that it is contained before creating the leaf, then re-checks; the hook shell only reads (`[ -d ]`, `find -newer`), the stamp is written by `notify-check --stamp hook-<host>` (exclusive temp, `futimes` to the check start, rename in the contained directory) | `a27653a` | `host-wp42-notify-containment.test.mjs` (symlinked `.agent-workflow` / `notify-check/` for the hook, direct `notify-check` with and without `--stamp`, and `wait`'s seen-marker; outside directory unchanged) | yes (5 of 8; the other 3 guard behavior that already held) |
| 5 | Medium: the idle optimization stranded the backlog | a check that deferred runs (cap 5) removes the stamp instead of writing it, so the next prompt checks again until drained | `6a9b41a` | `host-wp42-notify-backlog.test.mjs` (six settled runs, two hook prompts with no change → five, then one; then idle) | yes (second prompt delivered nothing) |

Validation (final tree): `npm run validate` exit 0 twice with `AGENT_WORKFLOW_TEST_CONCURRENCY=4`;
`npm run e2e` exit 0; replay acceptance 0 unexplained in every fixture and variant;
`node tools/release/plugins.mjs check` passes. Residual: the containment checks are check-then-act
(a concurrent swap of `.agent-workflow` between the check and the write is not covered, as before);
the stop-after-publication path of finding 1 relies on the existing engine semantics and has no new
interleaving test.

## WP42 WP39b-review fixes

Branch `wp42-review-fixes-wp39b` from main `3ebf279`; no model or agent-CLI call. The read-only
review of `505fc78..3ebf279` (3 major, 2 minor) found the new WP39b deleters in `prune` unsafe. Each
fix has its regression test written first and run against `3ebf279`'s `dist` before the fix (all
failed there; the controls named below passed). The review's seven defect probes now fail (the
defects are gone) and its three compatibility controls still pass. Deletion needs physical
containment (real directories from the canonical project root down) and positive identification;
on doubt the item is kept and reported.

| Finding | Fix | Commit | Test | Pre-fix failure confirmed |
|---|---|---|---|---|
| 1 (major) auto-router pruning escapes through symlinked ancestors | An unsafe retention root (`.agent-workflow`/`workflows` a symlink) fails closed for the dry run and `--yes` (`unsafe retention root`); the classifier sweep validates `.agent-workflow/workflows/auto-router-runs` as real directories (new `physical-paths.ts`), and each deletion rechecks chain, directory identity and record under the runtime's run lock, then detaches into a `.prune-*` container | `3656eb4` | `core-wp42-f1-symlinked-ancestors.test.mjs` | yes (external classifier dir deleted via `.agent-workflow` and `workflows` symlinks; no recheck when swapped after selection); the `auto-router-runs` symlink case was already refused (control) |
| 3 (major) classifier records not positively identified | Deleted only when `run.json` is the runtime's schema-2 record with correlation `workflow-auto-compare-v1`, `runsDir` `.agent-workflow/workflows/auto-router-runs`, single mode, and a runtime-generated id `run_<base36>_<6 hex>` equal to its directory (`auto-router-runs.ts`, shared with the router); everything else is kept and listed ("Kept in auto-router-runs") | `10a7cd2` | `core-wp42-f3-classifier-identity.test.mjs` (+ WP39b fixture ids now runtime-format) | yes (foreign record, non-runtime id, other correlation and other `runsDir` all deleted) |
| 2 (major) worktree deletion without containment/ownership | A recorded worktree is touched only when its recorded branch is the managed `agent-workflow/<run>-<task>`, the chain down to `<run>/worktrees/<task>` has no symlink, and this repository's `git worktree list --porcelain` (run in the project, not the recorded `baseCwd`) registers that path on that branch; rechecked right before `git worktree remove`; a missing directory's stale registration is removed for that path only (no repository-wide `git worktree prune`); otherwise worktree, branch and run are kept | `1bdaa1f` | `core-wp42-f2-worktree-ownership.test.mjs` | yes (outside worktree through a symlinked `worktrees/`, another repository's worktree via `baseCwd`, a user branch checked out at the managed path, and a user branch named by metadata of a missing worktree were all removed/deleted) |
| 4 (minor) missing worktree bypasses unmerged-branch protection | The managed branch's tip is resolved also when its worktree is missing and counted against the checkout's HEAD; deletion needs `git merge-base --is-ancestor <tip> HEAD`, no worktree on it, and `git update-ref -d refs/heads/<branch> <tip>`; upstream configuration is irrelevant; unknown state keeps the branch | `bababf4` | `core-wp42-f4-missing-worktree-branch.test.mjs` | yes (preview said 0 commits, branch deleted through its upstream); merged-branch control passed before and after |
| 5 (minor) prune can remove a classifier result its caller still needs | `workflow-router` pins each comparison request (`auto-router-runs/.pins/<pid>-<random>.json`) from before launch until `readOneShotOutput` returns; prune keeps (`protected`) records updated since a live pin, treats a malformed pin as pinning all, drops pins of dead processes, and rechecks pins, terminal status and identity under the run lock right before detaching | `98edd3b` | `core-wp42-f5-classifier-pin.test.mjs` | yes (result deleted between terminal publication and consumption, then `routing-unavailable`; no recheck of a record no longer terminal); dead-pin control passed before and after |
| docs | `usage.md` "Retention"/"Worktrees": what prune removes and keeps; plugins rebuilt | final commit | `node tools/release/plugins.mjs check` | — |

Validation (final commit): `npm run validate` exit 0 twice in a row with
`AGENT_WORKFLOW_TEST_CONCURRENCY=4` (2497 pass, 0 fail). Two earlier full runs each had one load
flake in a test that does not touch retention: at the default concurrency (11) replay acceptance
impact-review captured a transient `supervisor.lock.release-*` file of the core supervisor lease
(the file alone then passed with 0 unexplained), and one concurrency-4 run had
`host-wp29-cli-approval` "no progress line is printed while the approval question is open" fail on a progress line printed before the
run completed. `npm run e2e` exit 0; `node test/replay/acceptance.mjs`
0 unexplained in every fixture and variant; `node tools/release/plugins.mjs check` passes.

Residual risk: removal still goes through `git worktree remove --force <path>` after the last
recheck (a swap in that window is limited to worktrees git itself has registered for this
repository); a classifier call whose pin cannot be created (state directory not a chain of real
directories, which prune never deletes through) runs unpinned; a pin protects every classifier
record updated since it was taken (over-retention, not loss) and a reused pid of a dead pinning
process keeps records until that process exits.

## WP42 review round 2 fixes

Branch `wp42-review-fixes-2` from main `cdab133`; no model or agent-CLI call. Input: the round-2
confirmation review of `cdab133` (1 major, 2 minor; the reviewer's probes adapted into the tests
below, defect observations inverted). One commit per finding; every regression test was written
first and run against the unfixed code, where it failed as listed.

| # | Finding | Fix | Commit | Test | Pre-fix failure confirmed |
|---|---|---|---|---|---|
| N1 | Major: path aliases bypassed worktree ownership checks | a recorded worktree path is mapped onto the canonical project root (its `<root>/.agent-workflow/workflows/<run>/worktrees/<task>` prefix resolved with `realpath`; symlinks below the root still refused by the physical chain); an enabled record that cannot be mapped (unresolvable or other project root, outside the run's `worktrees/`, no path) is an error that keeps the run; before detaching a run directory prune lists `git worktree list` and keeps the run if any registered worktree is still inside it (outside a git repository nothing can be registered) | `989679c` | `core-wp42-n1-worktree-path-alias.test.mjs` (real `ensureManagedWorktree` through `/tmp`, switched to `user-work` with an uncommitted file → kept; symlinked-project variant → kept; unchanged managed-branch controls via both aliases → removed with no stale registration and the branch deleted; unresolvable recorded root → kept; unrecorded registered worktree inside the run → kept; runs without worktrees in and outside git → removed) | yes (5 of 6; the last is a control) |
| N2 | Minor: stamp errors discarded claimed notifications | the hook stamp is best-effort after the receipts are claimed: a failed replacement removes the stamp instead, a failed removal warns on stderr; never a recursive removal at the stamp path; the hook's fast path needs a regular stamp file, so a directory there means the next prompt checks again | `2f4dacb` | `host-wp42-n2-notify-stamp-errors.test.mjs` (directory at `hook-claude-code.stamp`: one run printed; six-run backlog prints five, then one; obstruction kept; in-process warning; writable-stamp control) | yes (3 of 4; the control passed) |
| N3 | Minor: failed pin creation was not prune-safe | `acquireAutoRouterPin` throws on any failure except a proven non-prunable layout (a component of `.agent-workflow/workflows/auto-router-runs` is a symlink or not a directory: `undefined`, unpinned); the router then returns `routing-unavailable` ("could not be pinned … no classifier was called") without a classifier submit | `83c62d5` | `core-wp42-n3-pin-failure.test.mjs` (`.pins` mode 0555 → refused, zero submits; symlinked `auto-router-runs` → one submit, result kept by prune; normal layout → pinned, result kept, pin released) | yes (0555 case; the two others guard behavior that already held) |
| docs | `usage.md` prune keeps-what list and worktree identification; plugins rebuilt | final commit `fix: WP42 review round 2` | `node tools/release/plugins.mjs check` | — |

Validation (final tree): `npm run validate` exit 0 twice in a row with
`AGENT_WORKFLOW_TEST_CONCURRENCY=4` (2529 pass, 0 fail, 29 skipped); `npm run e2e` exit 0;
`node test/replay/acceptance.mjs` 0 unexplained in every fixture and variant;
`node tools/release/plugins.mjs check` passes. The reviewer's six defect observations now fail
(the defects are gone); its controls and confirmation probes pass. Residual: the registered-worktree check and the
final `rename` are check-then-act (a worktree registered inside a run directory in between is not
covered); a project moved after its runs recorded worktrees keeps those runs (the recorded root no
longer resolves) until they are removed by hand; a symlinked `auto-router-runs` replaced by a real
directory during an unpinned call is not covered.

## Live-call ledger (18 workflow runs of ≤ 20)

Usage = the run's task roll-up (input excludes cache reads/writes). Claude costs are
`total_cost_usd` (notional, subscription); Codex reports none (`null`); Pi costs are Pi's catalog
estimate for `openai-codex/gpt-5.6-luna` (ChatGPT subscription).

| # | Check | Host (model) | Workers (model) | Run id | Status / verdict | Tasks | Wall | Total tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A1 | Claude Code 2.1.310 (haiku) | claude (haiku) | `workflow_mvsc3sjr_7640f0` | failed / PARTIAL_REVIEW | 13/14 | 124 s | 395,748 | $0.0377 |
| 2 | A4 | Claude Code 2.1.312 (haiku) | claude (haiku) | `workflow_mvsc9e97_e96293` | completed | 2/2 | 71 s | 12,469 | $0.0014 |
| 3 | B1 | Codex (luna low) | codex (luna low) | `workflow_mvscgd9b_d9ba85` | failed / PARTIAL_REVIEW | 10/11 | 58 s | 324,261 | — |
| 4 | C1 | CLI | claude haiku + codex luna low | `workflow_mvsck9xp_7a85b5` | completed / NEEDS_WORK | 14/14 | 76 s | 416,533 | $0.0203 (claude part) |
| 5 | C2 | CLI (TTY) | claude (haiku) | `workflow_mvscqdrv_5d919e` | completed / NEEDS_WORK | 16/16 | 90 s | 422,217 | $0.0378 |
| 6 | C1 | CLI | mixed | `workflow_mvscqzqo_dd0550` | completed / NEEDS_WORK (stop missed) | 13/13 | 100 s | 432,751 | $0.0212 |
| 7 | C1 | CLI | mixed | `workflow_mvscu2vn_8ba300` | failed (F2) | 7/10 | 42 s | 67,363 | $0.0060 |
| 8 | C1 | CLI | mixed | `workflow_mvsd0auj_e30fed` | failed (F2, 2nd layer) | 7/11 | 40 s | 48,246 | $0.0051 |
| 9 | C1 | CLI | mixed | `workflow_mvsd4t60_4eb599` | completed / NEEDS_WORK (stop + resume) | 16/16 | 93 s | 442,073 | $0.0244 |
| 10 | C3 | CLI (TTY, safe) | codex (luna low) | `workflow_mvsd6mfe_8ef1fb` | completed | 2/2 | 13 s | 50,767 | — |
| 11 | C4 | CLI | codex (luna low), dynamic | `workflow_mvsd8ho2_d3ff4e` | completed | 8/8 | 117 s | 306,934 | — |
| 12 | C4 | CLI | claude (haiku), dynamic | `workflow_mvsd8jtz_2cc5f7` | failed (output validation) | 1/3 | 98 s | 147,852 | $0.0138 |
| 13 | C5 | CLI | claude (haiku) | `workflow_mvsd8zdz_064ad7` | completed | 1/1 | 17 s | 13,786 | $0.0016 |
| 14 | C6 | CLI (TTY) | claude (haiku) | `workflow_mvsda7m2_20ff5b` | completed (after `approve`) | 2/2 | 32 s | 12,512 | $0.0006 |
| 15 | D1/D2 | Pi (luna low) | pi (luna low) | `workflow_mvsdonwy_a638a5` | failed (reviewer output) | 12/14 | 113 s | 153,202 | $0.0276 |
| 16 | D2 | Pi | pi (luna low) | `workflow_mvsdwvhx_835052` | completed (board `a`) | 2/2 | 44 s | 2,608 | $0.0006 |
| 17 | D3 | Pi | pi (luna low) | `workflow_mvse1wtr_fd06a6` | completed | 1/1 | 7 s | 2,576 | $0.0006 |
| 18 | D4/D5 | Pi (agent turn) | pi (luna low) | `workflow_mvse2trj_5b109f` | completed | 2/2 | 13 s | 6,247 | $0.0016 |

Model calls outside workflow runs:

| Turn | Model | Tokens | Cost |
|---|---|---|---|
| A1 print-mode host turn | Claude haiku | in 6, out 1,133, cache read 76,204, cache write 23,116 | $0.0060 (reported) |
| A1 interactive host session (7 messages) | Claude haiku | in 14, out 1,478, cache read 337,080, cache write 26,205 | $0.0094 * |
| A4 host session (7 messages) | Claude haiku | in 14, out 1,939, cache read 341,866, cache write 26,561 | $0.0097 * |
| A5 monitor turn | Claude haiku | in 2, out 308, cache read 27,827, cache write 3,395 | $0.0011 * |
| B1 first session (YOLO) | Codex luna low | in 87,995 (cached 67,712), out 440 | — |
| B1 retry + B3 + B4 session | Codex luna low | in 438,238 (cached 408,832), out 1,237 | — |
| B2 `codex exec` (L5) | Codex luna low | in 16,611 (cached 6,784), out 121 | — |
| D4 Pi agent turn (3 messages) | Pi luna low | in 21,469, out 226, cache read 41,600 | $0.0054 (Pi estimate) |
| Classifier A1 / C2 | Claude haiku | out 3,302 / 3,135 (+ cache) | $0.0044 / $0.0040 |
| Classifier B1 ×2 | Codex luna low | 10,817 + 1,099; 193 (+17,536 cached) + 1,101 | — |
| Classifier D1 ×2 | Pi luna low | 7,841 + 1,338; the Escape-cancelled one reported none | $0.0032 |

\* from the session transcript, priced with the rates the Claude worker records fit exactly
(haiku-5-5: input $0.10/M, output $0.50/M, cache read $0.01/M, cache write $0.20/M).

| CLI | Runs | Cost |
|---|---|---|
| Claude Code | 4 host sessions/turns, 2 classifier calls, workers in 12 runs (6 claude-only, 6 mixed) | ≈ **$0.205** notional: workers $0.170, hosts $0.026, classifiers $0.008 |
| Codex | 3 host sessions, 2 classifier calls, workers in 3 codex-only + 6 mixed runs | **not reported** (tokens only): ≈ 0.68 M codex-only worker tokens + the codex share of the mixed runs, 0.54 M host tokens; weekly window 7 % → 10 % (ordinary allowance; it also covers Pi's `openai-codex` calls) |
| Pi | 1 agent turn, 2 classifier calls, workers in 4 runs | ≈ **$0.039** Pi catalog estimate (workers $0.030, host $0.005, classifier $0.003) |

## Config changes and restore

**Codex** (`codex/install-remove.log`, `codex/config-restore-proof.txt`): backup of
`<HOME>/.codex/config.toml` (SHA-256 `25ae5747…`) before `codex plugin marketplace add
/tmp/aw-live5/plugin` + `codex plugin add agent-workflow@agent-workflow`, which added exactly
`[marketplaces.agent-workflow]` and `[plugins."agent-workflow@agent-workflow"] enabled = true`.
Before removal the diff also showed `[projects."<HOME>/experiments/video-summarizer/internal/e2e/hosts2/codex"]
trust_level = "trusted"`, **written by another, unrelated process** of the user during the bundle
(not an aw-live5 path; every Codex run here trusted its target inline). After `codex plugin remove`
and `codex plugin marketplace remove` the diff against the backup is exactly that foreign 3-line
block; with it removed from a copy, `diff` against the backup is empty but for its blank line. The
foreign entry was **left in place** instead of copying the backup back, so a concurrent process's
change is not destroyed; so `cmp` with the backup is not byte-identical (SHA-256 now `7f04f9e8…`).
No `agent-workflow`/`aw-live5` line remains; `codex plugin marketplace list`, `codex plugin list` and
`codex mcp list` show no agent-workflow entry; the (empty) cache dir
`<HOME>/.codex/plugins/cache/agent-workflow/` was deleted. Hooks were only in the target's
`.codex/hooks.json`. The Codex session files of these runs stay in `<HOME>/.codex/sessions/2026/10/29/`
(`codex/codex-session-files.txt`: the two TUI sessions and the `codex exec` turn).

**Claude Code**: only per-invocation `--plugin-dir`/`--settings`; the temporary
`monitors/monitors.json` lived in the dev plugin copy under `/tmp` and was removed. Host residue moved
to `/tmp/claude-live5-host-session-residue-20261028T173424Z/`: `projects/` (the three host sessions
a1, a4, a5 — no worker directory: D3 clean) and `caches/` (`~/Library/Caches/claude-cli-nodejs/
-private-tmp-aw-live5-*`, MCP logs of hosts and workers). Interactive sessions recorded workspace
trust in Claude Code's own state (O15).

**Pi**: only `pi -e` + `--skill` + `--session-dir /tmp/aw-live5/pi-sessions` + `--approve` (one
process). The one persisted session file moved to `/tmp/pi-live5-host-session-residue-20261028T173424Z/`;
no `<HOME>/.pi/agent/sessions` entry for the targets.

**agent-workflow state**: the test profiles `live5-mixed`, `live5-pi`, `live5-b4-test` and the
`live5-profiles` preference were deleted (none existed before). Executor attempt records under
`<HOME>/.agent-workflow/executors/` stay (pruned by retention).

## Still unverified

- L4 (a long `workflow_wait` that Claude Code backgrounds) and `asyncRewake`: not tried (L4 needs a
  server change); L3 monitor push verified once on Claude Code 2.1.312.
- Pi fast tier (E): no API-key `openai/*` provider in the user's Pi configuration.
- pi-web-access *missing* path (doctor warning and refusal naming `pi install npm:pi-web-access`):
  the package is installed here; not uninstalled.
- A role model missing from a probe list (the "not verified by probe" note) in a live launch.
- `/aw <run-prefix>` opening one run's board, and the `/aw wait` loader after F5 (same loader factory
  as the verified `/aw auto` loader).
- Host tools: a worker actually calling an inherited `mcp__*`/`codemode` tool (O8), and project-level
  MCP servers for workers (O9).
- `y` at the in-run CLI approval question (the same prompt as the verified `approve` one).
- Elicitation on Codex with the user's own `approval_policy = "never"` (O2): decided 2026-10-28,
  the auto-accept counts as consent (documented, WP39b).

## WP42 review round 3 fix

Round-3 confirmation review (gpt-6-astra, `9bfcfaa`): N1–N3 fixed (13 new tests: 9 behavioral
failures on `cdab133`, all pass on the target), no false keeps for canonical/aliased/non-git
layouts, one remaining major. Fixed by the parent:

| Finding | Fix | Regression test | Fails before the fix |
|---|---|---|---|
| N4 (major): with git missing (`ENOENT`) or outside a git repository, `registeredWorktreeInside` inferred "no registered worktree", so a run directory holding an unrecorded worktree with user work was deleted | Without a git listing, a git checkout found on disk inside the run directory (a `.git` entry, no symlinks followed, bounded depth) keeps the run; `git` calls time out after 30 s (fail closed) | `test/unit/core-wp42-n4-missing-git.test.mjs` (git missing + unrecorded worktree → kept; non-git project + nested checkout → kept; control without a checkout → removed) | yes (2 of 3; the control passes) |

