# Local web dashboard

`agent-workflow dashboard` serves a localhost-only view of one project's runs: progress, stages, agent activity, logs, results and items needing attention. Stop, Resume, Approve and Reject use the shared [host API](host-api.md). The dashboard takes no run lease and makes no model calls itself; resuming or approving can continue model work.

## Command

```sh
agent-workflow dashboard [--port <n>] [--readonly] [--auth] [--open] [--project <dir>]
agent-workflow dashboard --status [--project <dir>]
agent-workflow dashboard --stop [--project <dir>]
agent-workflow dashboard --reset-session [--project <dir>]
```

- Binds **127.0.0.1 only**, never `0.0.0.0` or IPv6-any. Reuses the project's last port when free, otherwise chooses an ephemeral port. Explicit `--port` is strict.
- `--project` defaults to cwd. One server serves one project's `.agent-workflow/`.
- Foreground mode prints the URL and runs until SIGINT/SIGTERM (exit 0). Usage errors, including unavailable/invalid ports or a non-directory project, exit 2.
- `--open` opens the browser. Default URLs need no sign-in; with `--auth`, the printed foreground URL includes a session token.
- `--readonly` disables controls and rejects every mutation with 403.
- `--status` reports discovery state, pid, port, start time, auth mode and detached idle-exit timing. `--stop` sends SIGTERM and waits for discovery removal.
- `--detached` runs in the background without printing a session URL. Detached servers exit after 2 h with no SSE client and no live running/blocked run; foreground servers never idle out.

## What it shows

The sidebar lists runs with task previews, timing, progress and reports. **Needs you** collects approvals, executor decisions and failed/blocked runs. Failures can be dismissed in this browser; approvals and decisions cannot. A stopped run offers Resume rather than appearing as a new need.

The run view separates process status from the workflow's verdict: a workflow may finish its work and still report “Needs work”. The graph shows stages, dependencies and agent progress. Code steps are hidden by default; Show/Hide remembers your choice. Failed, running, attention-required or selected code steps remain visible. Fit, Focus and direction controls help navigate larger graphs.

Select a stage or agent to see activity, results, output, stderr or events. Finished agents expand in place; **Open agent** shows full detail and log tabs. Run details show the task, redacted launch command, permission mode, host and usage. Unreported cost is `null`/“Not collected”, not zero.

Reports and task results render text-only Markdown, with no active links, images or HTML. Code highlighting loads locally when available and falls back to plain text. The report's Light/Dark page choice is independent of the dashboard's Auto/Light/Dark theme. Theme, sidebar and display choices are stored in this browser.

Stop explains its impact and records a durable request for the supervisor. Resume does not relaunch completed tasks. Approval dialogs show the controller question and scope; rejecting leaves the run blocked.

`Live`, `Reconnecting` and `Stale (updated …)` describe the connection, not run status. Stale appears after 30 s without a heartbeat. Reduced-motion preferences disable animations. Keyboard controls include ↑/↓ navigation, Enter, Escape, `⌘K` search, and `j`/`k` between agents. Clicking empty canvas closes the inspector; dragging pans instead.

Deep-link state includes `run`, `stage`, `task`, `tab=result|output|stderr|events`, `view=report|details`, and `dialog=stop|resume|approve|reject`.

## Security model

**Default: no sign-in.** Any local OS user or process able to reach the port can view runs and use Stop/Resume/Approve/Reject. Use `--auth` on shared machines and `--readonly` when mutations are unwanted. Loopback binding does not isolate users on the same machine.

