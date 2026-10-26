<control>{
  "schema": "stage-control-v1",
  "digest": "Two-file, opt-in pi-subagent API recording change affecting the shared backend loader, lifecycle calls, and replay inputs.",
  "changeSummary": "Adds an environment-gated recorder around the real @agwab/pi-subagent/api module. Recording writes call outcomes and API-surface metadata; unset or blank configuration preserves the original API object, and injected test APIs bypass recording.",
  "changeInputs": [
    {
      "kind": "supplied-diff",
      "range": "b83cc4f..7e813aa",
      "paths": [
        "src/subagent-backend.ts",
        "src/subagent-api-recorder.ts"
      ],
      "verification": "Both post-change files inspected; git history not independently queried."
    }
  ],
  "affectedFiles": [
    {
      "path": "src/subagent-api-recorder.ts",
      "change": "added",
      "lines": "1-197",
      "symbols": [
        "recordDirFromEnv",
        "Recordable",
        "toRecordable",
        "createRecordingSubagentApi",
        "maybeRecordSubagentApi"
      ],
      "responsibility": "Environment gating, JSON projection, API wrapping, and synchronous recording-file writes."
    },
    {
      "path": "src/subagent-backend.ts",
      "change": "modified",
      "lines": "56,497-505",
      "symbols": [
        "loadSubagentApi"
      ],
      "responsibility": "Applies maybeRecordSubagentApi to the dynamically imported real API before caching it.",
      "evidence": "if (injectedSubagentApi) return injectedSubagentApi;"
    }
  ],
  "affectedComponents": [
    {
      "component": "API loading and cache",
      "paths": [
        "src/subagent-backend.ts:484-505"
      ],
      "impact": "Recording configuration is evaluated when the cached real API is initialized. Later environment changes do not reconfigure an existing cached API."
    },
    {
      "component": "Headless workflow lifecycle",
      "paths": [
        "src/backend.ts:74-114",
        "src/subagent-backend.ts:2789-2870",
        "src/subagent-backend.ts:3071-3280",
        "src/subagent-backend.ts:4090-4134",
        "src/subagent-backend.ts:6627-6630"
      ],
      "impact": "Enabled recording covers capability checks, launches, durable-barrier operations, reconciliation, status polling, and interruption through the shared API.",
      "relatedEntrypoints": [
        "prepareSubagentTaskLaunch",
        "launchSubagentTask",
        "refreshRunFromSubagentArtifacts",
        "interruptSubagentTask",
        "cleanupSubagentRun"
      ]
    },
    {
      "component": "One-shot routing and parent-child events",
      "paths": [
        "src/subagent-backend.ts:550-559",
        "src/subagent-backend.ts:710-742",
        "src/workflow-router.ts:1499-1530"
      ],
      "impact": "The same loader also records one-shot auto-routing calls and optional parent-child event calls, not only scheduled workflow tasks."
    },
    {
      "component": "Recording persistence and serialization",
      "paths": [
        "src/subagent-api-recorder.ts:55-187"
      ],
      "impact": "Adds synchronous filesystem work and lossy JSON projection on the API execution path. Recording errors are not isolated from API outcomes."
    },
    {
      "component": "Replay and test consumers",
      "paths": [
        "test/replay/replay-subagent-api.mjs:61-67",
        "test/replay/replay-subagent-api.mjs:111-249",
        "test/unit/replay-self-consistency.test.mjs:109-115",
        "test/unit/replay-self-consistency.test.mjs:217-257"
      ],
      "changed": false,
      "impact": "Existing replay helpers consume calls.jsonl and api-surface.json. The direct recorder test exercises disabled mode, synchronous success, asynchronous success/rejection, and function/AbortSignal projection."
    }
  ],
  "publicSurfaces": [
    {
      "kind": "environment",
      "name": "PI_WORKFLOW_RECORD_DIR",
      "path": "src/subagent-api-recorder.ts:20-29",
      "behavior": "A trimmed nonempty value enables recording to that directory; unset or whitespace-only values disable it."
    },
    {
      "kind": "filesystem-format",
      "name": "calls.jsonl",
      "path": "src/subagent-api-recorder.ts:129-182",
      "fields": [
        "seq",
        "method",
        "pid",
        "startedAt",
        "args",
        "sync",
        "result or error",
        "endedAt"
      ],
      "behavior": "Appends an entry on synchronous exit or promise settlement. Sequence numbers are local to each wrapper."
    },
    {
      "kind": "filesystem-format",
      "name": "api-surface.json",
      "path": "src/subagent-api-recorder.ts:137-146",
      "fields": [
        "methods",
        "constructors",
        "values"
      ],
      "behavior": "Overwritten during wrapper creation with sorted enumerable export names, including methods never invoked."
    },
    {
      "kind": "internal-module-exports",
      "path": "src/subagent-api-recorder.ts",
      "names": [
        "PI_WORKFLOW_RECORD_DIR_ENV",
        "RECORDED_CALLS_FILE",
        "RECORDED_SURFACE_FILE",
        "recordDirFromEnv",
        "Recordable",
        "toRecordable",
        "createRecordingSubagentApi",
        "maybeRecordSubagentApi"
      ],
      "packageRootExportAdded": false
    },
    {
      "kind": "dependency-boundary",
      "name": "@agwab/pi-subagent/api",
      "path": "src/subagent-backend.ts:484-505",
      "behavior": "All enumerable function exports except syntactically detected ES classes are wrapped; nonfunction values and detected classes retain their identities."
    }
  ],
  "assumptions": [
    {
      "id": "range",
      "statement": "The supplied diff defines the assessed change, and the working tree is at 7e813aa as stated by the task."
    },
    {
      "id": "schema-validation",
      "statement": "The requested ./schemas/change-scope-control.schema.json was absent. The repository copy at workflows/impact-review/schemas/change-scope-control.schema.json was read, and this control object's required fields and types were checked manually against it; no executable validator was run."
    },
    {
      "id": "verification",
      "statement": "This is read-only scope analysis. Tests, builds, and runtime recording were not executed."
    },
    {
      "id": "compatibility",
      "statement": "Forwarding preserves ordinary values and original invocation arguments when projection and recording succeed; complete behavioral transparency under recording is not assumed."
    }
  ],
  "outOfScope": [
    {
      "scope": "Changes elsewhere in b83cc4f..7e813aa",
      "reason": "Assessment is limited to the two supplied paths; related files were inspected only to trace impact."
    },
    {
      "scope": "Changes to workflow specs, CLI options, package exports, dependency versions, or worker implementation",
      "reason": "None are present in the supplied two-file diff."
    },
    {
      "scope": "Full replay fidelity or exhaustive defect assessment",
      "reason": "Replay consumers and compatibility considerations are mapped, but their complete correctness is not established by this stage."
    },
    {
      "scope": "Direct capture of child-process internals, streamed events, or callback invocations",
      "reason": "The seam records exported API calls and projected outcomes, not downstream execution independently."
    }
  ]
}</control>

