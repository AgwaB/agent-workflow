<control>{
  "schema": "stage-control-v1",
  "digest": "Maps the env-gated recording wrapper, shared backend API loader, workflow lifecycle callers, recording artifacts, replay consumers, and build/test surfaces without assigning risk.",
  "components": [
    {
      "id": "api-loader",
      "changed": true,
      "path": "src/subagent-backend.ts",
      "symbols": ["SubagentApi", "loadSubagentApi", "cachedSubagentApi", "injectedSubagentApi", "setSubagentApiForTests"],
      "behavior": "The cached dynamic import of @agwab/pi-subagent/api now passes through maybeRecordSubagentApi. Injected APIs return before the recording seam. Resetting the test API also clears the cached import promise."
    },
    {
      "id": "recording-wrapper",
      "changed": true,
      "path": "src/subagent-api-recorder.ts",
      "exports": ["PI_WORKFLOW_RECORD_DIR_ENV", "RECORDED_CALLS_FILE", "RECORDED_SURFACE_FILE", "recordDirFromEnv", "Recordable", "toRecordable", "createRecordingSubagentApi", "maybeRecordSubagentApi"],
      "config": {
        "key": "PI_WORKFLOW_RECORD_DIR",
        "source": "process.env by default",
        "activation": "A nonempty value after trim enables recording."
      },
      "behavior": "Disabled mode returns the original API object. Enabled mode copies own enumerable string-keyed exports into a plain object, preserves values and class-syntax constructors, and wraps other functions using fn.apply(real, args)."
    },
    {
      "id": "recording-artifacts",
      "changed": true,
      "path": "src/subagent-api-recorder.ts",
      "artifacts": [
        {
          "name": "calls.jsonl",
          "fields": ["seq", "method", "pid", "startedAt", "args", "sync", "result or error", "endedAt"],
          "behavior": "Created without truncation and appended synchronously after return, throw, fulfillment, or rejection. Sequence numbers start at one for each wrapper; physical line order follows completion."
        },
        {
          "name": "api-surface.json",
          "fields": ["methods", "constructors", "values"],
          "behavior": "Overwritten at wrapper construction with sorted export-name arrays, including methods never called."
        }
      ],
      "dependencies": ["node:fs mkdirSync/writeFileSync/appendFileSync", "node:path join", "process.pid", "Date", "JSON.stringify"]
    },
    {
      "id": "json-projection",
      "changed": true,
      "path": "src/subagent-api-recorder.ts",
      "symbol": "toRecordable",
      "behavior": [
        "Sorts object keys; omits undefined object properties and projects undefined array entries as null.",
        "Marks functions, symbols, bigints, nonfinite numbers, AbortSignals, buffers/views, thenables, streams, and cycles with $nonSerializable.",
        "Projects Dates as ISO strings, Maps through Object.fromEntries, and Sets as arrays.",
        "Projects Errors to $error/name/message plus optional code/failureKind.",
        "Records null for nullish successful results while forwarding the original result value."
      ]
    },
    {
      "id": "workflow-backend",
      "changed": false,
      "paths": ["src/backend.ts", "src/engine.ts", "src/subagent-backend.ts"],
      "symbols": ["resolveWorkflowBackend", "prepareSubagentTaskLaunch", "launchSubagentTask", "refreshRunFromSubagentArtifacts", "interruptSubagentTask", "acknowledgeSubagentTaskInterrupted", "recordParentSubagentChildEvent"],
      "behavior": "The local-pi/headless backend and engine scheduling, refresh, cancellation, durable launch coordination, and parent-child reporting share the wrapped API."
    },
    {
      "id": "one-shot-router",
      "changed": false,
      "paths": ["src/workflow-router.ts", "src/subagent-backend.ts"],
      "symbols": ["runWorkflowAutoComparison", "runOneShotSubagentCall"],
      "behavior": "Auto-comparison launches also use the shared loader; their options include task/system prompt, model/thinking, tools, run paths, timeout, and AbortSignal."
    },
    {
      "id": "runtime-package",
      "changed": false,
      "paths": ["package.json", "node_modules/@agwab/pi-subagent/package.json", "node_modules/@agwab/pi-subagent/api.mjs"],
      "dependency": "@agwab/pi-subagent",
      "declaredVersion": "^0.7.2",
      "installedVersion": "0.7.2",
      "behavior": "The /api export resolves to api.mjs, which exposes runtime functions and three error constructors. Recording enumerates the complete runtime module, not only the narrower TypeScript SubagentApi interface."
    },
    {
      "id": "recording-replay-consumers",
      "changed": false,
      "paths": ["internal/record/run-minimal.mjs", "internal/record/run-bundled.mjs", "internal/record/capture-run.mjs", "internal/record/build-fixture.mjs", "internal/record/compact-calls.mjs", "internal/record/make-portable.mjs", "test/replay/replay-subagent-api.mjs", "test/replay/normalize.mjs", "test/replay/allowed-differences.json", "test/unit/replay-self-consistency.test.mjs"],
      "behavior": "Recording drivers enable the seam before driving dist/engine.js. Fixture tooling captures filesystem artifacts, rewrites host paths, and compacts observations. Replay consumes recorded calls and surface metadata through test API injection.",
      "existingFixtures": ["test/replay/fixtures/minimal", "test/replay/fixtures/deep-review", "test/replay/fixtures/spec-review"]
    },
    {
      "id": "build-and-package",
      "changed": false,
      "paths": ["package.json", "tsconfig.json", "src/index.ts"],
      "behavior": "src/**/*.ts includes the recorder in TypeScript builds and declarations. Published files include src and dist. The recorder is not re-exported from src/index.ts or given a package export subpath.",
      "commands": [
        "npm run typecheck",
        "npm run build",
        "npm run test:unit",
        "npm run build && node --test test/unit/replay-self-consistency.test.mjs"
      ]
    }
  ],
  "entryPoints": [
    {
      "id": "normal-load",
      "path": "src/subagent-backend.ts:497",
      "symbol": "loadSubagentApi",
      "activation": "First non-injected API load; subsequent callers reuse the cached promise and selected wrapper."
    },
    {
      "id": "explicit-wrapper",
      "path": "src/subagent-api-recorder.ts:123",
      "symbol": "createRecordingSubagentApi",
      "activation": "Direct internal/test import; always enables recording for the supplied directory."
    },
    {
      "id": "workflow-lifecycle",
      "path": "src/backend.ts:74",
      "symbols": ["prepareTaskLaunch", "launchTask", "refreshRun"],
      "callers": ["src/engine.ts:2752", "src/engine.ts:3335", "src/engine.ts:5335"],
      "apiMethods": ["supportsExplicitExtensionIsolation", "runSubagent", "reconcileSubagentRun", "getSubagentStatus"]
    },
    {
      "id": "durable-launch",
      "path": "src/subagent-backend.ts",
      "symbols": ["hasDurableLaunchBarrierApi", "launchSubagentTask", "reconcileDurableLaunchBarrierTask"],
      "apiMethods": ["createDurableLaunchBarrierV2", "durableLaunchBarrierDigest", "waitForDurableLaunchBarrierV2Ready", "resolveDurableLaunchBarrierV2Release", "revokeDurableLaunchBarrierV2", "readDurableLaunchBarrierV2State", "waitForDurableLaunchBarrierV2Ack"]
    },
    {
      "id": "cancellation-and-child-events",
      "path": "src/subagent-backend.ts",
      "symbols": ["interruptSubagentTask", "recordParentSubagentChildEvent"],
      "apiMethods": ["interruptSubagent", "getSubagentStatus", "recordSubagentChildEvent"]
    },
    {
      "id": "auto-comparison",
      "path": "src/workflow-router.ts:1499",
      "symbol": "runWorkflowAutoComparison",
      "via": "src/subagent-backend.ts:550 runOneShotSubagentCall"
    },
    {
      "id": "recorder-test",
      "path": "test/unit/replay-self-consistency.test.mjs:217",
      "behavior": "Checks disabled identity, sync success, async success/rejection, function/AbortSignal markers, Error code projection, and method-surface output."
    }
  ],
  "dataFlows": [
    {
      "id": "environment-to-api",
      "from": "process.env.PI_WORKFLOW_RECORD_DIR",
      "via": ["loadSubagentApi", "maybeRecordSubagentApi", "recordDirFromEnv"],
      "to": "Original module or cached recording wrapper",
      "details": "Directory selection occurs when the dynamic import resolves, not separately for every call."
    },
    {
      "id": "launch-to-record",
      "from": "Compiled task and prepared launch",
      "via": ["launchSubagentTask", "runSubagentWithWorkflowWorkerRole", "wrapped runSubagent"],
      "to": ["Real subagent API", "calls.jsonl"],
      "data": ["task/systemPrompt", "cwd/runsDir", "model/thinking", "tools/extensions/skills", "timeout", "correlation/session IDs", "durable launch descriptor", "tool-result budget"],
      "details": "Arguments are projected before invoking the real function. Returned envelopes and errors are projected when the call finishes."
    },
    {
      "id": "observations-and-control",
      "from": "Refresh, interruption, durable barrier, and parent-child event operations",
      "via": "Shared wrapped API",
      "to": ["Existing workflow state/artifact handling", "calls.jsonl"],
      "data": ["Run/attempt IDs", "status snapshots", "artifact paths", "barrier descriptors and digests", "cancellation details", "child-event usage"]
    },
    {
      "id": "completion-forwarding",
      "from": "Real function result or exception",
      "via": "Recorder append",
      "to": "Backend caller",
      "details": "Synchronous outcomes append before return/rethrow. Thenables return a chained then result that appends before forwarding fulfillment/rejection. Recorder filesystem and projection errors have no independent suppression boundary."
    },
    {
      "id": "recording-to-replay",
      "from": ["calls.jsonl", "api-surface.json", "Captured workflow/subagent files"],
      "via": ["Portable-path normalization", "Observation compaction", "readCalls", "createReplaySubagentApi"],
      "to": "Engine tests via setSubagentApiForTests",
      "details": "readCalls sorts by seq. Replay matches normalized method/arguments, derives sync behavior from records and known helpers, and exposes methods from surface metadata for feature detection."
    },
    {
      "id": "environment-to-worker",
      "from": "Parent process environment",
      "via": "Installed pi-subagent async launcher",
      "to": "Durable worker process environment",
      "details": "The launcher copies process.env into workerEnv; PI_WORKFLOW_RECORD_DIR is not removed at that boundary."
    }
  ],
  "unknowns": [
    {
      "id": "execution-evidence",
      "question": "Do typecheck, recorder tests, and replay tests pass for this checkout?",
      "status": "Not executed; this stage used read-only inspection."
    },
    {
      "id": "directory-ownership",
      "question": "Is a recording directory intended to belong to one wrapper/process/run, and can descendants load the backend with the inherited setting?",
      "evidence": "Calls append across directory reuse, surface metadata overwrites, and seq is wrapper-local; worker environment inheritance is present."
    },
    {
      "id": "exceptional-input-coverage",
      "question": "Which production API values exercise projection beyond the basic unit-test cases?",
      "evidence": "The inspected recorder test does not exercise constructors, cyclic Error metadata, getters/proxies, invalid Dates, Map/Set conversion, custom thenables, or filesystem failures."
    },
    {
      "id": "artifact-policy",
      "question": "What retention, permissions, sharing, and content-handling policy applies to recording directories?",
      "evidence": "The seam records projected argument/result content without redaction, truncation, explicit permission modes, or cleanup; portable-path rewriting is separate tooling."
    }
  ]
}</control>

