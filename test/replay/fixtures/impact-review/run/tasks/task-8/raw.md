<control>{
  "schema": "stage-control-v1",
  "digest": "Medium, opt-in impact: additional sensitive-data retention, synchronous recording overhead, API failure coupling, and mixed-session trace risks; disabled behavior remains unchanged.",
  "status": "medium",
  "impacts": [
    {
      "id": "default-path",
      "areas": ["security", "performance", "reliability"],
      "severity": "none",
      "condition": "Recording variable unset or blank",
      "summary": "Original API identity is retained; no recording files are written.",
      "evidence": ["recorder", "loader"]
    },
    {
      "id": "sensitive-records",
      "areas": ["security", "privacy"],
      "severity": "medium",
      "condition": "Recording enabled for sensitive workloads",
      "summary": "Arguments, outcomes, and error messages receive an additional plaintext copy without redaction, retention limits, or explicit restrictive permissions.",
      "evidence": ["recorder", "launch-options", "portable-copy"]
    },
    {
      "id": "failure-coupling",
      "areas": ["reliability"],
      "severity": "medium",
      "condition": "Recording initialization, serialization, or append fails",
      "summary": "Recorder failures can prevent API calls, reject successful operations, replace original errors, or poison the cached API-load promise.",
      "evidence": ["recorder", "loader", "launch-options"]
    },
    {
      "id": "hot-path-cost",
      "areas": ["performance", "reliability"],
      "severity": "medium",
      "condition": "Recording enabled, especially with large payloads or frequent polling",
      "summary": "Recursive projection and synchronous file appends block the event loop; recording size and serialization depth are unbounded.",
      "evidence": ["recorder", "refresh-polls"]
    },
    {
      "id": "trace-isolation",
      "areas": ["observability", "reliability"],
      "severity": "medium",
      "condition": "A recording directory is reused or shared by multiple wrappers or processes",
      "summary": "Appended calls have wrapper-local sequence numbers while surface metadata is overwritten; replay sorts only by sequence and can mix sessions.",
      "evidence": ["recorder", "replay-reader", "worker-environment"]
    },
    {
      "id": "observation-limits",
      "areas": ["observability"],
      "severity": "low",
      "condition": "Recordings used for diagnostics or reference replay",
      "summary": "Structured outcomes and full method metadata improve reproducibility, but unfinished calls are absent, values are lossy, and endedAt excludes final serialization and write overhead.",
      "evidence": ["recorder", "recorder-test"]
    }
  ],
  "assumptions": [
    {
      "id": "scope",
      "statement": "The supplied diff defines b83cc4f..7e813aa; related unchanged files were inspected only to establish impact."
    },
    {
      "id": "activation",
      "statement": "Environment configuration is operator-controlled. It is evaluated at initial cached API loading; injected test APIs bypass the seam."
    },
    {
      "id": "verification",
      "statement": "Assessment used read-only inspection. Tests, benchmarks, and fault-injection scenarios were not executed."
    },
    {
      "id": "source-completeness",
      "statement": "Both required upstream control artifacts were read through complete, non-truncated path=$ projections."
    },
    {
      "id": "schema-validation",
      "statement": "The requested ./schemas/api-contract-impact-control.schema.json was absent. Required fields, types, and severity enum were checked manually against the repository copy at workflows/impact-review/schemas/api-contract-impact-control.schema.json; no executable validator was run."
    }
  ]
}</control>

<analysis>
Overall severity is medium because the consequential behavior requires explicit recording activation. With the variable unset or blank, the real API object is returned unchanged. No new remote execution or authorization bypass is demonstrated by this change.

- Security and privacy: launch arguments contain the compiled task and system prompt, paths, identifiers, and durable-barrier descriptors. These are copied into calls.jsonl alongside projected results and error messages. Nonserializable markers are not redaction: ordinary sensitive strings remain intact. Although prompts already exist in workflow artifacts, this creates another copy in an independently configured location. Permissions depend on the umask and existing directory protections; recordings have no cleanup policy. Portable-copy tooling rewrites host paths, not arbitrary secrets. Use a trusted private directory, restrictive permissions, content review before fixture publication, and explicit retention/redaction rules. Removing the environment variable after initialization does not disable the cached wrapper.