<analysis>
The changed lines are narrow, but the enabled-mode reach is broad: `loadSubagentApi()` is the shared boundary for launch preparation, execution, durable-launch coordination, polling, cancellation, one-shot routing, and parent-child events. Unset or blank configuration returns the real module unchanged. Injected test APIs return before the recording seam, so injection-based lifecycle tests do not exercise loader integration.

Recording is selected during cached API initialization—not per workflow or per call. Initialization creates the directory, opens the append-only call log, and overwrites surface metadata. Function calls receive their original arguments via `fn.apply(real, args)`; detected ES classes and nonfunction exports pass through. Asynchronous functions return a chained promise, and entries are appended at settlement, so physical line order can differ from invocation sequence. Calls that never settle have no completed record.

The main follow-up impact areas are:

- **Reliability and latency:** projection and synchronous filesystem writes execute directly on the API path without best-effort isolation. Initialization failures can reject the cached loader promise; append failures can replace successful results or original errors. Argument projection occurs before the underlying function is called.
- **Recording ownership:** `seq` resets per wrapper, calls append to existing files, and surface metadata is overwritten. Reused or shared directories therefore need examination for recording isolation; a process-global sequence or cross-process ownership mechanism is not present.
- **Data handling:** launch arguments include compiled task prompts, system prompts, model configuration, and host paths. Ordinary strings are recorded without redaction or size limits. Projection intentionally loses information: callbacks/signals become markers, error stacks are omitted, and nullish results are recorded as null.
- **Compatibility:** the wrapper copies enumerable exports into a plain object and detects constructors using class-source syntax. These are narrower guarantees than preserving every possible module/object characteristic.

The inspected recorder test covers basic forwarding and serialization. It directly constructs a fake wrapped API, rather than exercising the dynamic-import/cache path, and does not demonstrate filesystem-failure handling, shared-directory behavior, concurrent settlement ordering, or constructor preservation.

Confidence is high in the two-file scope and traced consumers. Runtime correctness remains unverified.
</analysis>

<refs>[
  {
    "path": "src/subagent-backend.ts",
    "lines": "484-505",
    "quote": "cachedSubagentApi ??= import(subagentApiSpecifier).then((mod) => maybeRecordSubagentApi(mod as SubagentApi),"
  },
  {
    "path": "src/subagent-api-recorder.ts",
    "lines": "24-29,190-197",
    "quote": "return recordDir ? createRecordingSubagentApi(real, recordDir) : real;"
  },
  {
    "path": "src/subagent-api-recorder.ts",
    "lines": "55-118",
    "symbol": "toRecordable"
  },
  {
    "path": "src/subagent-api-recorder.ts",
    "lines": "121-150",
    "quote": "let seq = 0;"
  },
  {
    "path": "src/subagent-api-recorder.ts",
    "lines": "153-187",
    "quote": "result = fn.apply(real, args);"
  },
  {
    "path": "src/backend.ts",
    "lines": "74-114",
    "symbol": "subagentHeadlessBackend"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": "3071-3280",
    "quote": "task: compiledTask.compiledPrompt,"
  },
  {
    "path": "src/subagent-backend.ts",
    "lines": "2789-2870,4090-4134",
    "symbols": [
      "interruptSubagentTask",
      "pollSubagentForRefresh"
    ]
  },
  {
    "path": "src/workflow-router.ts",
    "lines": "1499-1530",
    "quote": "const envelope = await runOneShotSubagentCall({"
  },
  {
    "path": "test/replay/replay-subagent-api.mjs",
    "lines": "61-67,111-249",
    "symbols": [
      "readCalls",
      "createReplaySubagentApi"
    ]
  },
  {
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": "217-257",
    "quote": "recording seam forwards calls, records them as JSON lines, and is inert without PI_WORKFLOW_RECORD_DIR"
  },
  {
    "path": "package.json",
    "lines": "34-38",
    "quote": "\".\": \"./dist/index.js\""
  },
  {
    "path": "src/index.ts",
    "lines": "1-239",
    "observation": "No recorder re-export."
  },
  {
    "path": "workflows/impact-review/schemas/change-scope-control.schema.json",
    "observation": "Available repository schema requires the emitted control fields and object-array types."
  }
]</refs>