<analysis>
The implementation boundary is the single shared `loadSubagentApi()` function. Consequently, the seam covers workflow task preparation and launch, polling/reconciliation, durable barrier operations, cancellation, optional parent-child reporting, and one-shot auto-comparison calls. Injected APIs bypass automatic wrapping; recording drivers explicitly wrap their fake APIs.

Enabled recording introduces two filesystem contracts: append-only completed-call records and an overwritten export-surface inventory. Invocation sequence and physical completion order are distinct. The wrapper preserves synchronous returns but chains asynchronous results. Serialization and filesystem operations occur directly on the forwarding path. These are implementation facts for downstream assessment, not risk classifications.

Replay depends on more than captured responses: complete method names preserve feature detection, `sync` preserves synchronous helpers, and separately captured filesystem trees reproduce API side effects. Existing recorder coverage checks the basic forwarding/projection contract; broader replay tests inject a replay API rather than exercising the real dynamic-import recording path.

The requested root-relative schema location was absent. The repository contains the workflow-local contract at `workflows/impact-review/schemas/implementation-map-control.schema.json`; its required fields and types were checked structurally against this control object. No executable validator, build, tests, or Git commands were run. Confidence is high for the inspected code relationships; runtime and exceptional-case behavior remain unverified.
</analysis>

