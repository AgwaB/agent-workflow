<control>{
  "schema": "stage-control-v1",
  "digest": "Mapped all 13 spec items to the three source modules, identifying dependency boundaries and review-sensitive branches without judging conformance.",
  "implementationMap": [
    {
      "component": "Launch-signal registration and detection",
      "file": "src/workflow-stop.ts",
      "evidence": "L5: const launchSignals = new Map<string, Set<AbortSignal>>(); L12: if (!signal) return () => {}; L18–20 delete the signal and conditionally delete its registration.",
      "observedBehavior": "Registrations use workflowRunPath(cwd, runId) keys. Unbinding removes the supplied signal; an empty set is deleted only if still current. launchStopRequested tests whether any registered signal is aborted.",
      "relatedSignals": ["Launch signals", "bindWorkflowLaunchSignal", "launchStopRequested", "workflowRunPath"]
    },
    {
      "component": "Stop-requested error creation and recognition",
      "file": "src/workflow-stop.ts",
      "evidence": "L44: return `workflow stop requested for ${runId}`; L49 assigns WORKFLOW_STOP_REQUESTED_ERROR_NAME; L55–57 require instanceof Error and match name or message prefix.",
      "observedBehavior": "Creates Error instances named WorkflowStopRequested. Recognition requires an Error whose name matches or whose message starts with workflow stop requested.",
      "relatedSignals": ["Stop errors", "WorkflowStopRequested", "createWorkflowStopRequestedError", "isWorkflowStopRequestedError"]
    },
    {
      "component": "Stop-pending errors",
      "file": "src/workflow-stop.ts",
      "evidence": "L31: const WORKFLOW_STOP_PENDING_ERROR_NAME = \"WorkflowStopPending\"; L40: return error instanceof Error && error.name === WORKFLOW_STOP_PENDING_ERROR_NAME;",
      "observedBehavior": "Creates an Error using the supplied message and WorkflowStopPending name; recognition checks Error identity and that exact name.",
      "relatedSignals": ["Stop errors", "WorkflowStopPending", "createWorkflowStopPendingError", "isWorkflowStopPendingError"]
    },
    {
      "component": "Throwing stop checkpoint",
      "file": "src/workflow-stop.ts",
      "evidence": "L93–98 check launchStopRequested before readWorkflowStopIntent and then use: if (intent || launchStopRequested(cwd, runId))",
      "observedBehavior": "Checks launch signals before awaiting durable intent, then checks intent and launch signals again. Positive checks throw a stop-requested error. Durable read rejection is not caught here.",
      "relatedSignals": ["Stop checks", "throwIfWorkflowStopRequested", "readWorkflowStopIntent"]
    },
    {
      "component": "Polling stop signal and disposal",
      "file": "src/workflow-stop.ts",
      "evidence": "L67: const pollMs = Math.max(10, options.pollMs ?? 50); L74–76 catch durable-read failures; L80–85 call check immediately, setInterval, timer.unref?.(), and clearInterval.",
      "observedBehavior": "Returns an AbortController signal and timer disposer. Checks launch state before and after durable reads; positive checks abort with a stop-requested error. Read rejection becomes undefined. Disposal clears the interval, not an already-running check.",
      "relatedSignals": ["Stop checks", "createWorkflowStopSignal", "pollMs", "dispose", "readWorkflowStopIntent"]
    },
    {
      "component": "AbortError marker recognition",
      "file": "src/workflow-cancellation.ts",
      "evidence": "L3–5 check DOMException.name or return isRecord(value) && value.name === \"AbortError\"; L36 excludes null and arrays from records.",
      "observedBehavior": "Recognizes DOMExceptions and non-array objects with the exact AbortError name. Other values fail the record/name checks.",
      "relatedSignals": ["Cancellation markers", "isWorkflowAbortError", "AbortError"]
    },
    {
      "component": "Returned cancellation fields",
      "file": "src/workflow-cancellation.ts",
      "evidence": "L14–21 check isWorkflowAbortError(value), value.cancelled, details?.cancelled, and error/reason candidates against aborted, AbortError, ABORT_ERR, or isWorkflowAbortError.",
      "observedBehavior": "Accepts top-level abort objects, exact true cancellation flags, and recognized top-level/details error or reason markers. Unrecognized values proceed to content inspection and otherwise return false.",
      "relatedSignals": ["Cancellation markers", "isWorkflowReturnedCancellation", "cancelled", "details", "aborted", "AbortError", "ABORT_ERR"]
    },
    {
      "component": "JSON text cancellation content",
      "file": "src/workflow-cancellation.ts",
      "evidence": "L23–31 iterate value.content, require entry.text to be a string, JSON.parse it, recursively call isWorkflowReturnedCancellation, and catch parse failures.",
      "observedBehavior": "Inspects text fields in record entries of content arrays. Parsed JSON is recursively checked for cancellation; malformed JSON is ignored. No entry type discriminator is checked.",
      "relatedSignals": ["Cancellation markers", "isWorkflowReturnedCancellation", "content", "JSON.parse"]
    },
    {
      "component": "Terminal summary fields and retry totals",
      "file": "src/workflow-terminal.ts",
      "evidence": "L77–79 initialize terminal and output IDs via store helpers. L98–111 return status fields, reduce outputRetry/launchRetry attempts with ?? 0, and call workflowRunDir.",
      "observedBehavior": "Reports terminal classification, engine and semantic statuses, output task IDs, retry totals across all tasks, and artifact root. Initial output IDs come from finalStageTasks; direct-dynamic processing can replace them.",
      "relatedSignals": ["Terminal summary", "summarizeWorkflowTerminal", "finalStageTasks", "outputRetryAttempts", "launchRetryAttempts", "artifactRoot"]
    },
    {
      "component": "Baseline semantic status and degradation",
      "file": "src/workflow-terminal.ts",
      "evidence": "L67–70: if (run.status === \"completed\") return run.degradation ? \"completed_degraded\" : \"completed\"; return run.status;",
      "observedBehavior": "Baseline semantic status preserves the engine status except that completed runs with truthy degradation become completed_degraded. Terminal direct-dynamic handling subsequently replaces this baseline.",
      "relatedSignals": ["Terminal summary", "nonDynamicSemanticStatus", "completed_degraded", "degradation"]
    },
    {
      "component": "Dynamic controller control-file lookup",
      "file": "src/workflow-terminal.ts",
      "evidence": "L52–61 select the first task matching dynamic.controller or dynamic_completed, resolve controller.files.output, and read join(dirname(taskOutput), \"control.json\").catch(() => undefined).",
      "observedBehavior": "Looks beside the selected controller task's output for control.json. Missing controller or rejected read yields undefined. The local interface exposes optional schema, status, and outputTasks fields without runtime shape validation.",
      "relatedSignals": ["Terminal summary", "readDynamicControllerControl", "dynamic.controller", "dynamic_completed", "control.json"]
    },
    {
      "component": "Terminal direct-dynamic semantic routing",
      "file": "src/workflow-terminal.ts",
      "evidence": "L80 gates on terminal && run.provenance?.mode === \"direct-dynamic\". L82–95 replace output IDs, prioritize dynamic_incomplete, map control.status, and otherwise use completed_without_semantic_result.",
      "observedBehavior": "Filters control outputTasks to strings. Any dynamic_incomplete task takes precedence; otherwise synthesized, exhausted, blocked, and stopped map to semantic statuses. Exhausted distinguishes output presence; remaining cases use completed_without_semantic_result.",
      "relatedSignals": ["Terminal summary", "direct-dynamic", "dynamic_incomplete", "synthesized", "exhausted", "blocked", "stopped", "completed_without_semantic_result"]
    }
  ],
  "unmappedAreas": [
    "src/store.js is absent and explicitly outside scope; durable intent reads, path resolution, terminal classification, final-stage selection, and JSON reading cannot be inspected.",
    "src/types.js is absent and explicitly outside scope; WorkflowRunRecord field constraints cannot be inspected."
  ],
  "notes": [
    "Mapping only: every numbered spec item has a source location; this is not a conformance determination.",
    "Read all three src files. No runtime tests or typecheck were executed.",
    "The requested root schema path was absent. Located and read the workflow bundle's matching schema; manually checked this control object's fields, types, and size limits against it.",
    "No upstream workflow artifacts were available."
  ]
}</control>

