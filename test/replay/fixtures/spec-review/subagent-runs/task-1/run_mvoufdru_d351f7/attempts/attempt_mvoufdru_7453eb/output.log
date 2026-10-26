<control>{
  "schema": "stage-control-v1",
  "digest": "Extracted 21 requirements covering launch signals, stop errors and polling, cancellation recognition, and terminal summaries.",
  "specSources": [
    "<ROOT>/SPEC.md"
  ],
  "requirements": [
    {
      "id": "REQ-001",
      "requirement": "bindWorkflowLaunchSignal(cwd, runId, signal) registers the signal under workflowRunPath(cwd, runId); without a signal it returns a no-op unbind function.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 8,
        "lineEnd": 10,
        "quote": "1. `bindWorkflowLaunchSignal(cwd, runId, signal)` registers an abort signal for\n   the run keyed by `workflowRunPath(cwd, runId)`. With no signal it returns a\n   no-op unbind function."
      },
      "priority": "high",
      "implementationSignals": [
        "bindWorkflowLaunchSignal",
        "workflowRunPath",
        "Run-keyed signal registration"
      ],
      "testSignals": [
        "Different run paths isolate registered signals",
        "Missing signal returns callable no-op unbind"
      ]
    },
    {
      "id": "REQ-002",
      "requirement": "The returned unbind function removes only its registered signal and deletes the run registration when its last signal is removed.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 11,
        "lineEnd": 12,
        "quote": "2. The returned unbind function removes only that signal. When the last signal\n   for a run is removed, the run's registration is deleted."
      },
      "priority": "high",
      "implementationSignals": [
        "Per-signal unbind closure",
        "Empty run registration cleanup"
      ],
      "testSignals": [
        "Unbinding one signal preserves another signal",
        "Unbinding last signal removes registration"
      ]
    },
    {
      "id": "REQ-003",
      "requirement": "A run has a launch stop request when any signal registered for that run is aborted.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 13,
        "lineEnd": 14,
        "quote": "3. A run counts as \"launch stop requested\" when any registered signal for it is\n   aborted."
      },
      "priority": "high",
      "implementationSignals": [
        "Registered signals aborted-state lookup"
      ],
      "testSignals": [
        "One aborted signal among live signals requests stop",
        "Only non-aborted signals do not request stop"
      ]
    },
    {
      "id": "REQ-004",
      "requirement": "createWorkflowStopRequestedError(runId) returns an Error named WorkflowStopRequested with the exact message workflow stop requested for <runId>.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 18,
        "lineEnd": 19,
        "quote": "4. `createWorkflowStopRequestedError(runId)` returns an `Error` named\n   `WorkflowStopRequested` with message `workflow stop requested for <runId>`."
      },
      "priority": "medium",
      "implementationSignals": [
        "createWorkflowStopRequestedError",
        "Error name and message construction"
      ],
      "testSignals": [
        "Result is an Error",
        "Exact error name and run-specific message"
      ]
    },
    {
      "id": "REQ-005",
      "requirement": "isWorkflowStopRequestedError(error) returns true for an Error named WorkflowStopRequested or with a message starting with workflow stop requested, and false for non-errors.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 20,
        "lineEnd": 21,
        "quote": "5. `isWorkflowStopRequestedError(error)` is true for an `Error` with that name or\n   whose message starts with `workflow stop requested`; false for non-errors."
      },
      "priority": "high",
      "implementationSignals": [
        "isWorkflowStopRequestedError",
        "Error instance guard",
        "Name or message-prefix recognition"
      ],
      "testSignals": [
        "Matching name with unrelated message",
        "Matching message prefix with another name",
        "Non-error objects and strings return false",
        "Unrelated Error returns false"
      ]
    },
    {
      "id": "REQ-006",
      "requirement": "createWorkflowStopPendingError(message) returns an Error named WorkflowStopPending; isWorkflowStopPendingError recognizes exactly that name.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 22,
        "lineEnd": 23,
        "quote": "6. `createWorkflowStopPendingError(message)` returns an `Error` named\n   `WorkflowStopPending`; `isWorkflowStopPendingError` recognizes exactly that name."
      },
      "priority": "medium",
      "implementationSignals": [
        "createWorkflowStopPendingError",
        "isWorkflowStopPendingError",
        "Exact WorkflowStopPending name comparison"
      ],
      "testSignals": [
        "Constructor returns Error with exact name",
        "Matching name is recognized",
        "Other names are rejected"
      ]
    },
    {
      "id": "REQ-007",
      "requirement": "throwIfWorkflowStopRequested(cwd, runId) throws the stop-requested error when either a launch stop is requested or durable stop intent exists for the run.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 27,
        "lineEnd": 28,
        "quote": "7. `throwIfWorkflowStopRequested(cwd, runId)` throws the stop-requested error if a\n   launch stop is requested, or if a durable stop intent exists for the run."
      },
      "priority": "high",
      "implementationSignals": [
        "throwIfWorkflowStopRequested",
        "Launch signal check",
        "Durable stop-intent read"
      ],
      "testSignals": [
        "Launch abort alone throws stop-requested error",
        "Durable intent alone throws stop-requested error",
        "No stop source does not throw stop-requested error"
      ]
    },
    {
      "id": "REQ-008",
      "requirement": "throwIfWorkflowStopRequested re-checks launch signals after the durable stop-intent read completes.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 28,
        "lineEnd": 29,
        "quote": "It\n   re-checks launch signals after the durable read completes."
      },
      "priority": "high",
      "implementationSignals": [
        "Post-read launch signal check"
      ],
      "testSignals": [
        "Abort during pending durable read is observed"
      ]
    },
    {
      "id": "REQ-009",
      "requirement": "createWorkflowStopSignal(cwd, runId, {pollMs}) returns {signal, dispose}, checks immediately, and polls every pollMs milliseconds with a minimum of 10 and default of 50.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 30,
        "lineEnd": 32,
        "quote": "8. `createWorkflowStopSignal(cwd, runId, {pollMs})` returns `{signal, dispose}`.\n   It checks immediately and then every `pollMs` milliseconds (minimum 10,\n   default 50)."
      },
      "priority": "high",
      "implementationSignals": [
        "createWorkflowStopSignal",
        "Immediate stop check",
        "Polling interval normalization"
      ],
      "testSignals": [
        "Returned object exposes signal and dispose",
        "Initial check occurs without waiting for interval",
        "Omitted pollMs uses 50 milliseconds",
        "pollMs below 10 uses minimum 10 milliseconds"
      ]
    },
    {
      "id": "REQ-010",
      "requirement": "The signal returned by createWorkflowStopSignal aborts with the stop-requested error when a stop is requested.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 32,
        "lineEnd": 33,
        "quote": "When a stop is requested its signal aborts with the\n   stop-requested error."
      },
      "priority": "high",
      "implementationSignals": [
        "AbortController",
        "Stop-requested abort reason"
      ],
      "testSignals": [
        "Launch stop aborts returned signal",
        "Durable stop aborts returned signal",
        "Abort reason is the specified stop-requested error"
      ]
    },
    {
      "id": "REQ-011",
      "requirement": "createWorkflowStopSignal treats a failed durable read as no durable stop intent.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 33,
        "lineEnd": 33,
        "quote": "A failed durable read is treated as \"no intent\"."
      },
      "priority": "high",
      "implementationSignals": [
        "Durable-read failure handling in polling"
      ],
      "testSignals": [
        "Rejected durable read alone does not abort signal"
      ]
    },
    {
      "id": "REQ-012",
      "requirement": "Calling dispose() stops polling, and the poll timer must not keep the process alive.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 34,
        "lineEnd": 34,
        "quote": "`dispose()` stops polling. The poll timer must not keep the process alive."
      },
      "priority": "medium",
      "implementationSignals": [
        "Polling timer cleanup",
        "Non-process-retaining timer"
      ],
      "testSignals": [
        "No further scheduled polls after dispose",
        "Poll timer does not prevent process exit"
      ]
    },
    {
      "id": "REQ-013",
      "requirement": "isWorkflowAbortError(value) recognizes values named AbortError and does not recognize other names.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 38,
        "lineEnd": 38,
        "quote": "9. `isWorkflowAbortError(value)` is true only for values named `AbortError`."
      },
      "priority": "high",
      "implementationSignals": [
        "isWorkflowAbortError",
        "AbortError name recognition"
      ],
      "testSignals": [
        "AbortError name is recognized",
        "Other names are rejected"
      ]
    },
    {
      "id": "REQ-014",
      "requirement": "isWorkflowReturnedCancellation(value) recognizes cancelled: true at the top level or within details.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 39,
        "lineEnd": 40,
        "quote": "10. `isWorkflowReturnedCancellation(value)` recognizes `cancelled: true` (top\n    level or in `details`),"
      },
      "priority": "high",
      "implementationSignals": [
        "isWorkflowReturnedCancellation",
        "Top-level cancelled flag",
        "details.cancelled flag"
      ],
      "testSignals": [
        "Top-level cancelled true is recognized",
        "details.cancelled true is recognized"
      ]
    },
    {
      "id": "REQ-015",
      "requirement": "isWorkflowReturnedCancellation(value) recognizes aborted, AbortError, and ABORT_ERR cancellation markers in reasons and errors.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 39,
        "lineEnd": 41,
        "quote": "10. `isWorkflowReturnedCancellation(value)` recognizes `cancelled: true` (top\n    level or in `details`), `aborted`/`AbortError`/`ABORT_ERR` reasons and\n    errors"
      },
      "priority": "high",
      "implementationSignals": [
        "Cancellation reason recognition",
        "Cancellation error recognition",
        "aborted, AbortError, and ABORT_ERR markers"
      ],
      "testSignals": [
        "aborted reason or error is recognized",
        "AbortError reason or error is recognized",
        "ABORT_ERR reason or error is recognized"
      ]
    },
    {
      "id": "REQ-016",
      "requirement": "isWorkflowReturnedCancellation(value) recognizes JSON text content entries encoding any of the specified cancellation markers.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 41,
        "lineEnd": 41,
        "quote": "and JSON text content entries that encode one of these."
      },
      "priority": "high",
      "implementationSignals": [
        "JSON text content parsing",
        "Cancellation recognition on decoded content"
      ],
      "testSignals": [
        "JSON text encoding cancelled true is recognized",
        "JSON text encoding reason or error markers is recognized"
      ]
    },
    {
      "id": "REQ-017",
      "requirement": "isWorkflowReturnedCancellation must not classify arbitrary provider errors as cancellation.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 41,
        "lineEnd": 42,
        "quote": "Arbitrary\n    provider errors must not be treated as cancellation."
      },
      "priority": "high",
      "implementationSignals": [
        "Provider error classification",
        "Explicit cancellation marker requirement"
      ],
      "testSignals": [
        "Unrelated provider error returns false",
        "JSON text encoding unrelated provider error returns false"
      ]
    },
    {
      "id": "REQ-018",
      "requirement": "summarizeWorkflowTerminal(cwd, run) reports terminal, engineStatus, semanticStatus, outputTaskIds, retry totals, and artifactRoot.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 46,
        "lineEnd": 47,
        "quote": "11. `summarizeWorkflowTerminal(cwd, run)` reports `terminal`, `engineStatus`,\n    `semanticStatus`, `outputTaskIds`, retry totals, and `artifactRoot`."
      },
      "priority": "high",
      "implementationSignals": [
        "summarizeWorkflowTerminal",
        "Terminal summary fields",
        "Retry totals",
        "Artifact root reporting"
      ],
      "testSignals": [
        "Summary contains every specified report item",
        "Summary reflects supplied run"
      ]
    },
    {
      "id": "REQ-019",
      "requirement": "A completed run with degradation reports completed_degraded.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 48,
        "lineEnd": 48,
        "quote": "12. A completed run with degradation reports `completed_degraded`."
      },
      "priority": "high",
      "implementationSignals": [
        "Completed-run degradation classification",
        "completed_degraded status"
      ],
      "testSignals": [
        "Completed degraded run reports completed_degraded"
      ]
    },
    {
      "id": "REQ-020",
      "requirement": "Terminal direct-dynamic runs derive their semantic status from the dynamic controller's control.json.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 49,
        "lineEnd": 50,
        "quote": "13. Terminal direct-dynamic runs derive their semantic status from the dynamic\n    controller's `control.json`;"
      },
      "priority": "high",
      "implementationSignals": [
        "Terminal direct-dynamic branch",
        "Dynamic controller control.json read",
        "Semantic status derivation"
      ],
      "testSignals": [
        "Controller control.json determines semantic status",
        "Derivation applies to terminal direct-dynamic runs"
      ]
    },
    {
      "id": "REQ-021",
      "requirement": "An unreadable dynamic controller control.json for a terminal direct-dynamic run yields completed_without_semantic_result.",
      "specEvidence": {
        "file": "<ROOT>/SPEC.md",
        "lineStart": 50,
        "lineEnd": 51,
        "quote": "an unreadable control yields\n    `completed_without_semantic_result`."
      },
      "priority": "high",
      "implementationSignals": [
        "Unreadable controller control handling",
        "completed_without_semantic_result fallback"
      ],
      "testSignals": [
        "Unreadable controller control produces specified fallback"
      ]
    }
  ],
  "ambiguities": [
    "The spec does not define degradation, terminal detection, retry-total field names or aggregation, outputTaskIds selection, or artifactRoot derivation.",
    "The direct-dynamic controller lookup, control.json structure, semantic-status mapping, and meaning of unreadable are unspecified.",
    "Cancellation reason/error payload shapes and JSON text content entry structure are unspecified; recognition beyond the explicitly named markers is not established.",
    "pollMs handling for invalid or non-finite inputs, scheduling tolerances, and disposal during an in-flight read are unspecified.",
    "Failed durable-read behavior is specified for createWorkflowStopSignal, but not for throwIfWorkflowStopRequested.",
    "Duplicate registration of the same signal and the accepted value types for the pending-error recognizer are unspecified."
  ],
  "outOfScope": [
    "store.js and types.js are explicitly outside the sample (SPEC.md:3-4).",
    "The stated specification scope is src/workflow-stop.ts, src/workflow-cancellation.ts, and src/workflow-terminal.ts; unrelated src modules have no conformance requirements here."
  ]
}</control>

