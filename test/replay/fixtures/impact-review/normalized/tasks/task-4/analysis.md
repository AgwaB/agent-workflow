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
