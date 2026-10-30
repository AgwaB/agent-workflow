# Local web dashboard (WP43)

`agent-workflow dashboard` serves a **localhost-only** web view of the project's runs: where each agent is, how far along the run is, what needs the human, and the task logs — with Stop / Resume / Approve / Reject. It is the browser form of the Pi `/aw` board and of `watch`, and like them it is a **host**: every read and every action goes through the host API (`statusAction`, `showAction`, `logsAction`, `stopAction`, `resumeAction`, `approveAction`), so it inherits their containment, redaction and semantics. It never reads run files directly, takes no lease and calls no model.

Design reference: the approved F v9-O mockup (`dashboard-mockups/f-combined-v9-o.html`, 2026-10-29): rail · run header (status sentence + `N / total`) · DAG with the active foreach stage listing its agents · inspector; dark "control room" look; only what a person looks at more than once a day is on the default screen.

## Command

```
agent-workflow dashboard [--port <n>] [--readonly] [--auth] [--open] [--project <dir>]
```

- Binds **127.0.0.1 only** (never `0.0.0.0`, never IPv6-any). Port: the project's last port when free, else a free ephemeral port, unless `--port`.
- Prints one line with the URL and keeps running until SIGINT/SIGTERM (exit 0). `--open` opens it in the default browser. **By default there is no sign-in** (WP43d, below): the URL is plain. With `--auth` the URL includes the session token.
- `--readonly`: the UI shows a read-only badge and the server rejects every mutation with 403, whoever asks.
- `--project`: project directory (default: cwd). One server = one project (`<dir>/.agent-workflow/`).
- Exit 2 on usage errors (port in use, port out of range, not a directory).

## Security model

The default mode (WP43d) has **no sign-in**; the rows marked *(`--auth`)* apply only when sign-in is turned on. See "No sign-in by default" at the end for the reasoning and the stated residual risk.

| Threat | Control |
| --- | --- |
| Another local user / process on the machine | Bind `127.0.0.1`. **Default: accepted** — a local party that can reach the port can view runs and press the controls (same parties can read `.agent-workflow/` anyway). *(`--auth`)* 256-bit random **session token** required for everything except the bootstrap redirect; printed once to the launching terminal only. |
| Token leaking via URL/history/referrer *(`--auth`)* | The URL form `http://127.0.0.1:<port>/?token=…` is accepted **once per request** to set an `HttpOnly; SameSite=Strict; Path=/` cookie and `302` to `/`. All later requests use the cookie. `Referrer-Policy: no-referrer` on every response (both modes). |
| DNS rebinding / a web page on another origin calling the API | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 421). No CORS headers, so a foreign page cannot read any response. Mutations require `Origin` equal to the server origin (else 403). `Sec-Fetch-Site`, when present, must be `same-origin` or `none`; **default mode requires `same-origin` on every mutation** (browsers set it; pages elsewhere cannot). |
| CSRF | Mutations are `POST` with `Content-Type: application/json` and header `X-AW-CSRF: <csrf>`; the csrf value comes from `GET /api/session`, which only a same-origin page can read. *(`--auth`)* it is tied to the session token (HMAC) and the cookie is `SameSite=Strict`. No form posts. |
| XSS from worker output / reports / prompts | UI renders every string with `textContent`/`createElement`; reports are shown as **text** (headings and lists built as DOM nodes; no HTML, no images, no links from content). CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. No inline scripts/styles, no external resources, no web fonts. `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`. |
| Secrets / home paths in logs and launch commands | Everything passes the host API's redaction (`hostTextRedactor`, logs containment of WP19); the dashboard adds nothing unredacted. |
| Unbounded reads | Log tails bounded by the host API (≤ 400 lines, ≤ 48 kB per call); report body capped at 256 kB (truncated with a notice); SSE one connection per tab, server-side poll ≥ 1 s. |
| Mutation by a page in read-only mode | `--readonly` → 403 `{ error: "read-only" }` server-side; the UI disables the controls as well. |

