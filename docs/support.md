# Support matrix (stage 1)

What runs where, verified how. Two sources:

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
