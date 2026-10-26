# Replay normalization policy

Policy id: `agent-workflow-replay-normalization-v1`. The code is in
`normalize.mjs` (no dependencies). Accepted differences are listed in
`allowed-differences.json`.

A reference recording comes from one real pi-workflow run. It records every
pi-subagent API call (`calls.jsonl`) and the workflow run directory (`run/`).
A replay drives an engine with those recorded worker responses. The replay
passes when the **normalized** run record of the replay is byte-identical to
the normalized run record of the recording.

## What is compared

- Compared: the workflow run directory `<cwd>/.pi/workflows/<runId>/`
  (`run/`). This holds `run.json`, `compiled.json`, `spec.json`, `bundle/`,
  `supervisor.json`, and per-task prompts, outputs, `control.json`,
  `analysis.md`, `refs.json`, `result.json`, source manifests, the generated
  worker extension wrapper, and durable launch barrier files.
- Not compared, used as replay input instead: `subagent-runs/`, the pi-subagent
  artifacts under `<cwd>/.pi/workflow-subagents/<runId>/`. The replay writes
  these from the recording, so comparing them would prove nothing.
- Not compared byte for byte: `calls.jsonl`. Calls are matched through the
  replay key below. Poll counts depend on timing, so the call sequence is not
  expected to match exactly.

## Step 1: portable paths (reversible)

Absolute host roots are replaced longest-first. Each root also matches its
`realpath` and its macOS `/private` twin.

| Placeholder | Meaning |
|---|---|
| `<ROOT>` | project cwd of the workflow run (worktree/project root) |
| `<PKG>` | workflow engine package checkout (pi-workflow worktree) |
| `<HOME>` | user home |
| `<TMP>` | OS temp dir |

Committed fixtures store only this form. Replay reverses it with
`restorePaths` for the replay host.

## Step 2: placeholders

Values that differ between runs by construction are replaced with
placeholders.

| What | Rule | Placeholder |
|---|---|---|
| Workflow run id | `workflow_<base36>_<hex6>` anywhere in text/keys/paths | `<WF_RUN_n>` |
| Subagent run id | `run_<base36>_<hex6>` | `<SA_RUN_n>` |
| Subagent attempt id | `attempt_<base36>_<hex6>` | `<SA_ATTEMPT_n>` |
| ISO timestamps | `YYYY-MM-DDTHH:MM:SS(.f)Z` or `±HH:MM` | `<TS>` |
| Epoch-ms fields | `mtimeMs`, `ctimeMs`, `atimeMs`, `birthtimeMs`; numbers in `[1e12, 1e13)` under `*At`/`*Time`/`*Timestamp`/`*Epoch` keys | `<EPOCH_MS>` |
| Durations | numeric keys ending `Ms`, except config keys `timeoutMs`, `pollIntervalMs`, `maxRuntimeMs`, `launchSlotReleaseDelayMs`, `retryAfterMs`, `releaseDelayMs`, `retryJitterMs`, `intervalMs`, `maxWaitMs` | `<DURATION_MS>` |
| PIDs | `pid`, `workerPid`, `processGroupId`, `workerProcessGroupId`, `ppid`, `ownerPid`, `parentPid`, `*Pid` | `<PID>` |
| Lease owner ids | `ownerId` of the form `<pid>-<hex>` | `<OWNER_ID>` |
| Process birth identity | `darwin:<sec>:<usec>` (and linux/win32/freebsd) | `<PROC_BIRTH>` |
| File-system identity | `device`/`dev`, `inode`/`ino`, `uid`, `gid` | `<FS_DEV>`, `<FS_INO>`, `<UID>`, `<GID>` |
| Random barrier dir suffix | `.launch-barrier-<hex16>-<hex16>`: the second part is `randomBytes(8)` | `-<RAND16>` |
| Hostname | `os.hostname()` of the normalizing host | `<HOST>` |

Ids are numbered by first appearance. Files are visited in id-insensitive
relative-path order, and keys in sorted order. Task ids (`task-1`) and spec ids
are deterministic, so they are kept as-is.

## What is NOT masked

- **Content digests and hashes are kept by default.** If the content matches,
  they must match: prompt `sha256`, `manifestSha256`, output bytes `sha256`,
  barrier `readySha256`/`decisionSha256`/`ackSha256`, and so on.
- Nonces the API echoes back (`challenge`, `decisionNonce`), config `*Ms`
  values, byte sizes, counts, token usage, `costUsd`, model and provider ids,
  and all prose.
- WP1b may add digest fields to the allowed-difference list. Each one needs a
  written reason and a failing replay that proves the difference is necessary.
  Do not add broad keys such as a bare `identitySha256` when a dotted suffix
  works.

## Determinism

- JSON (`*.json`, `*.txn`, and any text that parses as JSON): sorted keys,
  2-space indentation, trailing newline.
- JSONL: each line parsed, normalized, and written back as compact canonical
  JSON.
- Other text is processed line-independently with the text rules. Non-UTF-8
  files are replaced by `<BINARY sha256=...>`.
- Output file names use the normalized relative path. `<`, `>`, and `:`
  become `{`, `}`, and `~` on disk.

