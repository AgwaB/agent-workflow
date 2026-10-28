# Support matrix (stages 1 and 2)

What runs where, verified how. Executors (stage 1) come from two sources below; hosts (stage 2)
from [live bundle 4](live-acceptance-stage2.md), see [Hosts](#hosts-stage-2).

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

All on macOS. SDK contract 0.1.0. `probe()` adds a note when the installed CLI version differs from
the verified one; rerun the conformance kit then ([`conformance.md`](conformance.md)).

## Live matrix (default `free` mode)

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

## Hosts (stage 2)

The agent that the user talks to. Workers run on the executor the run selects (explicit choice,
workflow profile, else the host's own CLI: `host-default`). Live bundle 4, 2026-10-27,
[`live-acceptance-stage2.md`](live-acceptance-stage2.md); the Codex host in live bundle 4b, 2026-10-28.

| Host | Verified CLI | Path | Tool names the model sees | Default executor | Live result | Notes |
|---|---|---|---|---|---|---|
| **Claude Code** | 2.1.310 | plugin (`--plugin-dir` dev copy; marketplace install verified offline, [plugins.md](plugins.md)); alternative `claude mcp add` | `mcp__plugin_agent-workflow_agent-workflow__workflow_{list,run,dynamic,status,wait,stop,inspect,validate}` (observed: `…workflow_run`, `…workflow_wait`, `…workflow_inspect`) | `claude`, `host-default` (observed) | completed: claude workers (`NEEDS_WORK`), codex workers (`PARTIAL_REVIEW`, finished detached after the host stopped waiting) | The model receives `structuredContent` serialized as JSON, not `content`. Tool schemas are deferred: the first call is `ToolSearch select:…`. `claude -p --permission-mode default --allowedTools <the 8 tools>` had no denials. The plugin's three skills are listed. Elicitation not exercised. |
| **Codex** | 0.159.2 | plugin (`codex plugin marketplace add` + `plugin add`, temporary, in the real `CODEX_HOME`; host turn `codex exec`); alternative `codex mcp add` | code mode: the model calls `exec` (JavaScript cell) and inside it `tools.mcp__agent_workflow__workflow_{run,wait,inspect}` (observed; all 8 listed via `ALL_TOOLS`); the `--json` stream shows server `agent-workflow`, tool `workflow_*` | `codex`, `host-default` (observed) | completed (live 4b): codex workers and claude workers, both `PARTIAL_REVIEW` (run `failed` by `support_declared_failed`; the host saw no preview or report path) | The model printed the whole `CallToolResult`, so it saw `content` and `structuredContent`. `workflow_wait` (45 s) outlasts the 30 s code-mode yield; the model resumed with `wait`. Skills `agent-workflow:{agent-workflow,execution-router,workflow-guide}` listed; server runs in the thread cwd with `--host codex`. A new directory gets a `trust_level = "trusted"` entry in the user config unless trusted inline (`-c projects={…}`). |
| **Pi** | 1.1.0 | extension (`pi -e <package>/dist/hosts/pi/index.js`, or `pi install`) | `/aw …` command; agent tools `aw_list`, `aw_run`, `aw_dynamic`, `aw_wait` | `pi`, `host-default` (observed) | completed: `/aw run` in RPC mode, no model turn (`NEEDS_WORK`) | Footer status `aw: <name> <done>/<total> running`, exactly one `agent-workflow-completion` message, `/aw logs` and `/aw status`. The message's "Verdict:" line is the run status, the report verdict is in the preview. |

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
- deep-research needs the `pi-web-access` extension (refused otherwise).
- Cost is Pi's catalog estimate (`source: estimated`), also on a subscription. (Fixed in WP12a: usage
  now carries cache-write tokens and the serving model, so Pi tasks record their model.)
- Fast tier unverified.

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
- Offline-verified only (fixture executors registered as `claude` and `codex`); live mixed runs are
  part of acceptance bundle 5. Preset model ids (`gpt-5.6-luna`, `sonnet`) depend on the account.
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
