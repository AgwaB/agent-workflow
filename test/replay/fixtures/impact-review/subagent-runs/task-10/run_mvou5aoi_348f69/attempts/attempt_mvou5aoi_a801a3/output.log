<control>{"schema":"stage-control-v1","digest":"Medium overall regression risk, concentrated in opt-in recording; failure handling and loader integration remain insufficiently validated.","riskLevel":"medium","risks":[{"id":"recording-failure-coupling","severity":"high","condition":"Recording enabled and filesystem access or serialization fails.","impact":"Recording can prevent API invocation, turn completed operations into failures, or mask original errors. Initialization failures remain cached.","validationGap":"No executed fault-injection or recorder-enabled backend-loader tests.","evidenceIds":["recorder","loader","validation"]},{"id":"recording-integrity","severity":"medium","condition":"Directories are reused/shared, calls overlap, or capture ends before settlement.","impact":"Appended history contains restarting sequence numbers, overwritten surface metadata, and no unfinished calls. Replay can mix sessions; lossy values can weaken reference fidelity.","validationGap":"No targeted directory-reuse, multi-writer, out-of-order completion, or broad serialization tests.","evidenceIds":["recorder","replay-reader","state-data","validation"]},{"id":"sensitive-data-retention","severity":"medium","condition":"Recording enabled for sensitive workloads.","impact":"Arguments, results, and error messages gain plaintext persistence without redaction, retention limits, or explicitly restrictive permissions.","validationGap":"No demonstrated sensitive-data handling or storage-policy validation.","evidenceIds":["recorder","security-performance"]},{"id":"synchronous-unbounded-recording","severity":"medium","condition":"Large payloads, frequent polling, or long recording sessions.","impact":"Recursive serialization and synchronous writes block the event loop; unbounded growth can exhaust storage and trigger recording-induced API failures.","validationGap":"No benchmark, payload-limit, or disk-exhaustion evidence.","evidenceIds":["recorder","security-performance"]}],"riskReducers":[{"id":"default-disabled","effect":"Unset or blank configuration returns the real API unchanged and performs no recording filesystem operations.","evidenceIds":["recorder","loader"]},{"id":"inspected-test-coverage","effect":"Tests assert disabled identity, normal synchronous/asynchronous forwarding, rejection recording, selected placeholders, and method inventory; replay fixtures exercise downstream compatibility.","limitation":"Assertions were inspected, not executed; injected replay APIs bypass the changed loader.","evidenceIds":["tests","validation"]},{"id":"bounded-existing-state-impact","effect":"No existing workflow-state migration is introduced; primary risks require explicit recording activation.","evidenceIds":["api-contract","state-data"]}]}</control>

<analysis>
Overall risk is medium, with high conditional reliability impact when recording is enabled. Confidence is high in the identified implementation paths, but runtime frequency and performance cost are unmeasured.

The principal regression is that recording is not observationally isolated. Argument projection occurs before invocation; outcome serialization and appending occur before results/errors reach callers. A successful launch could therefore appear failed after its underlying effect completed. Invalid Dates, throwing getters, and self-referential Error metadata provide additional failure paths beyond filesystem errors. Recorder initialization rejection also remains in the cached loader promise.

Recording integrity is a separate concern: each wrapper restarts sequence numbering while retaining previous calls and overwriting surface metadata. Replay sorts by sequence without separating producers. Concurrent calls append on completion, and unfinished calls leave no entry. Lossy projection is intentional, but its broader replay implications lack targeted validation.

Existing tests reduce happy-path uncertainty, not these failure risks. Fixture replay injects its API and bypasses recorder-enabled dynamic loading. No tests, builds, benchmarks, or fault-injection checks were executed in this assessment or reported upstream.

Before relying on enabled recording, prioritize:
1. Define failure policy and test initialization, append, and projection failures, including effects already completed.
2. Exercise real backend loading with enabled/disabled configuration, cache behavior, and injection bypass.
3. Enforce isolated recording directories or validate explicit session separation.
4. Test serializer boundaries and asynchronous ordering; establish sensitive-data and storage policies.
5. Run the focused recorder/replay suite against a fresh build, then repository validation and packed-consumer checks.

All four required upstream controls were read through complete, non-truncated `$` projections. The requested root schema path was absent; the control object was manually checked against the repository’s workflow-local regression-risk schema. No executable schema validator was run.
</analysis>

<refs>[
{"id":"api-contract","source":"impact-analysis.api-contract-impact","artifact":"control","path":"$"},
{"id":"state-data","source":"impact-analysis.state-data-impact","artifact":"control","path":"$"},
{"id":"validation","source":"impact-analysis.validation-impact","artifact":"control","path":"$"},
{"id":"security-performance","source":"impact-analysis.security-performance-impact","artifact":"control","path":"$"},
{"id":"recorder","path":"src/subagent-api-recorder.ts","startLine":24,"endLine":197},
{"id":"loader","path":"src/subagent-backend.ts","startLine":484,"endLine":506},
{"id":"tests","path":"test/unit/replay-self-consistency.test.mjs","startLine":172,"endLine":295},
{"id":"replay-reader","path":"test/replay/replay-subagent-api.mjs","startLine":76,"endLine":82},
{"id":"control-schema","path":"workflows/impact-review/schemas/regression-risk-control.schema.json"}
]</refs>