<analysis>
SPEC.md limits review to the three files present in src/. The implementation splits into:

- **workflow-stop.ts — spec items 1–8:** module-local launch registrations feed both the throwing checkpoint and polling AbortSignal. Durable intent is supplied by the unavailable store module. The checkpoint propagates durable-read failures, whereas polling suppresses them.
- **workflow-cancellation.ts — items 9–10:** shared exact-name and marker recognition, followed by recursive inspection of JSON text content. This module has no imports.
- **workflow-terminal.ts — items 11–13:** baseline status, outputs, retry totals, and artifact location are assembled first. Terminal direct-dynamic runs then load controller control.json and replace semantic status and output IDs.

For subsequent comparison, preserve these concrete branch distinctions: dynamic_incomplete is evaluated before control status and unreadable-control fallback; direct-dynamic processing replaces completed_degraded; disposal clears polling but does not cancel an in-flight read. Cancellation recognition checks particular fields and exact marker values rather than broadly classifying provider errors.

Confidence is high in the local source mapping. Dependency behavior and runtime timing remain unverified. The control object was manually checked against the located bundled schema, not validated by an executed validator.
</analysis>

<refs>[
  {
    "file": "SPEC.md",
    "lineStart": 1,
    "lineEnd": 51,
    "purpose": "Review scope and numbered requirements 1–13"
  },
  {
    "file": "src/workflow-stop.ts",
    "lineStart": 5,
    "lineEnd": 29,
    "specItems": [1, 2, 3]
  },
  {
    "file": "src/workflow-stop.ts",
    "lineStart": 31,
    "lineEnd": 59,
    "specItems": [4, 5, 6]
  },
  {
    "file": "src/workflow-stop.ts",
    "lineStart": 61,
    "lineEnd": 99,
    "specItems": [7, 8]
  },
  {
    "file": "src/workflow-cancellation.ts",
    "lineStart": 1,
    "lineEnd": 37,
    "specItems": [9, 10]
  },
  {
    "file": "src/workflow-terminal.ts",
    "lineStart": 27,
    "lineEnd": 113,
    "specItems": [11, 12, 13]
  },
  {
    "file": "package.json",
    "lineStart": 1,
    "lineEnd": 8,
    "purpose": "Sample boundary and available typecheck script"
  },
  {
    "file": ".pi/workflows/<WF_RUN_1>/bundle/schemas/spec-review-map-implementation-control.schema.json",
    "purpose": "Located control contract used for manual structural validation"
  }
]</refs>