<refs>[
  {
    "path": "workflows/impact-review/schemas/implementation-map-control.schema.json",
    "lines": [1, 46],
    "supports": "Control-object required fields and types"
  },
  {
    "path": "src/subagent-api-recorder.ts",
    "lines": [20, 197],
    "supports": "Configuration, exports, projection, wrapper forwarding, artifact writes"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [407, 565],
    "supports": "API interface, injection/cache lifecycle, wrapped import, one-shot launch"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [623, 744],
    "supports": "Worker-role launch and optional parent-child event reporting"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [2789, 2870],
    "supports": "Interruption and exact-attempt status acknowledgement"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [3071, 3249],
    "supports": "Durable API detection, barrier creation, launch-option content, real launch"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [3839, 4148],
    "supports": "Refresh reconciliation, concurrent polls, status processing"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": [6626, 6641],
    "supports": "Preparation-time API load and extension-isolation feature detection"
  },
  {
    "path": "src/backend.ts",
    "lines": [74, 123],
    "supports": "Headless backend registration and launch-error translation"
  },
  {
    "path": "src/workflow-router.ts",
    "lines": [1499, 1533],
    "supports": "Auto-comparison one-shot API caller and argument content"
  },
  {
    "path": "package.json",
    "supports": "Build/test commands, published files, package exports, dependency version"
  },
  {
    "path": "tsconfig.json",
    "supports": "NodeNext TypeScript compilation and src inclusion"
  },
  {
    "path": "node_modules/@agwab/pi-subagent/api.mjs",
    "supports": "Actual runtime export surface and error constructors"
  },
  {
    "path": "node_modules/@agwab/pi-subagent/src/orchestrate/async.ts",
    "lines": [316, 335],
    "supports": "Worker environment inheritance"
  },
  {
    "path": "internal/record/run-minimal.mjs",
    "lines": [23, 67],
    "supports": "Environment activation, built-engine driver, explicitly wrapped fake injection"
  },
  {
    "path": "internal/record/build-fixture.mjs",
    "supports": "Portable fixture construction and recording artifact consumers"
  },
  {
    "path": "test/replay/replay-subagent-api.mjs",
    "supports": "Sequence sorting, method/argument matching, sync restoration, surface-based API reconstruction"
  },
  {
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": [106, 259],
    "supports": "Replay injection, normalized-run comparisons, recorder unit coverage"
  },
  {
    "path": "test/replay/fixtures/minimal/record/api-surface.json",
    "supports": "Existing method/constructor/value artifact shape"
  }
]</refs>