Paths from the host API are project-relative already; the dashboard never echoes absolute paths beyond what `showAction` (redacted) returns.

## HTTP API

All JSON responses: `Content-Type: application/json; charset=utf-8`. Errors: `{ "error": string }` with 400/401/403/404/409/421/500.

| Method & path | Returns |
| --- | --- |
| `GET /?launch=…` (default) | marks that launch consumed (unknown ids ignored), 302 → `/` keeping well-formed `run`, `task`, `tab`, `view` params; a stray `?token=` is dropped the same way |
| `GET /?token=…` *(`--auth`)* | sets cookie, 302 → `/` — a printed deep link keeps its well-formed `run`, `task`, `tab`, `view` params (never the token, nothing else) |
| `GET /` `/app.js` `/app.css` | the UI (*`--auth`*: cookie required; 401 otherwise with the sign-in page) |
| `GET /api/session` | `{ apiVersion: 1, project: { path, name }, mode: "read-write" \| "read-only", auth: boolean, csrf, serverTime, version }` |
| `GET /api/runs` | `{ serverTime, runs: DashboardRunSummary[] }` — every top-level run, newest first |
| `GET /api/runs/:runId` | `DashboardRun` (full projection, below) |
| `GET /api/runs/:runId/tasks/:taskId/logs?stream=output\|stderr\|events\|all&lines=1..400` | `logsAction` data for that task (`LogsTask`, with `truncated`/`refused` as the host API reports) |
| `GET /api/runs/:runId/report` | `{ path, text, truncated }` of the first report artifact (text only) or 404 |
| `GET /api/events?run=<runId>` | SSE. Events: `runs` (`{ serverTime, runs }`), `run` (`DashboardRun` of `run`), `heartbeat` every 15 s. A payload is sent only when its content hash changed; first payloads immediately on connect. Poll interval 1 s (env `AGENT_WORKFLOW_DASHBOARD_POLL_MS`, 500–10000). |
| `POST /api/runs/:runId/stop` | `stopAction` → `{ outcome, status, pending, interruptedTaskIds, text }` |
| `POST /api/runs/:runId/resume` | `resumeAction` (detached supervisor, like the Pi board) → `{ outcome, status, resetTaskIds, text }` |
| `POST /api/runs/:runId/approve` body `{ requestId, decision: "approve"\|"reject" }` | `approveAction` → `{ outcome, status, text }` |

Mutations in read-only mode: 403. Unknown run: 404. A run id must match `^workflow_[A-Za-z0-9_-]+$` (no prefixes over HTTP).

## Dashboard projection (what the UI renders)

The server projects host-API data into one JSON shape; the UI never sees the raw run record. Field sources in brackets.

