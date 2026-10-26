# Impact review report

## Executive summary

### Core conclusion

Renderer status is not passed. The conservative verdict is **BLOCKED** with **high** risk.

Narrative synthesis: The two-file change adds opt-in recording across the shared real subagent API loader. Overall risk is medium, concentrated in enabled recording; default-off behavior remains unchanged by inspection.

## Impact conclusion

- Effective verdict: **BLOCKED**
- Effective risk level: **high**
- Synthesis verdict/risk: **NEEDS\_WORK** / **medium**
- Ship readiness: **needs-work**
- Contract consistency: **warn**

## Findings and actions

### Blocking issues

- \{"action":"Align implementation, documentation, and fault-injection tests with an explicit failure contract. Isolate recorder failures if forwarding must remain transparent.","evidenceRefs":\["contracts","regression","readiness","recorder"\],"id":"B1","issue":"Recording failures can prevent API calls, replace successful outcomes, or mask original errors, contradicting the unchanged-forwarding description.","severity":"high"\}
- \{"action":"Add isolated loader tests covering unset/blank configuration, enabled recording, cached configuration and initialization rejection, reset, and injection bypass.","evidenceRefs":\["readiness","loader"\],"id":"B2","issue":"Existing recorder and replay tests do not exercise activation through the changed real backend loader; injected APIs bypass it.","severity":"medium"\}
- \{"action":"Document private, fresh, single-writer directories, first-load configuration caching, cleanup, sharing precautions, synchronous overhead, and the selected failure policy.","evidenceRefs":\["contracts","readiness"\],"id":"B3","issue":"The new diagnostic control lacks usage documentation despite persisting unredacted arguments, results, and errors and requiring directory isolation for reliable replay.","severity":"medium"\}

### Non-blocking issues

- \{"action":"Use exclusive fresh directories; add session identity or reject reuse before supporting shared or multi-session recording.","evidenceRefs":\["contracts","regression"\],"id":"N1","issue":"Directory reuse or sharing appends calls with restarting sequence numbers while overwriting API-surface metadata, potentially mixing replay sessions.","severity":"medium"\}
- \{"action":"Keep use bounded and private; measure representative payloads and consider permissions, size limits, redaction, and retention before broader adoption.","evidenceRefs":\["regression"\],"id":"N2","issue":"Enabled recording performs synchronous, unbounded serialization and writes without redaction or retention controls.","severity":"medium"\}

### Recommended next actions

- \{"action":"Resolve B1 and add failure-path tests, especially successful operations followed by failed recording writes.","priority":1\}
- \{"action":"Close B2 and B3 before treating recording as a supported diagnostic capability.","priority":2\}
- \{"action":"Run candidate validation and conditional publication checks; retain the results.","priority":3\}

### Validation to run

- \{"command":"npm run build &amp;&amp; node --test test/unit/replay-self-consistency.test.mjs","purpose":"Build and verify existing recorder/replay behavior."\}
- \{"check":"New isolated loader and fault-injection tests","purpose":"Verify activation, caching, bypass, initialization failure, projection failure, and append failure under the agreed contract."\}
- \{"command":"npm run validate &amp;&amp; npm run e2e","purpose":"Check broader compatibility against the candidate revision."\}
- \{"command":"npm run build &amp;&amp; npm run pack:dry &amp;&amp; npm run release:check","condition":"Before npm publication","purpose":"Confirm recorder source, JavaScript, and declarations are packaged and local recordings are excluded."\}

### Needs human review

- \{"owner":"Backend maintainer","question":"Should recording be best-effort, or may it deliberately fail workflow operations? Strict behavior is observable but its intent is not established."\}
- \{"owner":"Recording/security owner","question":"Confirm bounded, private, single-writer sessions are the supported model, including inherited child-process configuration; broader support requires stronger isolation and storage safeguards."\}
- \{"owner":"CI/release owner","question":"Provide fresh test and packaging results. Execution, registry access, and release-environment readiness were not verified in this read-only review."\}

### Confirmed safe areas

- \{"area":"Default-off behavior","finding":"Unset or blank configuration returns the original API without recording filesystem operations."\}
- \{"area":"Test injection","finding":"Injected APIs bypass recording; the existing reset clears the cached loader."\}
- \{"area":"Capability detection","finding":"Enumerable methods remain available, and recording emits the complete method inventory."\}
- \{"area":"Existing persistence and packaging structure","finding":"No workflow-state migration, dependency addition, or public package-export change is introduced; existing source/build inclusion accommodates the recorder."\}

