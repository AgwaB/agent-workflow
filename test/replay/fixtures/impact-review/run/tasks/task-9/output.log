<control>{"schema":"stage-control-v1","digest":"Default compatibility and packaging align; enabled recording has undocumented outcome changes and incompatible shared-directory assumptions.","status":"warn","issues":[{"id":"diagnostic-contract-gap","severity":"medium","lenses":["api-contract","state-data","docs-release"],"mismatch":"The recorder describes unchanged forwarding, but serialization and filesystem failures can prevent calls or replace completed API outcomes. Usage documentation omits the new control and these operational semantics.","action":"Document first-load caching, restart requirements, outcome-affecting recording failures, and private storage/cleanup requirements; qualify unchanged-forwarding language.","evidenceIds":["recorder","loader","backend-errors","usage"]},{"id":"reference-session-mismatch","severity":"medium","lenses":["api-contract","state-data","docs-release"],"mismatch":"The producer permits directory reuse while appending calls, restarting sequence numbers, and overwriting surface metadata. Replay sorts only by sequence without producer/session partitioning, and capture replaces filesystem snapshots independently.","action":"Require and document fresh exclusive recording directories, or introduce session identity and enforce matching call, surface, and snapshot provenance.","evidenceIds":["recorder","replay","capture","usage"]}],"confirmedConsistencies":[{"id":"default-compatibility","finding":"Unset or blank configuration returns the original API; injected test APIs bypass recording."},{"id":"capability-surface","finding":"Recording preserves enumerable methods and emits the full method surface used by replay feature detection."},{"id":"existing-state","finding":"The bounded change adds separate recording artifacts without changing existing workflow persistence schemas or requiring migration."},{"id":"release-structure","finding":"Existing TypeScript inclusion and package src/dist roots accommodate the mandatory recorder import without a new dependency or public export."}]}</control>

<analysis>
The combined assessment is warn, not a default-mode compatibility failure. Both inconsistencies require recording to be enabled.

1. The diagnostic description needs an explicit operational contract. Arguments are projected before invocation, and outcomes are synchronously serialized/appended before reaching callers. A successful effect can therefore be reported as a failure. In the backend’s generic launch-error path, the task returns to pending before its handle is recorded. Existing recovery protections remain, so duplicate execution is not established. The documentation gap is consequential: operators are not told that activation is cached at first real API initialization, that initialization rejection remains cached, or that recording failures can change workflow outcomes. Recording also creates plaintext artifacts without automatic cleanup.

2. Reference recordings require an unenforced session boundary. Completion-order appends within one wrapper are compatible with replay’s sequence sorting. Directory reuse is different: sequence numbers restart, old calls remain, surface metadata is replaced, and replay does not partition by pid or session. The capture helper can then replace run snapshots while retaining the accumulated calls. Thus syntactically valid artifacts need not describe one coherent reference run. No actual competing writers or corrupted capture were demonstrated.

Packaging configuration is consistent with the source dependency: the recorder is imported even when disabled, but existing build and package inclusion rules accommodate it. Actual built/packed inclusion remains unverified. The projection is intentionally lossy; no stable, lossless interchange contract or workflow migration should be inferred.

All required control artifacts were read through complete root projections: 1,445, 3,967, and 2,895 characters, respectively; none was truncated. Confidence is high for static behavior, not runtime frequency.

The requested ./schemas/contract-consistency-control.schema.json was absent. The output was manually checked against the matching repository-local schema under workflows/impact-review/schemas; no executable schema validator, tests, builds, or packaging checks were run.
</analysis>

<refs>[
  {"id":"api-contract-input","source":"impact-analysis.api-contract-impact","artifact":"control","path":"$","originalChars":1445,"charsTruncated":false},
  {"id":"state-data-input","source":"impact-analysis.state-data-impact","artifact":"control","path":"$","originalChars":3967,"charsTruncated":false},
  {"id":"docs-release-input","source":"impact-analysis.docs-release-impact","artifact":"control","path":"$","originalChars":2895,"charsTruncated":false},
  {"id":"recorder","path":"src/subagent-api-recorder.ts","lines":["4-18","55-117","123-197"]},
  {"id":"loader","path":"src/subagent-backend.ts","lines":["484-505"]},
  {"id":"backend-errors","path":"src/subagent-backend.ts","lines":["3263-3320"]},
  {"id":"usage","path":"docs/usage.md","lines":["391-402"]},
  {"id":"replay","path":"test/replay/replay-subagent-api.mjs","lines":["75-81","124-144","229-236"]},
  {"id":"capture","path":"internal/record/capture-run.mjs","lines":["30-45"]},
  {"id":"package","path":"package.json","pointers":["files","exports","scripts.build","scripts.prepack"]},
  {"id":"build","path":"tsconfig.json","pointers":["include","compilerOptions.declaration"]},
  {"id":"control-schema","path":"workflows/impact-review/schemas/contract-consistency-control.schema.json","validation":"Manual structural validation; requested root-relative location absent."}
]</refs>