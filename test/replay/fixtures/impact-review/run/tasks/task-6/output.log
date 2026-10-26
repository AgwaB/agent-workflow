<control>{
  "schema": "stage-control-v1",
  "digest": "Partial coverage: recorder happy paths and replay fixtures are mapped, but loader activation, serialization breadth, and recording-failure behavior lack targeted tests. No validation was executed.",
  "coverageStatus": "partial",
  "coveredAreas": [
    {
      "area": "Direct recorder behavior",
      "evidence": "test/unit/replay-self-consistency.test.mjs:217-257",
      "coverage": "Disabled-mode object identity; synchronous success; asynchronous success/rejection; sequence and sync flags; callback/AbortSignal placeholders; error fields; sorted method inventory.",
      "status": "inspected-not-run"
    },
    {
      "area": "Recording-format consumers",
      "evidence": "test/unit/replay-self-consistency.test.mjs:137-215; test/replay/fixtures",
      "coverage": "Three fixtures exercise normalized engine replay, expected terminal states, effectful-call consumption, manifest bindings, snapshot consistency, and rejection of a changed launch.",
      "limitation": "Replay clears the recording environment variable and injects an API, bypassing the changed loader."
    },
    {
      "area": "Adjacent backend and installed API",
      "evidence": "test/unit/subagent-extension-preflight.test.mjs; test/unit/runtime-bundled-api-boundary.test.mjs",
      "coverage": "One-shot forwarding, extension isolation, installed API availability, and local barrier arbitration.",
      "limitation": "Injected APIs and direct dependency imports do not exercise recorder-enabled backend loading."
    },
    {
      "area": "Build and distribution checks",
      "evidence": "package.json; .github/workflows/ci.yml; test/e2e/cases/packed-web-loader.mjs",
      "coverage": "Build/typechecking, full unit suite, packed imports, CLI smoke, and package inventory checks are defined.",
      "limitation": "No recorder-enabled packed-consumer assertion or fresh execution evidence was located."
    }
  ],
  "missingValidation": [
    {
      "id": "loader-activation",
      "priority": "high",
      "action": "Add isolated backend integration tests for real dynamic-import wrapping with recording enabled and disabled; verify trimmed/blank configuration, cached configuration reuse, cache reset, and injected-API bypass while recording is enabled."
    },
    {
      "id": "failure-semantics",
      "priority": "high",
      "action": "Define and test directory creation, surface write, append, and projection failures. Assert whether recording failures may prevent API invocation or replace an API success/original error."
    },
    {
      "id": "forwarding-and-surface",
      "priority": "medium",
      "action": "Test synchronous throws and exact error identity, original argument/receiver binding, return-value identity including undefined, constructor/value passthrough, and optional methods that are present but never called."
    },
    {
      "id": "serializer",
      "priority": "medium",
      "action": "Add table-driven toRecordable tests for sorted keys, undefined/null handling, nonfinite numbers, buffers/views, dates, promises, streams, symbols/bigints, Map/Set, shared references/cycles, and Error.failureKind. Include invalid dates, throwing getters, and self-referential error metadata."
    },
    {
      "id": "concurrency-and-directory-reuse",
      "priority": "medium",
      "action": "Use deferred promises to test out-of-order completion and exactly one outcome record per call. Test existing recording directories and multiple wrappers/processes, asserting the intended sequence and surface-overwrite policy or explicitly enforcing single-writer use."
    },
    {
      "id": "packed-activation",
      "priority": "medium",
      "action": "Extend the offline packed-consumer smoke with recorder-enabled backend loading and recording-file assertions. Verify both source and compiled recorder files are packaged."
    },
    {
      "id": "execution-evidence",
      "priority": "high",
      "action": "Run the focused suite and repository validation gates against a fresh build. Existing fixtures and dist files are not evidence of passing checks for this checkout."
    }
  ],
  "recommendedCommands": [
    {
      "command": "npm run build && node --test test/unit/replay-self-consistency.test.mjs",
      "purpose": "Focused recorder checks and all three fixture replays against fresh dist.",
      "status": "not-run"
    },
    {
      "command": "npm run validate",
      "purpose": "Typechecking, script/release/public-surface checks, fresh builds, and full unit regression suite.",
      "status": "not-run"
    },
    {
      "command": "npm run e2e",
      "purpose": "Offline runtime and packed-consumer smoke checks; run after the fresh build/validate gate.",
      "status": "not-run"
    },
    {
      "command": "npm run pack:dry",
      "purpose": "Inspect package contents for the recorder source and compiled outputs; this command skips build scripts.",
      "status": "not-run"
    }
  ],
  "assumptions": [
    {
      "statement": "The supplied diff defines the assessed range and two-file scope; related tests and tooling were inspected only as validation evidence."
    },
    {
      "statement": "Coverage describes inspected assertions, not passing execution results. No commands were run and no files were modified."
    },
    {
      "statement": "Commands assume installed dependencies; a clean checkout requires npm ci --legacy-peer-deps. The mapped CI matrix uses Node 22.19.0 and 24 on Ubuntu and macOS."
    },
    {
      "statement": "The requested root schemas/validation-impact-control.schema.json was absent. The workflow-local copy at workflows/impact-review/schemas/validation-impact-control.schema.json was read; required fields, enum, and object-array types were checked manually without executing a validator."
    }
  ]
}</control>