## Contract consistency

### Contract issues

- \{"action":"Document first-load caching, restart requirements, outcome-affecting recording failures, and private storage/cleanup requirements; qualify unchanged-forwarding language.","evidenceIds":\["recorder","loader","backend-errors","usage"\],"id":"diagnostic-contract-gap","lenses":\["api-contract","state-data","docs-release"\],"mismatch":"The recorder describes unchanged forwarding, but serialization and filesystem failures can prevent calls or replace completed API outcomes. Usage documentation omits the new control and these operational semantics.","severity":"medium"\}
- \{"action":"Require and document fresh exclusive recording directories, or introduce session identity and enforce matching call, surface, and snapshot provenance.","evidenceIds":\["recorder","replay","capture","usage"\],"id":"reference-session-mismatch","lenses":\["api-contract","state-data","docs-release"\],"mismatch":"The producer permits directory reuse while appending calls, restarting sequence numbers, and overwriting surface metadata. Replay sorts only by sequence without producer/session partitioning, and capture replaces filesystem snapshots independently.","severity":"medium"\}

### Confirmed consistencies

- \{"finding":"Unset or blank configuration returns the original API; injected test APIs bypass recording.","id":"default-compatibility"\}
- \{"finding":"Recording preserves enumerable methods and emits the full method surface used by replay feature detection.","id":"capability-surface"\}
- \{"finding":"The bounded change adds separate recording artifacts without changing existing workflow persistence schemas or requiring migration.","id":"existing-state"\}
- \{"finding":"Existing TypeScript inclusion and package src/dist roots accommodate the mandatory recorder import without a new dependency or public export.","id":"release-structure"\}

## Regression risk

Canonical risk level: **medium**

### Regression risks

- \{"condition":"Recording enabled and filesystem access or serialization fails.","evidenceIds":\["recorder","loader","validation"\],"id":"recording-failure-coupling","impact":"Recording can prevent API invocation, turn completed operations into failures, or mask original errors. Initialization failures remain cached.","severity":"high","validationGap":"No executed fault-injection or recorder-enabled backend-loader tests."\}
- \{"condition":"Directories are reused/shared, calls overlap, or capture ends before settlement.","evidenceIds":\["recorder","replay-reader","state-data","validation"\],"id":"recording-integrity","impact":"Appended history contains restarting sequence numbers, overwritten surface metadata, and no unfinished calls. Replay can mix sessions; lossy values can weaken reference fidelity.","severity":"medium","validationGap":"No targeted directory-reuse, multi-writer, out-of-order completion, or broad serialization tests."\}
- \{"condition":"Recording enabled for sensitive workloads.","evidenceIds":\["recorder","security-performance"\],"id":"sensitive-data-retention","impact":"Arguments, results, and error messages gain plaintext persistence without redaction, retention limits, or explicitly restrictive permissions.","severity":"medium","validationGap":"No demonstrated sensitive-data handling or storage-policy validation."\}
- \{"condition":"Large payloads, frequent polling, or long recording sessions.","evidenceIds":\["recorder","security-performance"\],"id":"synchronous-unbounded-recording","impact":"Recursive serialization and synchronous writes block the event loop; unbounded growth can exhaust storage and trigger recording-induced API failures.","severity":"medium","validationGap":"No benchmark, payload-limit, or disk-exhaustion evidence."\}

### Risk reducers

- \{"effect":"Unset or blank configuration returns the real API unchanged and performs no recording filesystem operations.","evidenceIds":\["recorder","loader"\],"id":"default-disabled"\}
- \{"effect":"Tests assert disabled identity, normal synchronous/asynchronous forwarding, rejection recording, selected placeholders, and method inventory; replay fixtures exercise downstream compatibility.","evidenceIds":\["tests","validation"\],"id":"inspected-test-coverage","limitation":"Assertions were inspected, not executed; injected replay APIs bypass the changed loader."\}
- \{"effect":"No existing workflow-state migration is introduced; primary risks require explicit recording activation.","evidenceIds":\["api-contract","state-data"\],"id":"bounded-existing-state-impact"\}

## Ship readiness

### Required before ship