- Reliability: recording is part of the API success/error path rather than an isolated observer. An append failure after successful runSubagent execution can reject the call after a worker has been created, before the backend records its returned handle. Existing durable-launch and recovery mechanisms constrain the consequences, so duplicate execution is not established. Recording an original exception can instead throw a filesystem or projection error, masking its cause. Initialization failures remain cached as a rejected load promise. Argument projection also occurs before the invocation try block; throwing getters or an invalid Date can prevent invocation. Separate recorder health from API outcomes and define whether recording failure should stop the run or degrade recording explicitly.

- Performance: each completed API operation performs synchronous projection, JSON serialization, and append on the event loop. Already-projected arguments are traversed again when the complete entry is projected. Refresh performs both reconcile and status calls per polled task, multiplying this overhead. There are no payload, depth, file-size, or rotation limits. Large workloads or slow recording storage can delay polling, cancellation, and timers; asynchronous operation timeouts cannot interrupt synchronous filesystem blocking. Introduce bounded recording and measure event-loop delay and polling latency before enabling this broadly.

- Trace isolation: directory reuse preserves previous calls while restarting seq at one and overwriting api-surface.json. The replay reader sorts by seq without partitioning by pid or recording session. Even perfectly atomic appends therefore do not prevent mixed-session ordering and replay contamination. Worker processes inherit the variable; additional writers are possible if descendants load this backend, but were not demonstrated. Prefer a fresh directory per session, or explicit session identity and partitioned replay.

- Observability: timestamps, sequence numbers, outcomes, and complete method-surface metadata are useful for reference recordings and feature detection. However, entries appear only after completion: crashes and hangs leave no invocation record. Error stack/cause information and callback activity are omitted, and endedAt is calculated before final projection and append. Treat these as lossy replay inputs, not a complete audit trail or precise measurement of caller-visible latency.

The inspected recorder test covers disabled identity, ordinary synchronous/asynchronous success, asynchronous rejection, and basic projection markers. It does not establish filesystem-failure isolation, bounded overhead, or session isolation. Targeted tests for failed appends after successful launches, initialization failure, reused directories, and large/deep payloads would address the principal uncertainties.
</analysis>

<refs>[
  {
    "id": "scope-source",
    "kind": "workflow-artifact",
    "source": "impact-analysis.change-scope",
    "artifact": "control",
    "path": "$",
    "originalChars": 6025,
    "truncated": false
  },
  {
    "id": "implementation-source",
    "kind": "workflow-artifact",
    "source": "impact-analysis.implementation-map",
    "artifact": "control",
    "path": "$",
    "originalChars": 10271,
    "truncated": false
  },
  {
    "id": "recorder",
    "path": "src/subagent-api-recorder.ts",
    "lines": "24-197",
    "symbols": ["recordDirFromEnv", "toRecordable", "createRecordingSubagentApi", "maybeRecordSubagentApi"]
  },
  {
    "id": "loader",
    "path": "src/subagent-backend.ts",
    "lines": "484-505",
    "symbols": ["loadSubagentApi", "cachedSubagentApi"]
  },
  {
    "id": "launch-options",
    "path": "src/subagent-backend.ts",
    "lines": ["3152-3177", "3300-3315"]
  },
  {
    "id": "refresh-polls",
    "path": "src/subagent-backend.ts",
    "lines": "4090-4134",
    "symbols": ["pollSubagentForRefresh"]
  },
  {
    "id": "replay-reader",
    "path": "test/replay/replay-subagent-api.mjs",
    "lines": "75-81",
    "symbols": ["readCalls"]
  },
  {
    "id": "worker-environment",
    "path": "node_modules/@agwab/pi-subagent/src/orchestrate/async.ts",
    "lines": "316-334"
  },
  {
    "id": "portable-copy",
    "path": "internal/record/make-portable.mjs",
    "lines": "1-31"
  },
  {
    "id": "recorder-test",
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": "238-278"
  },
  {
    "id": "control-contract",
    "path": "workflows/impact-review/schemas/api-contract-impact-control.schema.json",
    "verification": "Manual structural validation"
  }
]</refs>