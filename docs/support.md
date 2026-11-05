# Support matrix (stages 1 and 2)

What runs where, verified how. Executors (stage 1) come from two sources below; hosts (stage 2)
from [live bundle 4](live-acceptance-stage2.md), see [Hosts](#hosts-stage-2); the pre-release features
(WP28–WP38b) from [live bundle 5](live-acceptance-features.md), see [Live bundle 5](#live-bundle-5-pre-release-features),
re-verified after the WP39b/WP42 fixes in [live bundle 6](live-acceptance-features.md#live-bundle-6-re-verification), see
[Live bundle 6](#live-bundle-6-re-verification).

- **Live**: every bundled workflow run end to end on each executor with real CLIs and models
  (live bundle 3, 2026-10-27). Full evidence, per-run usage and the failure analysis:
  [`live-acceptance-stage1.md`](live-acceptance-stage1.md).
- **Offline**: the B4 capability negotiation of every bundled spec against each adapter's capability
  table, in both permission modes, regenerated and checked by the unit tests:
  [`bundled-workflows.md` "Support table"](bundled-workflows.md#support-table).

Cell values: **completed** (ran to its final render; a domain verdict such as `PARTIAL_REVIEW`,
`INCONCLUSIVE`, `GAPS_FOUND` or `BLOCKED` is a finding about the target, not an engine failure),
**completed-degraded** (completed with recorded capability degradations, listed), **refused** (B4
did not start the run). Quality is not compared.

## Verified CLI versions

| Executor | Adapter | Verified CLI | Login used | Live model in the acceptance runs | Adapter doc |
|---|---|---|---|---|---|
| `pi` | 0.1.0 | Pi 1.1.0 (minimum 1.1.0: native MCP) | ChatGPT subscription | `openai-codex/gpt-6.1-sol` (Pi default) | [`executors/pi.md`](executors/pi.md) |
| `codex` | 0.1.0 | codex-cli 0.159.2 | ChatGPT login | `gpt-5.6-luna` | [`executors/codex.md`](executors/codex.md) |
| `claude` | 0.1.0 | claude-code 2.1.310 | claude.ai subscription | `haiku` (`claude-haiku-5-5`) | [`executors/claude.md`](executors/claude.md) |

Re-verified since (executor live tiers): codex-cli 0.165.0 and claude-code 2.1.314 (2026-11-01),
**codex-cli 0.166.0 and claude-code 2.1.318 (2026-11-04)**, which are the verified versions now.
**`antigravity` (experimental, 2026-11-02):** the ACP adapter for Antigravity's `agy_acp_server`
1.4.5, Antigravity login, live model `gemini-3.8-flash` — [`executors/acp.md`](executors/acp.md).
Experimental: capabilities stay `declared`, workspace `AGENTS.md`/`GEMINI.md` are not isolated,
no session ownership or resume.

All on macOS. SDK contract 0.1.0. `probe()` adds a note when the installed CLI version differs from
the verified one; rerun the conformance kit then ([`conformance.md`](conformance.md)).

## Live matrix, 2026-11-04 (four executors, current verdict rules)

Every bundled workflow on each executor, Korean tasks, latest run per cell. Models: pi default (`gpt-6.1-sol`), claude
`haiku`, codex `gpt-5.6-luna`, antigravity `gemini-3.8-flash`. All runs completed; codex and
antigravity cells carry recorded capability degradations (`toolAllowlist.fine`, the test machine's
`readOnly`/`contextIsolation` warnings, `usage.cost`; antigravity also `webTools.safetyPolicy`).

| Executor | deep-review | spec-review | impact-review | deep-research |
|---|---|---|---|---|
| **pi** | completed (`NEEDS_WORK`) | completed (`GAPS_FOUND`) | completed (`BLOCKED`) | completed |
| **codex** | completed (`NEEDS_WORK`) | completed (`GAPS_FOUND`) | completed (`BLOCKED`) | completed; also the tiered-verification variant |
| **claude** | completed (`NEEDS_WORK`) | completed (`GAPS_FOUND`) | completed (`BLOCKED`) | completed (2026-11-03) |
| **antigravity** (experimental) | completed (`NEEDS_WORK`) | completed (`GAPS_FOUND`) | completed (`BLOCKED`) | completed (2026-11-03, flash) |

Fixes made during these runs are in [`bundled-workflows.md`](bundled-workflows.md) M26–M29 and M28b
(impact-review summary bound, evidence tolerance, Korean requirement statements, verdict precedence).

## Live matrix, 2026-10-27 (default `free` mode)

| Executor | deep-review | spec-review | impact-review | deep-research |
|---|---|---|---|---|
| **pi** | completed (`PARTIAL_REVIEW`) | completed (`INCONCLUSIVE`) | completed (`UNKNOWN`) | completed-degraded: `webTools.safetyPolicy: unknown` |
| **codex** | completed-degraded: `toolAllowlist.fine` missing (accepted: free mode), `readOnly` warning, `contextIsolation` warning, `usage.cost` | completed-degraded (`GAPS_FOUND`): same four | completed-degraded (`BLOCKED`): same four | completed-degraded: same four + `webTools.safetyPolicy: unknown` |
| **claude** | completed (`NEEDS_WORK`) | completed (`INCONCLUSIVE`) | completed (`BLOCKED`) | completed-degraded: `webTools.safetyPolicy: unknown` |

No cell was refused. The Codex `readOnly` and `contextIsolation` warnings come from the test machine
(allow rules in `~/.codex/rules`, a global `~/.codex/AGENTS.md`); a clean Codex home shows neither.
Three product bugs found during the runs were fixed before the final attempts (synthesis page size,
per-executor tool names in the worker prompt, Claude session ids); see the acceptance document. The
cells record the acceptance runs; open problems 1–6 and 10 found there were fixed afterwards (WP12a),
since then Codex costs are recorded as unknown instead of `0` and no worker sessions are kept.

The bundled workflows were not run live in `safe` mode. Its offline negotiation differs only for Codex: the precise tool lists
degrade to `forcedReadOnly` (the bundled specs opt in with `allowReadOnlyDowngrade`), and environment
warnings need confirmation in an interactive host.

## Host × executor matrix, 2026-11-04

deep-review on the same target, the host driving it through its plugin's MCP server in print mode
(Codex: `codex exec`, gpt-5.6-luna low, the user's `approval_policy = "never"`; Claude Code:
`claude -p --model haiku`), Korean task. Mixed A: triage pi, reviewers claude, devil's advocate
antigravity, report codex. Mixed B: triage codex, reviewers antigravity, devil's advocate pi, report
claude. Every run completed with `NEEDS_WORK`; each host reported verdict, run id and dashboard link.

| Host → workers | Confirmation | Notes |
|---|---|---|
| Codex → codex, claude, pi | not needed | 101–311 s |
| Codex → antigravity, Mixed A | dialog: Codex accepted it itself (`approval_policy = "never"`, owner decision O2) | Mixed A stopped mid-run and resumed through the host: only the interrupted verifier and the steps after it ran again |
| Claude Code → codex, pi | not needed | |
| Claude Code → antigravity, Mixed B | asked in chat (print mode cancels dialogs): no run until the user agreed, then `acceptDegradations: ["resume"]` (`confirmedVia: "chat"`) | |

The limit that needs an OK on antigravity is `resume` (a repair starts a new session). Three runs
were partial (a reviewer or verifier quote not in its cited lines, or coverage of an unassigned
file), each named in the report. Waiting is cheap on the Claude host ($0.009–0.018 per run) and
token-heavy on the Codex host (0.6–1.2 M input tokens per run, ~95 % cached: one `workflow_wait`
call per 45 s). All nine runs are replay fixtures (`test/fixtures/support-replay/`).

## Hosts (stage 2)

The agent that the user talks to. Workers run on the executor the run selects (explicit choice,
workflow profile, else the host's own CLI: `host-default`). Live bundle 4, 2026-10-27,
[`live-acceptance-stage2.md`](live-acceptance-stage2.md); the Codex host in live bundle 4b, 2026-10-28.

| Host | Verified CLI | Path | Tool names the model sees | Default executor | Live result | Notes |
|---|---|---|---|---|---|---|
| **Claude Code** | 2.1.310 | plugin (`--plugin-dir` dev copy; marketplace install verified offline, [plugins.md](plugins.md)); alternative `claude mcp add` | `mcp__plugin_agent-workflow_agent-workflow__workflow_{list,run,dynamic,status,wait,stop,inspect,validate}` (observed: `…workflow_run`, `…workflow_wait`, `…workflow_inspect`) | `claude`, `host-default` (observed) | completed: claude workers (`NEEDS_WORK`), codex workers (`PARTIAL_REVIEW`, finished detached after the host stopped waiting); live 5 (2.1.310/2.1.312): `workflow_auto` (consent + enum choice form), `workflow_approve` | The model receives `structuredContent` serialized as JSON, not `content` (WP18b: text only since). Tool schemas are deferred: the first call is `ToolSearch select:…`. `claude -p --permission-mode default --allowedTools <the 8 tools>` had no denials. The plugin's three skills are listed. Live 5: elicitation dialogs render in the interactive TUI (verified); `-p` auto-cancels every elicitation, so `workflow_auto` ("the client cancelled", `consent-cancelled`) and confirmed changes refuse there. Interactive Claude Code records workspace trust for each new project directory in its own state file (not `settings.json`); the status line needs it; agent-workflow neither writes nor reverts it (O15). |
| **Codex** | 0.159.2 | plugin (`codex plugin marketplace add` + `plugin add`, temporary, in the real `CODEX_HOME`; host turn `codex exec`); alternative `codex mcp add` | code mode: the model calls `exec` (JavaScript cell) and inside it `tools.mcp__agent_workflow__workflow_{run,wait,inspect}` (observed; all 8 listed via `ALL_TOOLS`); the `--json` stream shows server `agent-workflow`, tool `workflow_*` | `codex`, `host-default` (observed) | completed (live 4b): codex workers and claude workers, both `PARTIAL_REVIEW` (run `failed` by `support_declared_failed`; the host saw no preview or report path); live 5: `workflow_auto`, `workflow_show`, `workflow_doctor`, `workflow_profile` set/delete with elicitation | The model printed the whole `CallToolResult`, so it saw `content` and `structuredContent`. `workflow_wait` (45 s) outlasts the 30 s code-mode yield; the model resumed with `wait`. Skills `agent-workflow:{agent-workflow,execution-router,workflow-guide}` listed; server runs in the thread cwd with `--host codex`. A new directory gets a `trust_level = "trusted"` entry in the user config unless trusted inline (`-c projects={…}`). Live 5: with `approval_policy = "on-request"` the consent and enum forms render (one `workflow_auto` call with both dialogs and the classifier took 31 s of the 120 s `tool_timeout_sec`); with the user's `approval_policy = "never"` Codex **auto-accepts** empty confirm forms and cancels the enum form; by owner decision (O2) that auto-accept counts as the user's consent, like `free`; run Codex with `-c approval_policy="on-request"` to be asked ([host-mcp.md](host-mcp.md#codex-approval_policy--never-owner-decision-o2-2026-10-28)); destructive-annotated tools (`workflow_auto`, `workflow_profile`, also its `show`) need Codex's tool approval first. |
| **Pi** | 1.1.0 | extension (`pi -e <package>/dist/hosts/pi/index.js`, or `pi install`) | `/aw …` command; agent tools `aw_list`, `aw_run`, `aw_dynamic`, `aw_wait` | `pi`, `host-default` (observed) | completed: `/aw run` in RPC mode, no model turn (`NEEDS_WORK`); live 5 (TUI): `/aw auto`, board, profile picker, `aw_run` + `aw_wait`, host tools | Footer status `aw: <name> <done>/<total> running`, exactly one `agent-workflow-completion` message, `/aw logs` and `/aw status`. The message's "Verdict:" line is the run status, the report verdict is in the preview. WP34 (live-verified in bundle 5 after fixes F4/F5): in the TUI `/aw` and `/aw <run>` open the run board and `/aw profile` the profile picker ([pi-host.md](pi-host.md#board-wp34)); RPC, print and JSON mode keep the text commands. |

Progress and completion per host (WP36, offline; [host-ux-investigation.md](host-ux-investigation.md)):

| Host | Status display | Live view | Completion delivery |
|---|---|---|---|
| **Claude Code** 2.1.310/2.1.312 | `agent-workflow statusline` as `statusLine.command` (user setting; plugins cannot set it); **live-verified** (L2) | `agent-workflow watch [run]` in a terminal (live-verified) | Pull: `workflow_wait`/`workflow_status`; plugin `UserPromptSubmit` hook runs `notify-check --stamp hook-claude-code`: **live-verified** (L1; the line reaches the context prefixed "UserPromptSubmit hook success:", idle prompts start no CLI; live 6: the WP42 stamp path, a six-run backlog delivered as five then one, a symlinked `notify-check/` writes nothing outside). Push: a plugin monitor running `notify-check --follow` **started a turn in an idle session** (L3, live 5; not shipped yet); `asyncRewake`, backgrounded wait (L4), MCP tasks: not verified |
| **Codex** 0.159.2 | none (`tui.status_line` has only built-in items) | `agent-workflow watch [run]` (`--bell`) | Pull: the tools; `notify-check` hook as user config (`/hooks` trust): **live-verified** (L5, project `.codex/hooks.json`). Push via `codex queue --thread <id>`: **live-verified** (L6: an idle TUI started a turn, one model turn per delivery; no separate daemon needed); not wired into the product (owner decision on cost); `notify` fires only on Codex turn completion |
| **Pi** 1.1.0 | footer status (WP16) | `/aw status` | push: one completion message (WP16/WP19) |

Nesting and concurrency: Claude host → Claude workers, Claude host → Codex workers, Codex host →
Codex workers and Codex host → Claude workers showed no auth or session conflict; three concurrent
CLI runs on Claude workers (13 worker processes at peak) and three on Codex workers (9 concurrent
Codex worker attempts at peak, live 4b) completed without token-refresh, auth, lock or rate-limit
errors. Codex worker threads are ephemeral (no kept thread, no rollout). Worker artifact tool: `mcp__workflow_artifact__workflow_artifact`
on Claude and Pi, server `workflow_artifact` / tool `workflow_artifact` on Codex. Since `91dc66a`
Claude workers leave no spilled tool results under `~/.claude/projects` (D3).

## Offline matrix (summary)

From the generated table (declared capability table / probed clean environment):

| Executor | deep-review, spec-review, impact-review | deep-research (both specs) |
|---|---|---|
| **pi** | accept | refused on the declared table (`CAPABILITY_UNVERIFIED:webTools`: web tools come from the `pi-web-access` extension, which only the probe can confirm); with the extension installed: degrade `webTools.safetyPolicy:unknown`; without it: refused (`CAPABILITY_MISSING:webTools`) |
| **codex** | `free`: degrade `CAPABILITY_MISSING:toolAllowlist.fine`; `safe`: the same plus `forcedReadOnly` | as on the left, plus `webTools.safetyPolicy:unknown` |
| **claude** | accept | degrade `webTools.safetyPolicy:unknown` |

## Known limits per executor

Each adapter document has the full list under "Known limits".

**Pi** ([`executors/pi.md`](executors/pi.md#known-limits))

- No approvals and no sandbox: `free` and `safe` give the same argv; readOnly drops mutating tools.
- `sessionBound`: no re-attach to a running Pi after its owning process dies.
- deep-research needs the `pi-web-access` extension (refused otherwise). It is not bundled (C2); the
  probe detects it via `pi list`, and the preview, the refusal and `agent-workflow doctor` name the
  install command `pi install npm:pi-web-access` when it is missing (WP35).
- Host tools (WP35): from a Pi 1.1 host with native codemode/MCP, non-readOnly Pi workers inherit
  `codemode`, `tool_search`, `mcp__*` and the MCP resource tools (mutation-capable; readOnly stages never
  inherit; recorded as a preview notice). Other hosts and other executors are unchanged; Codex/Claude
  user-MCP inheritance is a separate opt-in (B6). Live 5: the worker's tool list held `codemode`,
  `tool_search` and the user-level `mcp__*` tools, a readOnly stage had none; project `.pi/mcp.json`
  servers do not reach workers (`--no-approve`), and the worker system prompt still lists only the
  stage's tools, so the model did not use them (open O8).
- Cost is Pi's catalog estimate (`source: estimated`), also on a subscription. (Fixed in WP12a: usage
  now carries cache-write tokens and the serving model, so Pi tasks record their model.)
- Fast tier unverified: the provider-stream guard is ported (WP35; guard failure → `config`,
  degrade → `payload-only`, reported in `pi-fast-tier.json`) and tested offline with fake provider
  streams; it runs only with `allowUnverifiedCapabilities: ["fastTier"]` until a live check.

**Codex** ([`executors/codex.md`](executors/codex.md#known-limits))

- Coarse tool allowlist only (a sandbox mode): precise `tools` lists cannot be enforced
  (`free` records it, `safe` runs readOnly when the spec allows, else refuses).
- A global `$CODEX_HOME/AGENTS.md` and `~/.codex/rules` cannot be disabled per run; the probe reports
  them as warnings (recorded degradations).
- No cost reported (tokens only): the cost is recorded as unknown (`null`, `cost unknown`), never `0`,
  and the preview records `usage.cost` as a record-only degradation. Output includes reasoning
  tokens. (Fixed in WP12a: the run roll-up showed `0`, and input tokens included cached tokens; input
  is now normalized to exclude cache reads and writes.)
- Hosted `web_search` only (no separate fetch); `fetch_content`, `grep`, `find`, `ls` mappings and
  token-refresh contention are unverified.
- Attempt records and logs under the adapter state directory are not pruned yet.

**Claude** ([`executors/claude.md`](executors/claude.md#known-limits))

- `sessionBound`: a worker that dies loses the CLI's stdio; reconcile needs a decision.
- The CLI auto-allows reads inside the cwd and read-only Bash commands (visible only as `tool_call`).
- The CLI inherits the full environment: a set `ANTHROPIC_API_KEY` switches it to API-key billing.
- Cost is `total_cost_usd`, notional on a subscription. (Fixed in WP12a: the run records the resolved
  model, not the alias such as `haiku`, and input tokens no longer add cache reads and writes.)
- `deadlineMs` is not enforced by the adapter (the runtime enforces timeouts).

**All executors**

- Web tools are the CLI's own: URL, private-network and redaction controls are not engine-enforced
  (`webTools.safetyPolicy: unknown`), and web evidence is model-reported.
- Task prompts name tools with Pi names; the system prompt maps them per executor.
- Usage has one normalized shape on every executor (input excluding cache reads and writes, cache
  read, cache write, output, total, model); an unknown cost is `null`, never `0` (WP12a).

**Mixed runs (WP31, owner decision Q4)**

- A role profile may put stages of one run on different executors; each stage is negotiated against
  its own executor and the strictest per-executor limits above apply stage by stage (for example a
  web stage on Codex gets hosted `web_search` only; a precise `tools` list on Codex is coarse).
- Every executor of the run must be installed and logged in before it starts (each is probed once).
- Role models are checked against probe model lists: Codex lists its slugs, Claude Code lists aliases
  (`default`, `haiku`, `sonnet`, `opus`; a full model id is refused there — use an alias), Pi lists
  none (the model is noted as unverified, not refused).
- Dynamic decision-loop slots and the workers a dynamic stage generates stay on the dynamic stage's
  executor; nested workflow runs keep their parent's executor.
- Live-verified in bundle 5: a saved profile with `default=claude:haiku` and
  `research-execution=codex:gpt-5.6-luna:low` on deep-review (per-task executors in the preview,
  `status`, `watch`; both probes; `NEEDS_WORK`), and stop → resume of a mixed run (after fix F2;
  no kept Claude/Codex session, ephemeral Codex threads). Live bundle 6: the "not verified by probe"
  note for a role model given as a full id (`default=claude:claude-haiku-5-5`) appeared in the preview
  and the run proceeded; stop → resume of a mixed run relaunched the Codex reviewers again (16/16).
  A run-flag `--model` is not checked against the probe list (by design). Preset model ids (`gpt-5.6-luna`, `sonnet`) depend on the account.
- No worker keeps a CLI session by default (D3); sessions the engine requests (experimental
  same-session repair only) are released at task/run end, blocked and interrupted runs keep theirs
  until resolved or pruned (WP12a).
- Still open from the live runs: a domain verdict (`PARTIAL_REVIEW`, `INCONCLUSIVE`, …) fails the run
  (`support_declared_failed`) although the workflow worked; task prompts are not rendered per
  executor (the system prompt maps tool names); Codex environment warnings on machines with allow
  rules or a global `AGENTS.md`. Fixed after the acceptance (WP12a): CLI/`/aw` input overrides
  (`--input`), the legacy-agent shadow notice, control-schema paths in worker prompts, Codex cost
  shown as `0`, the usage roll-up and token semantics, kept sessions, the load flakes of `stop` and
  reconcile. Details:
  [`live-acceptance-stage1.md`](live-acceptance-stage1.md#fixed-after-acceptance-wp12a).
- WP19 (stage-2 review): a failed run is presented as "finished — verdict: X (report ready)" only with
  a declared domain verdict and a report inside the run directory; other support failures are shown
  as failures. The terminal CLI's default executor prefers a verified login (Pi: `pi --list-models`
  lists a model with configured auth) over an unknown one. Host text that carries worker output
  (`logs`, `wait`, `status`, `inspect`, Pi completion messages) redacts structured credentials and
  macOS/Linux/Windows home paths, and `logs` reads only files inside `.agent-workflow/`. Executor
  attempt retention keeps a tombstone for every launched attempt (never reported as not started).

## Live bundle 5 (pre-release features)

[`live-acceptance-features.md`](live-acceptance-features.md), 2026-10-28, 18 workflow runs, cheap
models (Claude `haiku`, Codex `gpt-5.6-luna` low, Pi `openai-codex/gpt-5.6-luna` low). Five product
bugs were found and fixed with regression tests (F1 terminal y/N answers, F2 resume after stop with a
dependency invalidation, F3 Pi probe bound, F4 `/aw auto` task text, F5 Pi loaders and copyToClipboard). The
former "needs live verification" items, by work package:

| WP | Item | Result |
|---|---|---|
| WP28 | MCP `workflow_show`, `workflow_doctor`, `workflow_profile` set/delete with elicitation confirm (Codex) | **verified** |
| WP29 | Dynamic approval: MCP `workflow_status` pending approval + `workflow_approve` elicitation (Claude Code) | **verified** |
| WP29 | CLI TTY `Run dynamic workflow controller? [y/n]`, later `agent-workflow approve` | **verified** after F1 (`y` at the in-run question itself not pressed); live 6: `y` in-run **verified** |
| WP29 | Pi board `a` on a pending approval | **verified** (a run that settles inside the approve call gets no completion message, O10); live 6: `/aw approve` → one completion message **verified** |
| WP31 | Mixed run (claude + codex roles), per-task executors in preview/`status`/`watch`, both probes | **verified** |
| WP31 | Stop/resume of a mixed run, per-executor session cleanup (D3) | **verified** after F2 |
| WP31 | Model note for a role model missing from the probe list | **not verified** (not exercised); live 6: **verified** |
| WP32 | `workflow_auto` on Claude Code (consent + enum choice) | **verified** interactive; `-p` cancels elicitations (no consent possible) |
| WP32 | `workflow_auto` on Codex; two dialogs + classifier within `tool_timeout_sec` 120 | **verified** with `approval_policy="on-request"` (31 s); under `approval_policy="never"` Codex auto-accepts the consent: treated as the user's consent by owner decision (O2, documented); `-c approval_policy="on-request"` asks |
| WP32 | CLI `auto` on a TTY (consent, pick-list, `Auto selection:` in `show`); non-TTY sends nothing | **verified** after F1 |
| WP32/WP38b | Pi `/aw auto`: consent, loader with Escape, select, final confirm | **verified** after F4, F5 |
| WP33 | `aw_run` + `aw_wait`: no duplicate completion message; `parent-usage.json` | **verified** |
| WP33 | Active widget; `/aw wait` loader | widget **verified**; loader fixed (F5) and verified on `/aw auto` (same factory) |
| WP33 | `aw-` skills next to another package's unprefixed `workflow-guide`/`execution-router` | **verified** (loaded with `--skill`; no collision) |
| WP34 | Board: navigation, logs tabs, `v`, `c` (after F5), `s`/`u` on a running run, `q` repaint, narrow width | **verified**; `/aw <run-prefix>` **verified** in live 6; a mixed run's task rows in the board not checked |
| WP34 | Profile picker: Mixed colour table, Edit a role (probed models), Save as new (`ctx.ui.input`), chooser `Custom…` → save preference → one launch | **verified** |
| WP35 | Host tools: preview notice, worker tool list with `codemode`, `tool_search`, `mcp__*`; readOnly stage without them | **verified**; a worker actually calling them **not verified** (system prompt lists only stage tools, O8), **verified** in live 6 (`tool_search`, `list_mcp_resources`); project `.pi/mcp.json` servers do not reach workers (O9) |
| WP35 | `doctor` / probe note for pi-web-access | **verified** after F3 (installed path); missing path **not verified** (no uninstall) |
| WP35 | Fast tier | **not verified** (no API-key `openai/*` provider in the user's Pi) |
| WP36 | L1 Claude Code prompt hook, L2 status line, L5 Codex prompt hook, L6 `codex queue`, `watch`/`statusline`/`notify-check` | **verified** |
| WP36 | L3 plugin monitor push | **verified** once (not shipped); `asyncRewake`, L4 backgrounded wait **not verified** |

## Live bundle 6 (re-verification)

[`live-acceptance-features.md`](live-acceptance-features.md#live-bundle-6-re-verification), 2026-10-29,
9 workflow runs, same cheap models. Re-checks the paths changed by WP39b and the WP42 review fixes.
One product bug fixed (the `prune` dry run listed a run whose worktree it keeps as deleted).

| Item | Result |
|---|---|
| Claude Code prompt hook through `notify-check --stamp` (WP42): line in context, idle prompt starts no CLI, backlog 5 then 1, symlinked `notify-check/` | **verified** |
| `workflow_auto` on Claude Code: consent list = classifier packet, choice launches; `-p` says the client cancelled (O1) | **verified** (packet compared through the Codex record and the answer's ids; the Claude classifier record does not hold the request) |
| `workflow_auto` on Codex (`on-request`): luna output valid with a recommendation (O3), enum options not double-numbered (O4) | **verified** (this luna output needed no normalization) |
| Worktree write stage (CLI): attempt state in the project (O7a), snapshot without `.agent-workflow/` (O7b), `show`/`inspect`/`status` name worktree and branch (O7c), `prune` dry run, `--yes` removes a clean merged worktree and branch, a worktree switched to a user branch is kept | **verified**; dry run fixed (B1) |
| Pi `/aw approve` of a detached run: exactly one completion message (O10) | **verified** |
| CLI `y` at the in-run approval question | **verified** |
| Pi worker calls inherited host tools (O8); readOnly stage gets none | **verified** |
| Role model as full id: "not verified by probe" note, run proceeds | **verified** |
| `/aw <run-prefix>` opens that run's board | **verified** |
| Mixed run stop/resume (F2) | **verified** |

The fast-tier procedure stays as before: a `fast: "on"` stage on an `openai/*` (API-key) or
`openai-codex/*` model with `allowUnverifiedCapabilities: ["fastTier"]`; `<attempt>/pi-fast-tier.json`
reads `status: guarded` with `guardedRequests ≥ 1` and the provider request carries
`service_tier: priority`. Only then `fastTier` may become `probed`.
