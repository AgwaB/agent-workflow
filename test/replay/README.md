# Replay recordings (WP1a)

These are reference recordings of how pi-workflow drives its workers. WP1b uses
them to prove the agent-workflow port behaves the same: it replays the recorded
worker responses through the ported engine and compares the normalized run
records. The rules are in `POLICY.md`. The pi-workflow test files and their port
tags are in `INVENTORY.md`.

## Files

| Path | What |
|---|---|
| `normalize.mjs` | Normalization policy (CLI + library) |
| `allowed-differences.json` | Allowed-difference list (each entry has a reason) |
| `replay-subagent-api.mjs` | Reference copy of pi-workflow's replay `SubagentApi` (from the seam branch) |
| `fixtures/minimal/` | One live recording: `calls.jsonl`, `api-surface.json`, `run/`, `subagent-runs/`, `normalized/`, `project/` (spec, input file, agent), `fixture.json`, `meta.json` |
| `tools/capture-run.mjs` | Copies `<cwd>/.pi/workflows/<runId>` (and `.pi/workflow-subagents/<runId>`) into a record dir |
| `tools/run-minimal.mjs` | Recording driver used for `fixtures/minimal` |
| `tools/make-portable.mjs` | Rewrites absolute host roots to `<ROOT>/<PKG>/<HOME>/<TMP>` |

`tools/` sits under `test/replay/`, not at the top-level `tools/`, because
`tools/release/check-public-surface.mjs` rejects tracked files outside
`tools/release/`.

## How recordings are produced

1. Check out pi-workflow at branch `work/wp1a-recording-seam-20261026`, based
   on `b83cc4f`. It adds `src/subagent-api-recorder.ts`. When
   **`PI_WORKFLOW_RECORD_DIR`** is set, `loadSubagentApi()` wraps the real
   `@agwab/pi-subagent/api` and appends one JSON line per call to
   `$PI_WORKFLOW_RECORD_DIR/calls.jsonl` (`{seq, method, pid, startedAt, args,
   result | error, endedAt, sync}`). It also writes `api-surface.json`. The
   seam does nothing when the variable is unset.
2. Run `npm install && npm run build` in that checkout.
3. Copy `tools/*.mjs` into the checkout's `internal/record/` (gitignored). There,
   `make-portable.mjs` imports `../../test/replay/normalize.mjs`.
4. Launch path. This is an in-process Node driver, not a parent Pi session:

   ```sh
   node internal/record/run-minimal.mjs <projectDir> <recordDir>
   ```

   The driver does the following:
   - Sets `PI_WORKFLOW_RECORD_DIR=<recordDir>`.
   - Imports this checkout's `dist/engine.js` and calls
     `runWorkflow(<projectDir>/workflow.json, <projectDir>, {task})`.
   - Drives the run with `waitForRun` until it reaches a terminal status.
   - Runs `capture-run.mjs <runId> <recordDir> --cwd <projectDir>`.

   Workers are real `pi` processes launched by pi-subagent. They use Pi's
   default model and the user's auth, and no model override is passed. The
   driver needs no parent LLM, and it cannot load the globally installed
   pi-workflow extension in the supervisor. Use `--fake` for a dry run without
   models.
5. Make the record portable:

   ```sh
   node internal/record/make-portable.mjs <recordDir> <fixtureDir> --root <projectDir> --pkg <checkout>
   ```

   Then normalize it:

   ```sh
   node test/replay/normalize.mjs <fixtureDir>/run <fixtureDir>/normalized
   ```

## Self-replay proof (pi-workflow side)

`test/unit/replay-self-consistency.test.mjs` on the seam branch replays
`fixtures/minimal` through the real engine with the replay API. No Pi, model,
or network is involved. It asserts that the normalized replay run record is
byte-identical to `normalized/` under the allowed-difference list.

Run it after `npm run build`:

```sh
node --test test/unit/replay-self-consistency.test.mjs
```

The same file has a negative test: changing the stage prompt makes the replay
fail with `replay miss for runSubagent`.
