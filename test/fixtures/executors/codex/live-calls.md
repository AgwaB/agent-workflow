# WP7 codex live-call log

Budget: at most 25 live model calls. **Used: 18.** Every row reached the model backend except #4,
which reached the API without credentials (no model turn) and is counted to be safe. Probes without
a model turn (`--version`, `login status`, `debug models`, `debug prompt-input`, `mcp list`,
`app-server` `initialize`/`config/read`/`thread/start`/`mcpServerStatus/list`/`mcpServer/tool/call`/
`thread/delete`) are not counted.

- CLI: codex-cli 0.159.2 (ChatGPT login; auth status read only through `codex login status`).
- Model: `gpt-5.6-luna` (cheapest tier on offer: `model/list` has no prices; Luna is the
  "fast and efficient" tier and 5.6 the oldest listed generation), effort `low`, service tier
  standard (`serviceTier: null`), unless noted.
- Common argv for every run: `codex -c log_dir="<TMP>/state/attempts/<digest>.log" app-server`.
  Everything else is JSON-RPC over stdin: `thread/start {cwd, model, approvalPolicy: "on-request",
  approvalsReviewer: "user", sandbox, serviceTier: null, ephemeral, config: {…isolation…}}`, then
  `turn/start {input, model, effort}`. No secret is on argv; env values of injected MCP servers
  travel in the thread config over stdin and are redacted in the raw transcript.
- Working directories: fresh `<TMP>` dirs (`/tmp/aw-live-codex-*`) with one or two small files.
- Cost: never reported by Codex (usage carries tokens only). Tokens are `input/output/cached`
  from `thread/tokenUsage/updated` (input includes cached; output includes reasoning).