```ts
interface DashboardRunSummary {
  runId: string; name: string;                    // [RunSummary]
  status: "running"|"completed"|"failed"|"blocked"|"interrupted"|"pending";
  statusDetail?: string;                           // run-level hint when blocked (e.g. dynamic_approval_rejected)
  createdAt: string; updatedAt: string;
  executor?: string; executors?: string[];         // mixed runs: every executor
  host?: string;                                   // [launch.host] "cli" | "pi" | "codex" | "claude-code" | …
  taskSummary: { total, completed, running, pending, failed, blocked, interrupted, skipped };
  verdict?: string; reportAvailable: boolean;      // [statusAction verdict / reportArtifacts]
  needsYou: Array<{ kind: "approval"|"failed"|"decision"; title: string; requestId?: string; taskId?: string; since: string }>;
  live: boolean;                                   // a supervisor holds the lease [watch readWatchRun semantics]
}
interface DashboardRun extends DashboardRunSummary {
  task?: string;                                   // the user's task text (redacted) [record.description / launch]
  permissionMode?: string;
  usage: { tasksReporting, taskCount, input?, output?, cacheRead?, total?, costUsd: number|null, note?: string } | null;  // null → "Not collected"
  launch?: { host, entry, command }                // [showAction launch, redacted]
  pendingApprovals: Array<{ requestId, controllerSpecId, taskId, title, message, requestedAt }>;
  tasks: DashboardTask[];
}
interface DashboardTask {
  taskId; specId; stageId; kind: "single"|"foreach"|"reduce"|"support"|"dynamic"|"loop"|string; agent;
  status; statusDetail;                            // raw engine values; the UI maps them to sentences
  dependsOn: string[];                             // spec ids
  generated: boolean; placeholder: boolean;        // foreach/dynamic expansion
  executor?; model?; effort?;
  startedAt?; completedAt?; elapsedMs?;
  retry?: { attempt: number; maxAttempts?: number; reason?: string; nextRetryAt?: string };  // [launchRetry / outputRetry]
  lastMessage?: string;                            // redacted
  usage: { input?, output?, total?, costUsd: number|null } | null;
  worktree?: { path: string|null; branch: string|null };
  hasLogs: boolean;                                // a started task with output/stderr files
}
```

Rules: `task` is the run's runtime task text from `showAction({ includeTask })` (redacted, bounded), never the workflow's `description`. `costUsd` is `null` unless the executor reported a cost — never 0. Pending approvals come from `pendingDynamicApprovals` (status). `needsYou` = pending approvals (`approval`), tasks with `statusDetail === "executor_needs_decision"` (`decision`), and failed/blocked runs (`failed`). A run the user stopped (`interrupted`) is not a need: its sentence says "Stopped by you … Resume when ready" and the Resume action is offered; it is not pinned. Strings are redacted by the host API before projection.

## UI

Single page, no build step: `src/hosts/dashboard/ui/{index.html,app.css,app.js}` (ES module). Behavior is the F v9-O mockup with the fixture replaced by `/api/*` + SSE:

