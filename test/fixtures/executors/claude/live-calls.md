# WP8 live calls — Claude Code executor

CLI: `claude` 2.1.310 (claude.ai subscription login, `claude auth status` → `loggedIn: true`,
`authMethod: claude.ai`; account fields never recorded). Date: 2026-10-26. Budget: 25 model calls.

**Model:** cheapest offered by the CLI. The model list came from the stream-json `initialize`
control request, which needs no model turn: `default, opus, fable, sonnet, haiku,
claude-haiku-4-5-20251001, claude-sonnet-5, claude-opus-5, claude-fable-5, claude-opus-4-8,
claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6`. The `haiku` alias resolved to
`claude-haiku-5-5` (`system/init.model`). Effort was `low` for every call.

**Counting.** Every CLI invocation that sent a prompt counts, including #6 and #7, which were refused
before any model turn ran. These did not count: probes (`--version`, `auth status`, `initialize`/`mcp_status`
control requests with no user message; 7 invocations, all without a model turn).

**Cost** is `total_cost_usd` as the CLI reported it. On a subscription this is a notional
list-price figure (`modelUsage.*.costBasis: "list"`), not a charge. Tokens: input = `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`, output = `output_tokens`.

Common argv for #1–#9 (raw driver `drive.mjs`): `claude -p --input-format stream-json --output-format
stream-json --verbose --model haiku --effort low --setting-sources "" --strict-mcp-config
--disable-slash-commands --permission-mode default --no-session-persistence`. #2 onwards also add
`--settings {"autoMemoryEnabled":false}`; #3 onwards also add `--permission-prompt-tool stdio`.
The prompt went to stdin as a stream-json `user` message. The "extra" column lists the per-call
additions; the full argv is in `transcripts/<fixture>.meta.json`. #10–#22 ran through the adapter
(`createClaudeExecutor`); their exact argv is in `transcripts/adapter-*.meta.json` and in the
`claude-invocation.json` of each run. Temp dirs: `/tmp/aw-live-claude-e*`, `/tmp/aw-live-claude-run-*`.
Deviation: the kit runs (#15–#20) used cwds under the macOS per-user temp dir, because `runConformance` ignores a
`workDir` option. The live test now sets `TMPDIR` for the kit.

| # | Purpose | Extra argv / request | Model | Duration | Tokens in / out | Cost (reported) | Outcome | Fixture |
|---|---|---|---|---|---|---|---|---|
| 1 | Isolation combo A + tools + MCP echo + Bash `ls` + CLAUDE.md/AGENTS.md canary | `--include-partial-messages --include-hook-events --mcp-config <RUN>/mcp.json --tools Read,Grep,Glob,Bash --allowedTools Read,Grep,Glob,mcp__workflow_artifact__echo` | claude-haiku-5-5 | 7.7 s | 16168 / 252 | $0.00185706 | completed. Canary not followed, no hook events, only builtin plugins, `permissionMode: default`. Bash `ls` ran without a prompt (read-only command) | complete-tools-mcp |
| 2 | Approval without `--permission-prompt-tool` | `--settings {"autoMemoryEnabled":false} --tools Read,Bash --allowedTools Read` | claude-haiku-5-5 | 4.1 s | 10855 / 147 | $0.00067337 | `touch` denied by the CLI (`system/permission_denied`), no host request. `memory_paths` gone | permission-denied-no-prompt-tool |
| 3 | Approval channel allow + deny | + `--permission-prompt-tool stdio` | claude-haiku-5-5 | 8.4 s | 16377 / 223 | $0.00048785 | 2 `can_use_tool` requests. Allow → file created, deny → `is_error` tool result | approval-allow-deny |
| 4 | Interrupt (cancel turn) | `--include-partial-messages --tools ""`. `interrupt` control request at 4 s | claude-haiku-5-5 | 5.2 s | 0 / 0 (CLI reports 0; real usage unknown) | $0 (reported; untrustworthy) | `result error_during_execution`, `terminal_reason: aborted_streaming`, exit 1 | interrupt |
| 5 | SIGTERM mid-run | `--tools ""`. SIGTERM at 4.5 s | claude-haiku-5-5 | 5.7 s | 2691 / 1201 | $0.00069105 | turn finished before the signal (result success), then exit 143 | sigterm-after-result |
| 6 | Invalid model error | `--model claude-nonexistent-model-0 --tools ""` | (none ran) | 2.4 s | 0 / 0 | $0 | `is_error`, `api_error_status: 404`, stderr `[claude-code:unrecognized_model]`, exit 1 | invalid-model |
| 7 | `--bare` with OAuth only (auth error) | `--bare` (no setting/slash flags) | (none ran) | 1.3 s | 0 / 0 | $0 | "Not logged in · Please run /login", exit 1. User plugins/skills still loaded | bare-not-logged-in |
| 8 | MCP limit with `MAX_MCP_OUTPUT_TOKENS=2000`, `MCP_TOOL_TIMEOUT=3000` | `--mcp-config <RUN>/mcp.json --tools "" --allowedTools mcp__workflow_artifact__big,mcp__workflow_artifact__slow` | claude-haiku-5-5 | 11.2 s | 19969 / 537 | $0.00158611 | 3000 chars inline. 12000 chars spilled to a file notice. Slow tool: "timed out after 3s" | mcp-limit-2000-tokens |
| 9 | MCP limit at default (25k tokens) | `--mcp-config … --allowedTools mcp__workflow_artifact__big` | claude-haiku-5-5 | 8.6 s | 84774 / 626 | $0.00714893 | 22,500 and 45,000 chars inline. 90,000 spilled | mcp-limit-default |
| 10 | Adapter smoke + real artifact MCP server (+ probe with model list) | tools `read, workflow_artifact`, readOnly | claude-haiku-5-5 | 2.0 s | 9231 / 117 | $0.00104588 | completed. `mcp__workflow_artifact__workflow_artifact` completed, 1 ledger row | adapter-smoke-artifact-mcp |
| 11 | Concurrency alpha (parallel) | tools `[]` | claude-haiku-5-5 | 0.8 s | 2701 / 5 | $0.00013153 | completed "alpha" | adapter-concurrency-alpha |
| 12 | Concurrency beta (parallel) | tools `[]` | claude-haiku-5-5 | 0.8 s | 2698 / 4 | $0.00013043 | completed "beta" | — |
| 13 | Concurrency gamma (parallel) | tools `[]` | claude-haiku-5-5 | 0.8 s | 2699 / 5 | $0.00013113 | completed "gamma". Wall 3.5 s for all 3 | — |
| 14 | Web: WebSearch + WebFetch (the one web call) | tools `web_search, fetch_content`, readOnly | claude-haiku-5-5 | 6.4 s | 9410 / 341 | $0.01285157 | both tools completed | adapter-web-search-fetch |
| 15 | Kit `live.readonly_enforced` | tools `read,write,edit,bash`, readOnly | claude-haiku-5-5 | 2.7 s | 3847 / 406 | $0.0006549 | pass (file not created) | adapter-kit-readonly |
| 16 | Kit `live.tool_allowlist` | tools `read`, readOnly false | claude-haiku-5-5 | 2.1 s | 3844 / 261 | $0.00029414 | pass (marker not created) | — |
| 17 | Kit `live.isolation` | CLAUDE.md + AGENTS.md canary in cwd | claude-haiku-5-5 | 1.3 s | 2726 / 3 | $0.00013553 | pass | adapter-kit-isolation |
| 18 | Kit `live.session_ownership` | `sessionId` (kept) | claude-haiku-5-5 | 1.2 s | 2726 / 3 | $0.00010095 | pass (`ownedSession`) | adapter-kit-session-keep |
| 19 | Kit `live.resume` turn 1 | `sessionId` (kept) | claude-haiku-5-5 | 0.9 s | 2736 / 4 | $0.00013803 | pass | — |
| 20 | Kit `live.resume` turn 2 | `resumeSessionId` | claude-haiku-5-5 | 1.0 s | 2780 / 10 | $0.00025081 | pass (codeword recalled) | adapter-kit-resume |
| 21 | System prompt, append | `--append-system-prompt` | claude-haiku-5-5 | 1.0 s | 2734 / 11 | $0.00042708 | "KIWIAPPEND" | — |
| 22 | System prompt, replace | `--system-prompt` (config `systemPromptMode: replace`) | claude-haiku-5-5 | 1.0 s | 592 / 11 | $0.0001237 | "KIWIREPLACE" (input 592 vs 2734 tokens) | — |

Durations are wall time for #1–#9 (driver) and the CLI's `duration_ms` for #10–#22.

**Totals:** 22 of 25 calls. 19 reached a model (#6 and #7 were refused before a model turn), all on
`claude-haiku-5-5`. 199,558 input tokens (mostly cache reads) and 4,167 output tokens. Reported cost
$0.0289 (notional, subscription). #4 reports 0 usage although tokens were spent, so its usage is
unknown. 3 calls are unused.

**Cleanup:** the kit's two kept sessions were deleted through `deleteOwnedSession`
(`deleted`, `deleted`, plus `absent` for the resume attempt's duplicate record). Raw experiments
number 1, 8 and 9 left `~/.claude/projects/-private-tmp-aw-live-claude-{e1,e8a,e8b}-cwd/`: an empty `memory/` dir
from #1 and spilled `tool-results/` from #8 and #9. These were removed by hand. Adapter runs leave
nothing there: no persistence, auto-memory off, and the spill dir is removed after exit.

## WP4e — permission mode `free` (1 call)

Date 2026-10-26, `claude` 2.1.310, same login. Purpose: prove that the free-mode flag is accepted by the
real CLI (D2 revised). Driver: a throwaway script calling `createExecutor().submit()` (not tracked), cwd
a fresh `/tmp/aw-live-wp4e-claude-*` with one file `NOTES.md`. Request: `permissionMode: "free"`,
`readOnly: false`, tools `read, bash`, model `haiku`, effort `low`, isolation on. Prompt: print the first
line of NOTES.md with a shell command, change nothing.

Exact argv (`claude-invocation.json`): `claude -p --input-format stream-json --output-format stream-json
--verbose --include-partial-messages --permission-mode bypassPermissions --permission-prompt-tool stdio
--tools Read,Bash --setting-sources "" --settings {"autoMemoryEnabled":false} --strict-mcp-config
--disable-slash-commands --model haiku --effort low --session-id <uuid> --no-session-persistence`.
`--permission-mode bypassPermissions` is the documented `--permission-mode` choice in `claude --help`
2.1.310; the `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions` aliases were not used.

| # | Purpose | Model | Duration | Tokens in / out | Cost (reported) | Outcome |
|---|---|---|---|---|---|---|
| 23 | Free mode accepted (non-readOnly, no write) | claude-haiku-5-5 | 8.4 s (CLI) | 10768 (8270 cached) / 107 | $0.0006354 | completed `WP4E-LIVE-MARKER first line`. `system/init.permissionMode: bypassPermissions`. Bash `head -n 1 NOTES.md` ran, no `can_use_tool` request, no file created |

Totals now 23 calls (WP8: 22, WP4e: 1). Nothing was left under `~/.claude/projects`; the temp dir was removed.

## Re-verification on 2.1.314 (2026-11-01)

`agent-workflow doctor` reported `installed 2.1.314 (verified 2.1.310, differs)`. Same login,
`AGENT_WORKFLOW_LIVE=1 node --test test/unit/executor-claude-live.test.mjs` (real HOME), model alias
`haiku` (resolved to `claude-haiku-5-5`).

| # | Purpose | Calls | Outcome |
|---|---|---|---|
| 24 | Smoke: read-only run with the real artifact MCP server | 1 | pass (5.1 s) |
| 25–27 | Concurrency: three parallel `claude -p` runs | 3 | pass (2.5 s) |
| 28 | Native WebSearch + WebFetch | 1 | pass (8.0 s) |
| 29–30 | System prompt append and replace | 2 | pass (5.0 s) |
| 31–36 | Kit live tier (resume = 2 calls) | 6 | pass (14.3 s) |

13 calls, reported cost $0.0174 in total (sum of `total_cost_usd`). Nothing was left under
`~/.claude/projects`. `CLAUDE_VERIFIED_CLI_VERSION` is now 2.1.314. Earlier the same day three
Sonnet 5.5 deep-research runs completed on 2.1.314. Totals now 36 calls.

## Re-verification on 2.1.318 (2026-11-04)

`agent-workflow doctor` reported `installed 2.1.318 (verified 2.1.314, differs)`. Same login,
`AGENT_WORKFLOW_LIVE=1 node --test test/unit/executor-claude-live.test.mjs` (real HOME), model alias
`haiku`.

| # | Purpose | Calls | Outcome |
|---|---|---|---|
| 37 | Smoke: read-only run with the real artifact MCP server | 1 | pass (6.6 s) |
| 38–40 | Concurrency: three parallel `claude -p` runs | 3 | pass (3.4 s) |
| 41 | Native WebSearch + WebFetch | 1 | pass (12.9 s) |
| 42–43 | System prompt append and replace | 2 | pass (7.2 s) |
| 44–49 | Kit live tier (resume = 2 calls) | 6 | pass (20.6 s) |

`CLAUDE_VERIFIED_CLI_VERSION` is now 2.1.318. The same day 2.1.318 also ran the live run of every
bundled workflow (spec-review, impact-review, deep-review; haiku). Totals now 49 calls.
