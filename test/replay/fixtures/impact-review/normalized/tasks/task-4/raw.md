<control>{"schema":"stage-control-v1","digest":"Default contracts remain unchanged; opt-in recording adds filesystem contracts and can alter API failure semantics.","status":"medium","impacts":[{"id":"recording-configuration","severity":"low","surface":"PI_WORKFLOW_RECORD_DIR","impact":"New process-level opt-in, evaluated once during cached API initialization."},{"id":"failure-semantics","severity":"medium","surface":"Backend API outcomes","impact":"Recording failures can prevent loading, convert successful operations into failures, or replace original errors."},{"id":"recording-format","severity":"medium","surface":"calls.jsonl and api-surface.json","impact":"New lossy recording format requires directory isolation; sequence numbers restart while existing calls remain appended."},{"id":"data-persistence","severity":"medium","surface":"Recording directory","impact":"API arguments and results are persisted without redaction, size limits, or automatic cleanup."}],"assumptions":[{"id":"scope","statement":"Assessment uses the supplied two-file diff and inspected post-change files."},{"id":"verification","statement":"Static inspection only; no runtime validation was performed."},{"id":"schema-validation","statement":"The requested ./schemas schema was absent. Required fields, types, and status were manually checked against workflows/impact-review/schemas/api-contract-impact-control.schema.json; no executable validator was available."}]}</control>

<analysis>
Overall impact is medium, confined to enabled recording. No unconditional consumer migration blocker was identified.

Default compatibility:
- Unset or whitespace-only configuration returns the original API object. Injected APIs bypass recording.
- The bounded diff changes no CLI syntax, package export map, root exports, workflow schema, or existing run-record schema. The new recorder module is not a supported package subpath.

Configuration contract:
- Set PI_WORKFLOW_RECORD_DIR before the first real API load. The selected wrapper is cached, so later environment changes neither enable nor disable recording.
- Initialization failures also reject the cached loader promise. Correcting the environment alone will not recover that process through the normal loader.

API behavior:
- Ordinary calls retain their original arguments and resolved values; synchronous helpers remain synchronous. Enumerable optional methods remain present, preserving capability detection.
- Recording is not behaviorally transparent under failure. Argument projection can fail before invocation. Projection or filesystem failure after an operation succeeds can instead throw/reject; failure while recording an API exception can replace that exception. Backend launch errors can become a fatal launch result.
- Enabled mode also changes function identity and returns chained promises. Constructor preservation recognizes ES class syntax, not every constructible function. Current dependency error constructors use class declarations; broader compatibility across dependency implementations is not established.

Recording contract:
- calls.jsonl contains invocation sequence, method, timestamps, arguments, process ID, sync flag, and outcome. Entries append on completion, so physical order can differ from sequence order.
- Existing calls are retained, sequence numbering restarts per wrapper, and api-surface.json is overwritten. Replay sorts only by sequence: reused or shared directories can mix sessions and misorder calls. Use a fresh directory per recording writer/session.
- The format has no version field and is intentionally lossy: unsupported values become markers, undefined properties disappear, and nullish successful results become null. It should not be treated as a general lossless API interchange format.
- Prompts, paths, results, and error messages can be captured as plaintext. Operators need appropriately private storage and retention handling; portable-path rewriting is separate from this seam.

Both required upstream controls were read completely through path="$" projections: 6,025 and 10,271 characters, neither truncated. Confidence is high for these static contract effects; runtime and exceptional-value behavior remain unverified.
</analysis>

<refs>[
{"source":"impact-analysis.change-scope","artifact":"control","path":"$","originalChars":6025,"charsTruncated":false},
{"source":"impact-analysis.implementation-map","artifact":"control","path":"$","originalChars":10271,"charsTruncated":false},
{"file":"src/subagent-backend.ts","lines":"484-505","supports":"Cached loader, configuration timing, and injection bypass"},
{"file":"src/subagent-api-recorder.ts","lines":"24-29,55-119,191-197","supports":"Environment gating and lossy projection"},
{"file":"src/subagent-api-recorder.ts","lines":"121-187","supports":"Export wrapping, recording artifacts, ordering, and failure propagation"},
{"file":"src/backend.ts","lines":"80-119","supports":"Launch exceptions converted to fatal results"},
{"file":"test/replay/replay-subagent-api.mjs","lines":"76-82,211-249","supports":"Sequence sorting and recording-format consumption"},
{"file":"package.json","lines":"33-43","supports":"Unchanged supported package exports and CLI entry"},
{"file":"src/index.ts","lines":"1-239","supports":"Recorder not re-exported from package root"},
{"file":"workflows/impact-review/schemas/api-contract-impact-control.schema.json","supports":"Fallback schema used for manual structural validation"}
]</refs>