- \{"acceptance":\["Unset and blank configuration do not create recording files.","Enabled configuration creates surface metadata and records a forwarded call.","Configuration caching, test cache reset, and injected-API bypass are verified."\],"action":"Add isolated tests exercising the real, non-injected backend loader.","evidenceRefs":\["loader","tests"\],"id":"loader-coverage","owner":"Backend/test maintainer"\}
- \{"acceptance":\["Initialization, argument projection, and append failures have explicit expected behavior.","Tests establish whether recording failures may prevent invocation, replace successful results, or mask original errors.","Cached loader rejection behavior is covered."\],"action":"Choose and document strict recording failure propagation or best-effort recording; test the selected policy.","evidenceRefs":\["recorder","loader"\],"id":"recording-failure-contract","owner":"Backend maintainer"\}
- \{"acceptance":\["Explain first-load configuration caching and calls.jsonl/api-surface.json outputs.","Warn that arguments, results, and errors are stored without redaction or automatic retention limits.","Require a fresh private directory outside publish roots and one recording writer, including consideration of inherited child-process configuration.","Describe manual cleanup, review before sharing, synchronous overhead, and the selected failure policy."\],"action":"Document PI\_WORKFLOW\_RECORD\_DIR as an internal, default-off diagnostic control in docs/usage.md.","evidenceRefs":\["recorder","loader","usage"\],"id":"safe-use-documentation","owner":"Documentation/security owner"\}
- \{"acceptance":"Record passing results against the candidate revision, including the added boundary and failure-policy tests.","commands":\["npm run build &amp;&amp; node --test test/unit/replay-self-consistency.test.mjs","npm run validate","npm run e2e"\],"evidenceRefs":\["validation","package"\],"id":"fresh-validation","owner":"CI/test owner"\}
- \{"acceptance":\["After a fresh build, verify src/subagent-api-recorder.ts, dist/subagent-api-recorder.js, and dist/subagent-api-recorder.d.ts are packaged.","Confirm generated recordings and sensitive local artifacts are absent from the package.","Run release checks in the established release environment; registry/authentication checks were not assessed here."\],"commands":\["npm run pack:dry","npm run release:check"\],"condition":"Before npm publication","evidenceRefs":\["package","release"\],"id":"publish-verification","owner":"Release owner"\}

### Nice to have

- \{"action":"Expand serializer and forwarding tests for constructors/values, receiver and identity preservation, unusual values, cycles, and out-of-order asynchronous completion.","id":"broader-unit-coverage"\}
- \{"action":"Consider explicit restrictive permissions, redaction controls, and size/retention limits before broader operational use.","id":"artifact-hardening"\}
- \{"action":"Add session identifiers or reject reused/shared recording directories.","id":"session-isolation","promotionCondition":"Required if shared-directory or multi-process recording is intended to be supported."\}
- \{"action":"Measure large-payload and polling workloads before considering buffered/asynchronous writes or making performance claims.","id":"enabled-mode-performance"\}
- \{"action":"Automate recorder-enabled backend activation in the packed-consumer smoke suite.","id":"packed-activation-automation"\}

### Readiness assumptions

- \{"id":"scope","statement":"The supplied b83cc4f..7e813aa diff defines the two-file change; adjacent files were inspected only for readiness evidence."\}
- \{"id":"operating-model","statement":"Recording remains opt-in, operator-controlled, and intended for bounded single-writer diagnostics rather than production audit logging."\}
- \{"id":"upstream-completeness","statement":"All three required upstream control artifacts were read using complete, non-truncated root JSON projections."\}
- \{"id":"execution","statement":"No files were modified and no tests, builds, benchmarks, package operations, or registry checks were executed."\}
- \{"id":"schema-validation","statement":"The requested./schemas/ship-readiness-control.schema.json was absent. This control object was manually checked against workflows/impact-review/schemas/ship-readiness-control.schema.json; no executable schema validator was run."\}
- \{"id":"confidence","statement":"High confidence in inspected activation and recording behavior; readiness remains conditional on test execution and owner decisions."\}

## Evidence and limitations

- The three joined controls are authoritative for contract state, regression risk, and ship readiness; synthesis cannot lower their verdict or risk floor.
- Known canonical impact risk floor is high.
- Impact review does not attest historical source-file bytes; content hashes cover host-supplied control values only, and citations are unverified unless an authoritative byte snapshot is supplied.
- Synthesis verdict NEEDS\_WORK contradicts required verdict BLOCKED.
- Synthesis risk medium understates or obscures the known source risk floor high (regression risk medium).

## Related artifacts

- [Machine-readable renderer control](control.json)
- [Structured source references](refs.json)
- [Canonical impact source ledger](source-ledger.json)