<analysis>
All 13 numbered specification clauses are represented by 21 requirements; none were omitted. Compound clauses were separated where independently testable behavior matters: the post-read launch-signal race, polling failure handling, cancellation representations, and unreadable terminal-control fallback.

Coverage:
- Lines 8–14: REQ-001–REQ-003, launch registration and lifecycle.
- Lines 18–23: REQ-004–REQ-006, error construction and recognition.
- Lines 27–34: REQ-007–REQ-012, stop checks, polling, disposal, and process lifetime.
- Lines 38–42: REQ-013–REQ-017, cancellation markers and false-positive exclusion.
- Lines 46–51: REQ-018–REQ-021, terminal summaries and dynamic-controller results.

Each evidence quote preserves an exact source substring, including embedded newlines and indentation. Citations use the full local SPEC.md path and verified line ranges. Signals are review/test hints, not claims that implementations or tests exist.

The requested ./schemas/spec-review-extract-spec-control.schema.json was absent. The matching workflow-bundled schema was found at .pi/workflows/workflow_mvoufde9_8566f1/bundle/schemas/spec-review-extract-spec-control.schema.json and inspected. The control object was manually checked against its required fields, types, enums, length limits, array limits, and closed requirement/evidence object shapes. No executable schema validator was available through the permitted tools.

Confidence is high in extraction completeness. The listed ambiguities should remain unresolved scope questions rather than become inferred implementation requirements. This stage establishes requirements only; it does not determine whether src/ conforms.
</analysis>

<refs>[]</refs>