<analysis>
Coverage is partial, with high confidence in the mapped assertions but no execution confidence. Both required upstream controls were read completely through the public `$` projection: change-scope returned 6,025 characters and validation-map returned 9,518, neither truncated.

The direct recorder test covers useful basic behavior, but the only backend modification—wrapping the dynamically imported API before caching—is not exercised by that test. The replay suite explicitly removes PI_WORKFLOW_RECORD_DIR and uses setSubagentApiForTests, whose early return bypasses recording. Adjacent backend tests also inject fakes, while installed-boundary tests import pi-subagent directly. Consequently, these suites could pass even if backend recorder activation were broken.

The three fixtures provide valuable downstream compatibility checks. Minimal and deep-review expect completion; spec-review deliberately expects failure. Replay compares normalized artifact trees, checks effectful-call consumption, and independently verifies manifest bindings. These are stronger checks than terminal-status assertions alone, but they do not regenerate recordings or establish current recorder transparency. The test header mentions minimal plus four bundled workflows, whereas only three fixtures are present; coverage should follow the actual inventory.

The largest remaining behavioral risks are on the enabled path. Projection occurs before invocation, and synchronous recording writes occur during initialization and outcome handling. Exceptions there can change whether the API runs or which result/error reaches its caller. Tests should establish the intended failure policy rather than assume recording is observational. Constructor/value identity, uncalled optional exports, synchronous throws, and most serializer branches also remain unasserted.

Concurrency needs an explicit test: sequence numbers track invocation order, whereas physical JSONL entries are appended on completion. The existing readCalls helper sorts by sequence, so assertions using it alone cannot verify physical append order. Reused directories additionally retain earlier calls while each wrapper restarts its counter and overwrites surface metadata.

The recommended commands cover existing regression and distribution gates, but cannot close missing assertions without additional tests. Build first: recorder/replay tests import dist, and pack:dry ignores build scripts. Ignored internal recording drivers are not a reproducible checkout-level validation dependency.
</analysis>

<refs>[
  {
    "source": "impact-analysis.change-scope",
    "artifact": "control",
    "path": "$",
    "originalChars": 6025,
    "charsTruncated": false
  },
  {
    "source": "impact-analysis.validation-map",
    "artifact": "control",
    "path": "$",
    "originalChars": 9518,
    "charsTruncated": false
  },
  {
    "file": "src/subagent-backend.ts",
    "lines": "484-505",
    "evidence": "Injection bypass, cached dynamic import, and recording activation."
  },
  {
    "file": "src/subagent-api-recorder.ts",
    "lines": "24-197",
    "evidence": "Environment gating, projection branches, filesystem writes, forwarding, and surface inventory."
  },
  {
    "file": "test/unit/replay-self-consistency.test.mjs",
    "lines": "44-55,137-257",
    "evidence": "Recording disabled during injected replay; fixture assertions and direct recorder coverage."
  },
  {
    "file": "test/replay/replay-subagent-api.mjs",
    "lines": "77-83,123-249",
    "evidence": "Sequence-sorted reading and replay matching/consumption behavior."
  },
  {
    "files": [
      "test/replay/fixtures/minimal/fixture.json",
      "test/replay/fixtures/deep-review/fixture.json",
      "test/replay/fixtures/spec-review/fixture.json"
    ],
    "evidence": "Actual fixture inventory, provenance, and expected outcomes."
  },
  {
    "files": [
      "test/unit/subagent-extension-preflight.test.mjs",
      "test/unit/runtime-bundled-api-boundary.test.mjs"
    ],
    "evidence": "Adjacent coverage bypasses recorder-enabled backend loading."
  },
  {
    "files": [
      "package.json",
      ".github/workflows/ci.yml",
      "test/e2e/cases/packed-web-loader.mjs"
    ],
    "evidence": "Validation commands, build prerequisites, CI matrix, and packed-consumer smoke scope."
  },
  {
    "file": "workflows/impact-review/schemas/validation-impact-control.schema.json",
    "evidence": "Manually checked control structure against the available workflow-local schema."
  }
]</refs>