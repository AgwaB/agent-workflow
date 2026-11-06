# Dashboard shape/state matrix

These are **real dashboard API projections from local engine runs**, driven only by
`test-matrix` through the acknowledged CLI test-executor module hook. No provider or
real agent CLI is called. `manifest.json` records each capture's shape and state.

Covered: single, four-stage chain, parallel fan-out/join, foreach 3/18/60,
mixed success/permanent failure/transient retry, dynamic `ctx.agent` children,
loop, support helper, stop/resume, needs-decision after a
consume crash, failure, and long Korean/unbroken labels.

Sanitization replaces run IDs with deterministic IDs, disposable project/repository
paths with neutral paths, and timestamps with a fixed clock (relative timings kept).
The two `long-text` snapshots derive from the real single-stage snapshots: only the
workflow name, result summary, and activity label are replaced with boundary-length
text. Agent counts exclude foreach placeholders, support helpers, dynamic
controllers and loop gates; task counts intentionally include those engine tasks.
The dynamic/loop counters were refreshed for that projection correction.

## Refresh (offline)

```sh
npm run build
node test/helpers/generate-dashboard-matrix.mjs
```

The generator creates private temporary projects and a private workflow home, always
selects `--executor test-matrix`, then stops its runs and removes the projects. Never
substitute a real executor. To also record the live 18-item run:

```sh
node test/helpers/generate-dashboard-matrix.mjs /absolute/path/to/captures
```

An optional third argument selects comma-separated shapes (a partial refresh writes
only that refresh's manifest; merge it deliberately if retaining other snapshots).
Refreshes vary in elapsed time and which pending item has started; review topology,
counters and sanitation rather than expecting byte-identical snapshots.

## Browser regression

```sh
node test/run-unit.mjs test/unit/host-wp43-dashboard-matrix.test.mjs
```

Uses the local Chrome/CDP helper and fixture HTTP/SSE server, not an executor. Every
snapshot is opened at 1440×900, 1280×800, 1920×1080 and 1440×900 left-to-right.
Checks layout bounds, row collisions, group/agent/task counts, accessible selection,
keyboard activation, reduced motion, neutral completion, readonly mutations, console
errors, CSP errors, and absence of remote requests. Live regressions cover filter,
header and parallel-row focus plus 24 clock-update samples at nominal 8 fps.

Set `AW_DASHBOARD_MATRIX_SCREENSHOTS=/absolute/path` to save all viewport cells.
Chrome absence is an explicit skip, not a substitute for the local browser pass.
The fixture server's existing favicon response is synthetic: real-server favicon
handling must be checked separately (the real host currently returns 404).