## Allowed differences (`allowed-differences.json`)

An entry names keys: bare field names, or dotted key suffixes such as
`grant.identitySha256`, where array levels are skipped. Each distinct sha256
value found at those keys is alpha-renamed to `<ALLOWED:id#n>`, numbered by
first appearance. Every other occurrence of that value anywhere is renamed the
same way, and so is its 16-hex prefix in generated file names. Other scalars at
those keys become `<ALLOWED:id>`.

The values themselves may differ. The **equality structure** must still match:
if field A equals field B in the recording, it must equal it in the replay too.

Current entries. The first five were needed for the minimal self-replay to
pass. The last three were added by WP1a-2 for the bundled fixtures. They are
new entries; no existing entry was widened:

| id | Keys | Reason |
|---|---|---|
| `host-path-digest` | `workflow.specPathSha256`, `effectivePolicy.cwdSha256`, `effectivePolicy.toolProvidersSha256`, `extensions.pathSha256`, `artifactBinding.wrapperPathSha256`, `artifactBinding.manifestPathSha256`, `artifactBinding.wrapperBytesSha256`, `artifacts.wrapperSha256`, `artifacts.configSha256` | sha256 of absolute host paths, or of bytes and canonical JSON that embed them. The generated worker extension wrapper and its config embed `manifestPath`, `ledgerPath`, and `runDir`. The paths themselves are normalized and compared; their digests cannot be. |
| `state-root-identity` | `effectivePolicy.stateRootSha256` | Digest of the private state-root identity: canonical path, device, inode, uid, mode, and a random nonce file. It is host- and install-specific by design. |
| `derived-launch-identity` | `records.identitySha256`, `grant.identitySha256`, `grant.launchBootstrapSha256`, `launchBootstrapSha256`, `launchAuthoritySha256`, `subjectSha256` | Canonical self-digests of launch provenance and authority records, which include the two rows above, plus every field that references them (and the `.launch-barrier-<16hex>` directory prefix). |
| `timestamp-derived-digest` | `rawIntegrity.owner`, `rawArtifactIntegrity.owner` | Raw-artifact owner identity is sha256 over JSON that contains the run `createdAt` timestamp. |
| `host-path-file-size` | `terminalVersion.size` | Byte size of the pi-subagent attempt `result.json`, which embeds absolute host paths; its length depends on the path length. The dev, ino, mtime, and ctime of the same version stamp are already placeholders. |
| `host-path-manifest-digest` | `artifacts.manifestSha256`, `artifactBinding.manifestBytesSha256` | Digests (canonical JSON and raw bytes) of a task's `source-manifest.json`, whose artifact entries embed absolute `<ROOT>` paths. They appear for every stage with upstream artifact access (`deep-review` task-7 first; minimal's manifest has no paths, so its digest happened to match). This is a manifest digest, so content stays pinned another way: the manifest file is compared after path normalization, the pi-workflow self-replay test asserts that both replayed digests equal the digests of the replayed `source-manifest.json`, and the fixture build checked the same binding on the raw recording. |
| `foreach-batch-capability-identity` | `foreachBatches.capabilitySubjectSha256`, `args.capabilitySubjectSha256`, `args.stateRootSha256` | Profile-only foreach batching (`deep-research` verify-claims) records `foreachBatches[]` with the host-specific `stateRootSha256` and `capabilitySubjectSha256`, a digest over the batch record that includes that state root and the `preparedAt` timestamp. The engine also passes both to `durableLaunchBarrierDigest`, where no `effectivePolicy` key renames the state root within that one call's replay key. Batch and member prompt digests stay compared. |
| `supervisor-progress-snapshot` | `taskStatusCounts.{blocked,completed,failed,interrupted,pending,running,skipped}` | `supervisor.json` is the supervisor heartbeat. Its counts are the progress at the last write, which races the final task transitions. In `deep-research` the recording had 20 completed and the replay 19, 3 of 3 times. Final statuses stay compared in `run.json`; `total` is not masked. |

## Replay key

`replayKey(method, args)` is computed as follows:

1. Normalize `{method, args}` with the step 1 and step 2 rules. Id numbering is
   fresh for each call.
2. Apply the allowed-difference renaming within that one call.
3. Take the sha256 of the canonical (sorted, compact) JSON.

Replay queues are keyed by `replayQueueId`: method, replay key, and the
literal pi-subagent run and attempt ids (`run_…`, `attempt_…`) that appear in the
arguments. The replay hands out the recorded ids verbatim, so they are
reproducible. Without them, the status polls of two attempts of one task (an
output retry) share one key, because id numbering is fresh per call, and the
replay serves the second attempt's responses to the first.

Recorded args are already portable. Replay args are normalized with the replay
host roots.

On a miss, replay throws. The error names the closest recorded key for that
method (longest common prefix of the canonical JSON) and the first differing
line.

## Replay semantics (pi-workflow `SubagentApi` replay; `replay-subagent-api.mjs`)