- Rail: Needs you (across the project's runs) · Runs (name, one human line, `done/total`, elapsed, thin neutral bar; completed runs with a report get `Report ↗`).
- Run header: name 28 px, state chip, **status sentence** (mapping table in `app.js`: `statusDetail`/counts → one plain sentence), `N / total` stat block, elapsed, actions (Stop…, Resume…, Review approval…, Run details).
- DAG: top-down (left-right toggle), outlined nodes, dimmed pending, the **active foreach node lists its agents** (≤ 6, else `n agents · inspect items`), mint running marker, amber gate edge, red failed glyph. `Fit`, `Focus`, layout toggle, `?` (status key).
- DAG shape for dense graphs (2026-10-30, owner feedback "too complex", reference: GitHub Actions' workflow visualization graph — <https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph> — which stacks jobs that share dependencies into one card, collapses a matrix into one card, routes edges as orthogonal elbows with port dots and merges joins into one trunk): (1) **stacked cards** — stages in the same layer with identical inputs *and* outputs become one card titled `<shared prefix> · n in parallel` with a row per stage (status glyph, short name, `Done · 27s`), a done/total bar, the worst status as the card's; rows open their own stage, the card opens its first; foreach/approval/ghost stages keep their own card; (2) **orthogonal rails** — every edge is stem → shared rail through the middle of the channel between the two layers → stem, rounded corners, a port dot at the source; edges of one channel merge into one bus line, so a fan-out/join is a few lines instead of n×m crossing curves; an edge that skips layers travels down the gap beside its source; (3) **hover/focus tracing** — a hovered or focused card keeps its own edges and neighbours lit and dims the rest (`.graph.tracing`), which recovers the exact pairs a bus hides; (4) a dotted prefix shared by every stage (`impact-analysis.`) is dropped from card text (titles, labels and the inspector keep full names).
- DAG direction and position (2026-10-30, owner feedback "arrows are hard to see; show where it's going; the canvas scrolls forever"): every edge ends in an **arrowhead** (constant 13 px at any zoom) and carries a state — `active` (into a running/retry stage: accent, dashes flowing toward the stage), `blocked` (amber, slow flow), `next` (the stage work goes to next: dashed accent, slow flow; that node gets a dashed accent outline), `done` (travelled: solid; a calm **wave** runs over the travelled path, also on a finished run, so its direction reads without any button or setting — one short glint per edge, edges leaving layer n start at n·1000 ms, every glint travels in 950 ms whatever its length, then a 2 s rest; one shared cycle keeps the glints in step instead of scattering dots along shared rails), `later` (faint dashed), `failed` (red). The running node glows (accent stroke, soft shadow). Layers sit 48 px apart (72 px left-right) so edges read as a path. `Fit` never zooms below 0.7 (boxes stay large enough for their text); a graph that still overflows starts at its top/left, **pan is clamped** so the graph can never leave the canvas, and a pill per side (`4 more →`, accent `· active` when the work is over there) counts the off-screen stages and pans to them on click. The status key lists the arrow states. **Replay on first view**: the first time a run is drawn in a tab, its cards fade in layer by layer and the solid (travelled) edges draw themselves toward the next layer, ending with one pulse on the card where the run ended (red for failed, amber for blocked, accent otherwise) — a finished run shows how the work went even though nothing moves afterwards; redraws caused by status changes do not replay, and a run update that changes nothing structural keeps the drawn graph (so the flow keeps its phase). `prefers-reduced-motion` stops the flow, the glow and the replay.
- Inspector: task name, one status line (live countdown from `retry.nextRetryAt`), reason, `executor · model · effort`, Output / Stderr / Events tabs with the bounded redacted tail and one `untrusted output` label, `Copy`, collapsed **Details** (attempts, timestamps, usage/`Not collected`, dependencies, worktree, terminal handoff commands).
- Run details view: task text, launch command (copy), usage, permission mode, host.
- Dialogs: Stop (impact: running/pending counts; "stop is recorded durably and confirmed by the supervisor"), Approve (question + scope from the approval message), Reject (run stays blocked), Resume (completed tasks are not relaunched). Read-only disables confirm.
- Connection: `Live` while SSE delivers; `Reconnecting` on error with automatic retry; `Stale (updated …)` when no heartbeat for 30 s — independent of run status.
- URL state: `?run=<id>&task=<specId>&tab=output|stderr|events&view=report|details&dialog=stop|resume|approve|reject`. Keyboard: ↑/↓ runs or tasks, Enter opens, Esc closes, `⌘K` palette (jump to run/stage).
- Body 15 px; nothing < 12 px; no `innerHTML`; no fills on fills; one accent.

## Acceptance (verifiable)

1. `npm run validate` passes (format, typecheck, unit); new unit tests cover: projection from a synthetic `WorkflowRunRecord` (retry, foreach, approval, decision, usage null→`costUsd: null`), every security control (bind address, token bootstrap once, cookie flags, Host 421, Origin 403, CSRF 403, read-only 403, CSP/nosniff/no-referrer headers present, run id validation, 404), SSE change-only delivery, and the CLI parse (`--port` validation, exit codes).
2. An e2e test (`test/e2e`, using the existing test-executor hook) starts a real run, starts the dashboard, and asserts over HTTP: the run appears, tasks and `needsYou` match the record, logs are bounded and redacted, `stop` interrupts the run, `--readonly` blocks it.
3. A headless-Chrome check (`test/unit/host-wp43-dashboard-ui.test.mjs`, skipped when Chrome is absent) loads the UI against a CSP-identical fixture server (the live server was exercised manually: real runs, stop, resume, deep links): no console errors, no network requests off-origin, the status sentence and `N / total` render, selecting a task shows the inspector with the countdown, and the CSP header is honored (an injected `<script>` text in a log line stays text).
4. Package: `npm run pack:dry` lists the UI files; `check:public-surface` passes (the dashboard is a host, not an SDK export).
5. Docs: this file, `docs/cli.md` (command section + change log), `README.md` one line.

## Out of scope (v1)

Multiple projects in one server, authentication beyond the local token, HTTPS, remote access, light theme, editing workflows, launching runs from the browser, desktop app / MCP Apps.

## Launch integration (WP43b — "run" and the dashboard)

Decision (owner, 2026-10-30, after the survey in the analysis workspace): running a workflow never starts or opens a dashboard by itself; `run` prints a token-free link when a dashboard is already running; opening is opt-in and is suppressed when an AI agent launched the command.

### Discovery file

`<project>/.agent-workflow/dashboard.json`, mode `0600`, written by the dashboard after it listens and removed when it exits (SIGINT/SIGTERM/close):

```json
{ "schema": "agent-workflow-dashboard-v1", "pid": 12345, "port": 47318, "startedAt": "…", "launchKey": "<32 random bytes, base64url>", "auth": false }
```

- `launchKey` is a **local control secret** that only mints one-time launch URLs (below). It is never the session token, and it is never printed. Same trust boundary as the run records next to it (same user, 0600).
- `auth` (WP43d) says whether that server requires sign-in; a file without it (older server) means it does.
- Readers (`readDashboardDiscovery(cwd)`) accept the file only if the pid is alive and `GET http://127.0.0.1:<port>/api/session` answers within 500 ms either 401 with our JSON error (`--auth`) or 200 with `apiVersion: 1, auth: false` (default) — proves the port is ours. A stale file whose pid is dead is deleted.

### One-time launch URLs

- `POST /api/launch` — loopback + Host checks; header `X-AW-Launch-Key` (timing-safe compare); JSON body with optional `run`, `task`, `tab`, `view` (validated like the bootstrap forward). Response `{ "url", "launchId" }`; the URL is `http://127.0.0.1:<port>/?launch=<id>&run=…` by default (no credential) and `…/?token=<one-time>&run=…` under `--auth`. No cookie or CSRF (the key authenticates). 401 on a bad key, 429 with more than 16 outstanding launches.
- One-time tokens (`--auth`): 32 random bytes, 60 s TTL, single use; the bootstrap accepts them exactly like the session token (sets the same session cookie, forwards the UI params) and then discards them. The session token still works for manual sign-in. By default the launch id only lets the minter learn that the browser arrived (`GET /api/launch/:id`, launch-key protected).
- `dashboard --open` opens a launch URL, never a session URL (Jupyter's launch-token pattern under `--auth`).

### `run` / `dynamic` / `auto`

- `LaunchData.dashboard?: { url, port }` when discovery validates — `url` is token-free (`http://127.0.0.1:<port>/?run=<id>`); the text gets one line `Dashboard: <url>` right after the run heading. When no dashboard runs the line reads `Dashboard: not running · agent-workflow dashboard --open` (one short line; the owner asked for the link to come first).
- `--open` (CLI flag) or `AGENT_WORKFLOW_DASHBOARD_OPEN=1`: after the launch, make sure a dashboard runs (start one detached when absent: `agent-workflow dashboard --project <cwd> --detached`, which prints no session URL and only writes the discovery file; wait ≤ 3 s), mint a one-time URL for `run=<id>` and open it with the platform opener.
- **Agent suppression (Storybook's rule):** when `CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT` or `AI_AGENT` is set, or the host context is `pi`/`codex`/`claude-code`, the env-var form does not open (the token-free line is printed with "not opened: AI agent environment; pass --open to force"). The explicit `--open` flag always opens.
- `dashboard --status` prints the discovery state (pid, port, since, auth on/off); `dashboard --stop` sends SIGTERM to the recorded pid and waits for the file to disappear.

### MCP hosts (Codex, Claude Code)

- `workflow_run` / `workflow_dynamic` / `workflow_auto` results carry the token-free `dashboard` line through `LaunchData`.
- New tool `workflow_dashboard { run? }`: ensure a dashboard runs (start detached when absent), mint a one-time URL, then: if the client advertises `elicitation.url` (MCP 2025-11-25), send `elicitation/create` with `mode: "url"`, `url`, `elicitationId`, `message` ("Open the agent-workflow dashboard for <project>?"); the user consents in the client's dialog and the client opens it — the URL never enters the tool result — and once the browser has consumed the one-time token the server sends `notifications/elicitation/complete` (polled through `GET /api/launch/:id`, launch-key protected) so the client stops waiting. If the client has only form elicitation (Codex today), a form dialog asks "Open the agent-workflow dashboard for <project> in your browser?" and on accept the MCP server — which runs on the user's machine — opens the browser itself (`BROWSER` honored), like `/aw dashboard` in Pi. Clients without any dialog get instructions only: "Dashboard is running on 127.0.0.1:<port>; open it from a terminal with `agent-workflow dashboard --open`". `structuredContent`: `{ running, port, opened, method: "url-elicitation" | "form-consent" | "instructions" }`. Never the token, never the launch key.
- Launch results (`workflow_run`/`workflow_dynamic`/`workflow_auto`, CLI `run`) put the `Dashboard:` line right after the run heading; when no dashboard runs the line reads `Dashboard: not running · agent-workflow dashboard --open`, and the MCP "Next:" guidance tells the model to report the run id and that line to the user **before** waiting (people want the link first).
- Codex today advertises form-only elicitation by default (openai/codex#29344), so Codex gets the instructions path until that lands; Claude Code (≥ 2.1.87) gets the URL dialog.

## Always a link (WP43c — owner decision A, 2026-10-30)

The owner wants the dashboard link in the launch result every time, clickable, without a token in the chat. Three pieces make that work. (WP43d then made the session optional: the persistent-session section below applies under `--auth`; auto-start, sticky port and idle exit apply always.)

### Persistent session (sign in once per browser) — `--auth` only

- The session token is stored in `<project>/.agent-workflow/dashboard-session` (mode 0600, 32 random bytes base64url) and **reused** by every dashboard start for that project, so a browser that signed in once keeps a valid cookie across dashboard restarts. Same trust boundary as `dashboard.json`'s launch key and the run records beside it.
- `agent-workflow dashboard --reset-session` writes a new token (every browser must sign in again) and stops a running dashboard first if there is one.
- The foreground `dashboard` command still prints the token URL once; `--detached` prints nothing but the port.
- A request without the cookie for `/` or `/app.js` gets a **401 sign-in page** (CSP-safe; `/app.css` is public so the page is styled): "This browser isn't signed in to the agent-workflow dashboard for `<project basename>`. Sign in once; after that, links like this one open directly." with a **"Sign in on this computer"** button. The button's script (`/signin.js`, same-origin fetch) calls `POST /api/signin-local`; the server accepts it only with `Sec-Fetch-Site: same-origin` and a matching `Origin` (cross-site pages and non-browser callers are refused; one call per 3 s), mints a one-time URL forwarding the page's `run/task/tab/view`, and opens it through the OS opener (`BROWSER` honored) — a signed-in tab appears and the original tab polls `/api/session` and reloads. The one-time URL never reaches the page, the chat or a foreign caller. The terminal (`agent-workflow dashboard --open`) and "ask your agent" paths remain.

### Auto-start on launch

- `run` / `dynamic` / `auto` (host API, so CLI, Pi and MCP alike): when no dashboard runs for the project, start one detached (`agent-workflow dashboard --project <cwd> --detached`; it inherits `AGENT_WORKFLOW_DASHBOARD_AUTH`), wait ≤ 3 s for its discovery file, and fill `LaunchData.dashboard = { url, port, started: true, auth?: true }`. The text line is always `Dashboard: http://127.0.0.1:<port>/?run=<id>`; when an `--auth` dashboard was started just now the line ends with ` · first time in this browser? agent-workflow dashboard --open`.
- Opening the browser is still opt-in (`--open`, env var, `workflow_dashboard`, `/aw dashboard`) and still suppressed under agent environments — auto-start only runs a loopback server.
- Off switch: `AGENT_WORKFLOW_DASHBOARD_AUTOSTART=0`. Never auto-starts under the `worker` process role, in `--readonly` contexts, or when the start fails (the launch still succeeds; the line then reads `Dashboard: not running · agent-workflow dashboard --open`). The unit runner and the e2e guard set the variable to `0`; tests that cover auto-start opt in.
- MCP `Next:` guidance: tell the user the run id and the Dashboard link before waiting; if the user wants it opened for them (or, under `--auth`, says the link asks them to sign in), call `workflow_dashboard` (consent dialog → browser).

### Sticky port

The port a project's dashboard used last is kept in `<project>/.agent-workflow/dashboard-port` and reused on the next start when nothing else holds it (an explicit `--port` is strict; a busy preferred port falls back to an ephemeral one). Together with the persistent session this keeps `Dashboard:` links in older chat messages working across idle exits and restarts.

### Idle exit for detached dashboards

- A dashboard started `--detached` exits by itself after `AGENT_WORKFLOW_DASHBOARD_IDLE_MS` (default 2 h, min 1 min) with **no SSE client connected and no live run** (running/blocked with a live lease) in the project; it removes its discovery file on the way out. A foreground dashboard never idles out. `dashboard --status` shows "idle exit in …" for detached ones.

## No sign-in by default (WP43d — owner decision, 2026-10-30)

Local dev UIs in the survey (Dagster, Prefect, Temporal dev, Inngest, Mastra, MLflow) have no sign-in on loopback; the owner found the one-time sign-in friction not worth what it buys on a personal machine. So:

- **Default (`auth: false`)**: no session token, no cookie, no sign-in page. Any loopback request may read the UI and the API; `Dashboard:` links open directly in any browser. What still holds: `127.0.0.1` bind, `Host` allowlist (421 against DNS rebinding), no CORS headers (foreign pages cannot read responses), mutations require `Origin` = server origin **and** `Sec-Fetch-Site: same-origin` **and** `X-AW-CSRF` (a per-server random value delivered by `GET /api/session`, which foreign pages cannot read), CSP/nosniff/DENY/no-referrer/no-store, bounded bodies/logs/reports, read-only mode. **Residual risk, stated plainly:** another OS user or process on the same machine can view runs and press Stop/Resume/Approve/Reject while a dashboard is up. The `.agent-workflow/` run records beside it are readable by the same parties anyway.
- **Opt-in (`agent-workflow dashboard --auth`, or `AGENT_WORKFLOW_DASHBOARD_AUTH=1` so auto-started dashboards use it too)**: the previous model exactly — persistent per-project session token, cookie bootstrap, one-time launch URLs, sign-in page with the one-click button, `--reset-session`. For shared machines.
- `GET /api/session` reports `auth: true|false`; the UI shows no sign-in state when auth is off (a restart just reconnects).
- Links and openers in the default mode carry no token: the launch line is `Dashboard: http://127.0.0.1:<port>/?run=<id>` (no "first time" hint); `dashboard --open`, `/aw dashboard`, `workflow_dashboard` and `--open` open `http://127.0.0.1:<port>/?run=…` directly. `POST /api/launch` (launch-key protected as before) returns `{ url, launchId }` where the URL carries `launch=<id>` instead of a token; serving `/` with `launch=<id>` marks it consumed (then the UI params are forwarded without it), so the MCP tool's `notifications/elicitation/complete` keeps working. The discovery file records `auth: true|false`.
- `dashboard --status` prints `auth: on|off`. Docs/README say which mode is on and why.