| Threat | Control |
|---|---|
| Local access (`--auth`) | 256-bit random per-project session token; required except for bootstrap/sign-in routes |
| Token exposure (`--auth`) | `?token=…` sets `HttpOnly; SameSite=Strict; Path=/` cookie, then 302 redirects to a token-free URL; `Referrer-Policy: no-referrer` |
| DNS rebinding / foreign pages | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 421); no CORS headers |
| CSRF | Mutations require POST, JSON content type, matching `Origin` and `X-AW-CSRF` from same-origin `GET /api/session`. Default mode requires `Sec-Fetch-Site: same-origin`; otherwise, when present, it must be `same-origin` or `none`. With auth, CSRF is tied to the token by HMAC. |
| Untrusted output | Text DOM nodes, no `innerHTML`; reports cannot execute HTML or load content resources |
| Browser execution | CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`; no inline scripts/styles or external resources |
| Response leakage | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, no-referrer |
| Secrets and paths | Host API containment/redaction; result files contained to the project's artifact root and redacted |
| Unbounded reads | Logs ≤400 lines / ≤48 kB per call; report ≤256 kB with truncation notice; task result files ≤1 MiB each, analysis ≤60,000 characters, control ≤40,000 characters, references ≤100 |
| Read-only mutation | Server-side 403 `{ "error": "read-only" }`; UI controls also disabled |

The UI receives a projection, not raw run records. Task activity labels describe tool intent, never tool output; URLs omit query/fragment, paths are relative or reduced to basenames, and secret-like values are redacted.

## Authentication

Enable with `--auth` or `AGENT_WORKFLOW_DASHBOARD_AUTH=1` (also applies to auto-started servers).

The session token is stored in `<project>/.agent-workflow/dashboard-session` (0600, 32 random bytes base64url) and reused across restarts, so signed-in browser cookies remain valid. `--reset-session` stops a running dashboard and rotates the token, requiring browsers to sign in again.

Unauthenticated UI requests receive a 401 sign-in page (`/app.css` remains public). **Sign in on this computer** calls `POST /api/signin-local`; matching Origin and `Sec-Fetch-Site: same-origin` are required, with one call per 3 s. The server opens a one-time URL through the OS browser opener; it never returns that URL to the page. Alternatively, use `agent-workflow dashboard --open` or ask the host to open it.

One-time auth launch tokens contain 32 random bytes, expire after 60 s and are single-use. The persistent session token remains available for manual sign-in.

## Launch integration

`run`, `dynamic` and launched `auto` operations auto-start a detached dashboard if needed and print a token-free link:

```text
Dashboard: http://127.0.0.1:<port>/?run=<id>
```

Launch data includes `dashboard: {url, port, started?: true, auth?: true}`. Startup waits at most 3 s. Dashboard failure never fails the workflow launch; the fallback is `Dashboard: not running · agent-workflow dashboard --open`.

When `wait` returns a settled or blocked run, it supplies the dashboard link again. Finished runs with reports use `&view=report`.

Auto-start never opens a browser. Opening is opt-in through CLI `--open`, `AGENT_WORKFLOW_DASHBOARD_OPEN=1`, Pi `/aw dashboard`, or MCP `workflow_dashboard`. Environment-requested opening is suppressed when `CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT` or `AI_AGENT` is set, or the host is Pi/Codex/Claude Code. Explicit `--open` overrides suppression. Openers honor `BROWSER`/`BROWSER_ARGS`.

Set `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0` to disable auto-start. It is also disabled for worker roles and read-only contexts. Browser-opening host behavior is documented in [host-mcp.md](host-mcp.md#dashboard-opening) and [pi-host.md](pi-host.md#aw-dashboard).

The last port is stored in `<project>/.agent-workflow/dashboard-port`. Reusing it keeps older links usable after restarts when the port is available; with auth, persistent cookies also survive restarts.

## Environment variables

| Variable | Meaning |
|---|---|
| `AGENT_WORKFLOW_DASHBOARD_AUTH=1` | Require sign-in, including auto-started servers |
| `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0` | Disable automatic dashboard startup |
| `AGENT_WORKFLOW_DASHBOARD_OPEN=1` | Open after launch, subject to agent suppression |
| `AGENT_WORKFLOW_DASHBOARD_IDLE_MS` | Detached idle timeout; default 2 h, minimum 1 min |
| `AGENT_WORKFLOW_DASHBOARD_POLL_MS` | SSE poll interval; default 1000 ms, range 500–10000 ms |
| `BROWSER`, `BROWSER_ARGS` | Browser opener command and arguments |

## HTTP API

JSON responses use `Content-Type: application/json; charset=utf-8`. Errors are `{ "error": string }` with 400/401/403/404/409/421/500 as appropriate. Auth mode requires a session except on bootstrap/sign-in routes; mutations require the controls above. Run ids must match `^workflow_[A-Za-z0-9_-]+$`; prefixes are not accepted over HTTP.

| Method & path | Result |
|---|---|
| `GET /?launch=…` | Mark launch consumed; 302 to `/`, forwarding valid `run`, `task`, `tab`, `view`; unknown ids ignored and stray tokens dropped in default mode |
| `GET /?token=…` (`--auth`) | Set cookie and redirect, forwarding valid UI parameters without token |
| `GET /`, `/app.js`, `/app.css` | UI assets |
| `GET /api/session` | `{apiVersion: 1, project: {path, name}, mode: "read-write" \| "read-only", auth, csrf, serverTime, version}` |
| `GET /api/runs` | `{serverTime, runs}`; top-level run summaries, newest first |
| `GET /api/runs/:runId` | Full dashboard projection |
| `GET /api/runs/:runId/tasks/:taskId/logs?stream=output\|stderr\|events\|all&lines=1..400` | Host API task log data, including truncation/refusal information |
| `GET /api/runs/:runId/tasks/:taskId/result` | `{digest?, analysis?, refs?: [{title?, url?, note?}], control?, *Truncated?}`; `{}` if known task has no results; 404 if unknown |
| `GET /api/runs/:runId/report` | `{path, text, truncated}` for first report artifact, or 404 |
| `GET /api/events?run=<runId>` | SSE `runs`, selected `run`, and 15 s `heartbeat`; initial payload immediately, later payloads only when content changes |
| `POST /api/runs/:runId/stop` | `{outcome, status, pending, interruptedTaskIds, text}` |
| `POST /api/runs/:runId/resume` | Detached resume: `{outcome, status, resetTaskIds, text}` |
| `POST /api/runs/:runId/approve` | Body `{requestId, decision: "approve"\|"reject"}`; result `{outcome, status, text}` |

### Dashboard projection

Run summaries include `runId`, `name`, `status`, `statusDetail?`, timestamps, redacted `taskPreview?` (≤140 characters), executor(s), host, task/agent counts, verdict, report availability, `needsYou` and `live` (a supervisor holds the lease).

Full runs add the redacted runtime task, permission mode, usage (or `null`), redacted launch details, pending approvals and tasks. Tasks include ids, kind, agent, state/reason, dependencies, executor/model/effort, timing, retry information, last message, usage, worktree, log availability, item title, outcome and current activity.

Agent counts exclude foreach placeholders, support helpers and controllers. Pending approvals expose request id, controller spec id, task id, title, message and request time. `needsYou` contains approvals, `executor_needs_decision` tasks, and failed/blocked runs. Cost is `null` unless reported by the executor.

## Discovery file

`<project>/.agent-workflow/dashboard.json` is written with mode 0600 after listening and removed on clean shutdown:

```json
{"schema":"agent-workflow-dashboard-v1","pid":12345,"port":47318,"startedAt":"…","launchKey":"<32 random bytes, base64url>","auth":false}
```

`launchKey` is a local control secret, never printed and distinct from the session token. Missing `auth` means the server requires sign-in. Readers require a live pid and a matching `/api/session` response: 401 with the dashboard JSON error under auth, or 200 with `apiVersion: 1, auth: false`. Local discovery/launch requests time out after 3 s. Dead-pid discovery files are removed.

### One-time launch URLs

`POST /api/launch` requires loopback/Host checks and `X-AW-Launch-Key` (timing-safe comparison), not cookie/CSRF. JSON accepts optional validated `run`, `task`, `tab`, `view`; response is `{url, launchId}`. A bad key returns 401; more than 16 outstanding launches returns 429.

Default URLs use `?launch=<id>` only to signal browser arrival; auth URLs use one-time `?token=<token>`. `GET /api/launch/:id`, protected by the launch key, reports consumption so MCP URL elicitation can complete. Session tokens and launch keys never appear in host tool results.

## Limits

The dashboard does not support multiple projects per server, remote access, HTTPS, authentication beyond the local token, workflow editing or launching runs from the browser.