- **Observation methods** collapse consecutive identical normalized responses
  and repeat the last response once the recorded ones run out. These are
  `getSubagentStatus`, `getSubagentLogs`, `reconcileSubagentRun`,
  `readDurableLaunchBarrierV2State`, and the pure helpers
  `supportsExplicitExtensionIsolation` and `durableLaunchBarrierDigest`. Poll
  counts are timing, not behavior. The recording polled about 49 times; replay
  polls once.
- **Effectful methods** are served once per recorded call, and an extra call
  throws. These are `runSubagent`, the barrier create/release/revoke/wait
  methods, and `interruptSubagent`. The test asserts that none are left unused.
- **Echo rebinding.** A matched call can differ from the recording only in
  masked fields, such as a fresh random barrier directory or an env-derived
  `subjectSha256`. In that case each differing recorded string is mapped to its
  replay value, and the mapping is applied to later responses and restored
  files. Real responses echo their request, so replayed responses echo the
  replay request.
- **Side effects** are restored from the recording:
  - Barrier directory files are written after `createDurableLaunchBarrierV2`.
  - `subagent-runs/<taskId>/` is written at the first terminal
    `getSubagentStatus` for that task.
  - Files the worker itself writes into the workflow task directory are
    restored at the same moment from `run/tasks/<taskId>/`. Today that is the
    `workflow_artifact` read ledger `read-ledger.jsonl`; the engine checks
    required artifact reads against it after the worker ends.
  - When a fixture has `worker-snapshots/<subagentRunId>/web-source-cache/`
    (recorded with `run-bundled.mjs --snapshot-web-cache`), it is written over
    `<ROOT>/.pi/workflows/<runId>/web-source-cache/` at the first terminal
    status of that subagent run. Workers fill this shared cache while they run,
    and support helpers read it later.
- **Harness pins:**
  - The replay reuses the recorded workflow run id (`runId` option).
  - `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES` is set to the recorded value of 6,
    because the default is CPU-derived.
  - `HOME` points to a temp dir. `PI_CODING_AGENT_DIR`, `PI_WORKFLOW_ROLE`,
    and `PI_WORKFLOW_RECORD_DIR` are unset.
  - The engine is loaded from the same `dist/` build as the recording, because
    the worker wrapper imports `<PKG>/dist/...`.
  - Per-fixture pins in `fixture.json` (also listed under `meta.json`
    `hostPins`):
    - `env`: environment values, today `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES`.
    - `rootPathLength`: the replay project gets an absolute path of exactly this
      length. Workers write absolute paths into their output, and the engine
      cuts some of that text by character count (for example the excerpt of
      the previous output in an output-retry prompt).
    - `replayRoot` (+ `replayRootPlatform`): replay at this exact absolute path.
      Used when workers write absolute project paths into outputs whose
      digests the engine records (output `sha256`, support control digests
      that are then embedded in later prompts). `spec-review` needs it: its
      evidence citations carry full local paths. No allowed difference can
      cover these digests, so the recording ran at a fixed path that the
      replay can recreate (`/private/tmp/piwf-replay-roots/<name>`, macOS).
      `deep-research` uses it as well: at a temporary path its
      `foreachBatches[].executionSurfaceSha256` diverges.
    - `projectIsPackageRoot`: the recording used the engine checkout itself as
      project cwd (`<ROOT>` == `<PKG>`, written as `<ROOT>`), so the replay
      does too (`impact-review`).
    - `executionProfile`, `inputOverrides`: launch options, as recorded.
    - `expectedStatus`: the recorded engine status. A domain render that fails
      closed (`failed`) is still a complete recording.

## Known limits

- `supervisor.json` `taskStatusCounts` matched in every minimal replay, but
  `deep-research` differed. It is now masked (`supervisor-progress-snapshot`).
- The run record can turn terminal a moment before the supervisor removes
  `supervisor.lock`. The self-replay test waits for the lock to go away before
  it normalizes; without the wait it failed 1 run in 6.
- `PI_WORKFLOW_REPLAY_TRACE=1` (or `full`) makes the replay API log each served
  or missed call to stderr. It is a debugging aid only.
- Digest renaming trusts the key list. A digest at an unlisted key that differs
  shows up as a real difference. That is intended.
- `calls.jsonl` in the bundled fixtures is compacted by
  `tools/compact-calls.mjs`: observation polls whose normalized response equals
  the previous response of the same replay queue are dropped. This builds the
  same replay queues as the full file. The full portable file stays under
  `internal/raw-recordings/<name>/` (local, not committed).
- Output retry and recording fidelity: pi-subagent hard-links an attempt's
  `output.log`/`stderr.log` to the workflow task files, and the engine
  truncates those files before it relaunches the task. The capture at run end
  therefore holds an empty `output.log` for the earlier attempt. The fixture
  build restores those bytes from the engine's verbatim
  `raw.invalid-attempt-<n>.md` copy, but only when the byte count matches
  `result.json`. That attempt's `stderr.log` is lost and stays empty
  (`meta.json` `reconstructedAttemptOutputs`).
- `replayRoot` fixtures replay byte-identically only where that absolute path
  can be created (the pi-workflow test skips them on other platforms).
  Elsewhere, digests over worker text that contains host paths will differ,
  and so will prompts that embed those digests.
