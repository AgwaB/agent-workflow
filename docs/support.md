# Support matrix

Hosts call the shared host API; workers run on the executor selected for each stage. An explicit
run choice takes precedence over profiles and host defaults. See the generated
[bundled workflow support table](bundled-workflows.md#support-table) for capability negotiation in
`free` and `safe` modes.

## Verified CLI versions

| Executor | Adapter | Verified CLI | Documentation |
|---|---|---|---|
| `pi` | 0.1.0 | Pi 1.1.0 (minimum 1.1.0 for native MCP) | [Pi](executors/pi.md) |
| `codex` | 0.1.0 | codex-cli 0.166.0 | [Codex](executors/codex.md) |
| `claude` | 0.1.0 | claude-code 2.1.318 | [Claude](executors/claude.md) |
| `antigravity` (experimental) | ACP adapter | `agy_acp_server` 1.4.5 | [ACP](executors/acp.md) |

These versions were checked on macOS. SDK contract: `0.1.0`. `probe()` notes a CLI version that
differs from the verified version; run the [conformance kit](conformance.md) before relying on it.
Authentication is the CLI's own login.

## Hosts

| Host | Integration | Default executor | Worker executors |
|---|---|---|---|
| Pi 1.1.0 | [Extension](pi-host.md), `/aw` commands and `aw_*` tools | `pi` | pi, codex, claude; experimental antigravity |
| Claude Code 2.1.318 | [Plugin](plugins.md) or [host MCP server](host-mcp.md) | `claude` | pi, codex, claude; experimental antigravity; mixed roles |
| Codex 0.166.0 | [Plugin](plugins.md) or [host MCP server](host-mcp.md) | `codex` | pi, codex, claude; experimental antigravity; mixed roles |
| Terminal CLI | `agent-workflow` | First installed and logged-in of pi → claude → codex | Any registered executor |

MCP hosts use `workflow_*` tools. Pi uses `aw_*` tools and `/aw` commands. All worker executors must
be installed and logged in before launch; mixed runs probe each executor once.

| Host | Progress and completion | Limits |
|---|---|---|
| Pi | Footer, run board, one completion message | RPC, print and JSON modes use text commands instead of the board |
| Claude Code | `workflow_wait` / `workflow_status`, optional status line and prompt hook, terminal `agent-workflow watch` | Print mode (`-p`) cancels elicitation, so actions requiring a dialog cannot obtain consent there |
| Codex | `workflow_wait` / `workflow_status`, interactive-session completion wake, optional prompt hook, terminal `agent-workflow watch --bell` | `approval_policy="never"` auto-accepts empty confirmation forms and cancels enum forms; use `on-request` to be asked |

Interactive Codex runs linked through MCP wake the host with `codex queue` once on settlement;
`codex exec` uses polling instead. `AGENT_WORKFLOW_HOST_WAKE=0` disables wake delivery. A result
already received through `workflow_wait` is not delivered again.

## Offline matrix

Summary for a clean environment; the [full table](bundled-workflows.md#support-table) includes both
permission modes and both deep-research specs.

| Executor | deep-review, spec-review, impact-review | deep-research |
|---|---|---|
| pi | accept | Requires `pi-web-access`; with it, degrade `webTools.safetyPolicy:unknown`; without it, refuse `CAPABILITY_MISSING:webTools` |
| codex | Degrade `toolAllowlist.fine` and `usage.cost`; `safe` also records `forcedReadOnly` | Same, plus `webTools.safetyPolicy:unknown` |
| claude | accept | Degrade `webTools.safetyPolicy:unknown` |

A domain verdict such as `NEEDS_WORK`, `GAPS_FOUND` or `BLOCKED` describes the reviewed target, not
an executor failure. A final verdict gate may still mark the run `failed`; hosts present a declared
verdict with an existing in-run report as “finished — verdict: X (report ready)”.

## Known limits per executor

Full adapter limits: [Pi](executors/pi.md#known-limits), [Codex](executors/codex.md#known-limits),
[Claude](executors/claude.md#known-limits), [ACP](executors/acp.md).

| Executor | Limits |
|---|---|
| Pi | No approvals or sandbox: both modes use the same argv; readOnly removes mutating tools. `sessionBound`: cannot re-attach after the owning process dies. Deep-research needs `pi install npm:pi-web-access`. Cost is a catalog estimate, including on subscriptions. Fast tier remains unverified and requires `allowUnverifiedCapabilities: ["fastTier"]`; guard failure is `config`, degradation is `payload-only`, recorded in `pi-fast-tier.json`. |
| Codex | Only a coarse tool allowlist. `free` records precise-list degradation; `safe` forces readOnly if the spec permits, otherwise refuses. Global `$CODEX_HOME/AGENTS.md` and rules cannot be disabled per run; the probe warns about weakened isolation/readOnly. Tokens only: cost is `null`, never `0`. Hosted `web_search` has no separate fetch. `fetch_content`, `grep`, `find`, `ls` mappings and token-refresh contention are unverified. Adapter attempt records and logs are not pruned. |
| Claude | `sessionBound`: lost stdio requires a reconcile decision. The CLI auto-allows reads inside cwd and read-only Bash commands. The full environment is inherited; `ANTHROPIC_API_KEY` selects API-key billing. Cost is `total_cost_usd`, notional on subscriptions. The runtime, not the adapter, enforces timeouts. |
| Antigravity | Experimental; capabilities remain `declared`. Workspace `AGENTS.md` / `GEMINI.md` are not isolated. No session ownership or resume. |

## Shared limits

- CLI web tools have no engine-enforced URL, private-network or redaction policy;
  `webTools.safetyPolicy` is recorded as `unknown`. Deep-research's separate quote check does not
  turn the CLI web tools into an engine-controlled browsing channel.
- Usage is normalized: input excluding cache reads/writes, cache read, cache write, output including
  reasoning, total and serving model. Unknown cost stays `null`.
- Workers keep no CLI session by default. Experimental same-session repair requests kept sessions;
  completed/skipped tasks and terminal runs release them. Blocked and interrupted runs retain them
  until resolved or pruned.
- Non-readOnly Pi workers may inherit native host codemode/MCP tools from a trusted Pi host;
  readOnly workers never do. Project `.pi/mcp.json` servers do not reach workers. Other executors'
  user-MCP inheritance is a separate opt-in.
- Mixed runs negotiate each stage against its own executor. Dynamic-stage workers stay on that
  stage's executor; nested runs keep their parent's executor. Role models absent from a partial
  probe list are noted; absent from a complete list they are refused. A run-level `--model` is not
  checked against that list. Model availability depends on the account.
- Host text carrying worker output redacts structured credentials and home paths. Log reads are
  restricted to the project's `.agent-workflow/` artifact root.