| # | Purpose | Request (beyond the common argv) | Model | Duration | Tokens in/out/cached | Cost | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | Smoke: read tool, isolation, usage | readOnly, tools `read, ls`; cwd has `a.txt` and an `AGENTS.md` demanding a marker word | gpt-5.6-luna low | 6961 ms | 22076/110/17664 | not reported | completed `hello from aw`; `cat a.txt` = shell/read; marker absent; fixture `recorded/complete.jsonl` |
| 2 | MCP injection, visible name, output limit | thread config `mcp_servers.workflow_artifact.{command,args,env,…}`; stub server returns 60,008 chars | gpt-5.6-luna low | 9518 ms | 46421/431/31104 | not reported | completed; model called `mcp__workflow_artifact__workflow_artifact`; saw the last line and `Warning: truncated output (original token count: 15002)`; server got its env var; fixture `recorded/parser-mcp-output-limit.jsonl` |
| 3 | Error: invalid model | model `gpt-nope-0` | gpt-nope-0 | 2238 ms | not reported | not reported | failed `config` (400 `model_not_found`, codexErrorInfo `other`); fixture `recorded/fail_config.jsonl` |
| 4 | Error: no login | env `CODEX_HOME=<empty temp dir>` (no credential read or copied) | gpt-5.6-luna low | 16566 ms | not reported | not reported | failed `auth` (401, codexErrorInfo `httpConnectionFailed{401}`, CLI retried first); fixture `recorded/fail_auth.jsonl` |
| 5 | Interrupt | long no-tool answer; `cancel(turn)` after the first delta → `turn/interrupt` | gpt-5.6-luna low | 4024 ms | not reported (interrupted turn sent no usage) | not reported | `cancel` → `cancelled`; failed `cancelled`; fixture `recorded/slow.jsonl` |
| 6 | Web tool (only web call) | tools `web_search` → thread config `web_search = "live"` | gpt-5.6-luna low | 6407 ms | 31010/79/13312 | not reported | completed with the Wikipedia URL; `webSearch` item, action `search`; exposed the U+2028 line-split bug (fixed, unit test); not kept as a fixture (third-party content) |
| 7 | Concurrency 1/3 | 3 runs started together | gpt-5.6-luna low | 3581 ms | 10964/6/0 | not reported | completed |
| 8 | Concurrency 2/3 | | gpt-5.6-luna low | 4743 ms | 10966/6/9344 | not reported | completed |
| 9 | Concurrency 3/3 | | gpt-5.6-luna low | 3851 ms | 10968/6/6912 | not reported | completed; wall 5173 ms for all three; no auth/refresh/lock text in any stderr |
| 10 | Live test smoke (`executor-codex-live.test.mjs`) | readOnly, tools `read` | gpt-5.6-luna low | 6217 ms | 22041/87/17664 | not reported | pass |
| 11 | Kit `live.readonly_enforced` | readOnly, tools `read, write, edit, bash`, "create a file" | gpt-5.6-luna low | 3935 ms | 11036/54/9344 | not reported | pass: no file; model reported the read-only workspace |
| 12 | Kit `live.tool_allowlist` | readOnly false, tools `read` (→ read-only sandbox), "run touch" | gpt-5.6-luna low | 7646 ms | 22290/251/20224 | not reported | pass: `touch` asked for escalation → `approval_request` (execute) → engine policy deny → tool `denied`; fixture `recorded/approval.jsonl` (decline branch) |
| 13 | Kit `live.isolation` | AGENTS.md + CLAUDE.md in cwd with a marker word | gpt-5.6-luna low | 3454 ms | 11017/5/6912 | not reported | pass |
| 14 | Kit `live.session_ownership` | `sessionId` set → non-ephemeral thread | gpt-5.6-luna low | 3230 ms | 11017/5/6912 | not reported | pass: `ownedSession {kind: codex-thread, locator: <thread id>}`; thread deleted afterwards (`thread/delete`) |
| 15 | Kit `live.resume` turn 1 | `sessionId` set, "remember the codeword" | gpt-5.6-luna low | 6993 ms (both turns) | 11019/5/9344 | not reported | pass |
| 16 | Kit `live.resume` turn 2 | `resumeSessionId` → `thread/resume` | gpt-5.6-luna low | (with #15) | 22244/28/20224 as first reported; 11225 input after the per-turn usage fix | not reported | pass: recalled the codeword; exposed the replayed-usage double count (fixed, unit test); fixture `recorded/parser-resume.jsonl`; both threads deleted afterwards |
| 17 | System prompt | `systemPrompt` → `developerInstructions` "answer in UPPERCASE" | gpt-5.6-luna low | 2814 ms | 10980/5/0 | not reported | completed `DONE`; fixture `recorded/parser-system-prompt.jsonl` |
| 18 | Write mapping | readOnly false, tools `read, edit, write` → workspace-write (disposable temp dir) | gpt-5.6-luna low | 5305 ms | 22616/179/11008 | not reported | completed; `apply_patch` created `out.txt` without an approval; fixture `recorded/parser-write.jsonl` |

## Totals

- Live calls: **18 of 25** (16 model turns completed or failed in-model, #3 rejected by the backend
  before a turn, #4 rejected for missing credentials).
- Tokens as reported by the usage events: **276,665 input** (179,968 cached) and **1,257 output**.
  #16 includes 11,019 input tokens of #15 that the pre-fix accounting double counted; corrected
  total 265,646 input.
- Cost: **not reported** by Codex for any call (ChatGPT plan; `cost: null`, `source: "unknown"`).
- Models: `gpt-5.6-luna` (17 calls), `gpt-nope-0` (1 deliberate invalid model).
- Web: 1 call (#6).

## WP4e — permission mode `free` (1 call)

Date 2026-10-26, codex-cli 0.159.2, same login. Purpose: prove that the free-mode `thread/start` params
are accepted by the real app-server (D2 revised). Key names and values were first checked against
`codex app-server generate-json-schema` (`ThreadStartParams.approvalPolicy: AskForApproval =
"untrusted" | "on-request" | "never" | {granular}`, `ThreadStartParams.sandbox: SandboxMode = "read-only" |
"workspace-write" | "danger-full-access"`). Driver: a throwaway script calling `createExecutor().submit()`
(not tracked), cwd a fresh `/tmp/aw-live-wp4e-codex-*` with one file `NOTES.md`. Request:
`permissionMode: "free"`, `readOnly: false`, tools `read, bash`, isolation on.

Exact params (raw transcript): argv `codex -c log_dir="<state>/attempts/<digest>.log" app-server`;
`thread/start {cwd, model: "gpt-5.6-luna", approvalPolicy: "never", approvalsReviewer: "user", sandbox:
"danger-full-access", serviceTier: null, ephemeral: true, config: {…isolation, web_search: "disabled",
tool_output_token_limit…}}`; `turn/start {threadId, input, model: "gpt-5.6-luna", effort: "low"}`. The
`thread/start` result echoed `approvalPolicy: "never"`, `sandbox: {type: "dangerFullAccess"}`.

| # | Purpose | Model | Duration | Tokens in/out/cached | Cost | Outcome |
|---|---|---|---|---|---|---|
| 19 | Free mode accepted (non-readOnly, no write) | gpt-5.6-luna low | 8420 ms (wall) | 17201/91/15232 | not reported | completed `WP4E-LIVE-MARKER first line`; `head -n 1 NOTES.md` ran as a shell read; no approval request; no file created |

Totals now 19 live calls (WP7: 18, WP4e: 1). The temp dirs were removed.
