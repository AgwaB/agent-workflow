The finding survives independent inspection of SPEC.md and all three source files. SPEC 13 states the unreadable-control fallback without an exception for incomplete tasks.

A static counterexample requires a run that passes the terminal/direct-dynamic guard, a controller task with a usable output path, and another task marked dynamic_incomplete. If readJson rejects, the helper catches that rejection and returns undefined. The summary then sets outputTaskIds to an empty array, finds the incomplete task, and selects dynamic_incomplete. The required completed_without_semantic_result branch cannot execute. With readable control.status equal to synthesized, the same task marker also prevents controller-derived status selection.

I sought a refutation through specification exceptions, input guards, and local run-state invariants. The specification contains no relevant exception, and the available source does not exclude incomplete tasks from terminal direct-dynamic summaries. The explicit dynamic_incomplete union member suggests intentional implementation behavior, but it does not authorize precedence contrary to SPEC 13.

Store helpers and run types are expressly outside the sample. Consequently, this verification does not establish production occurrence or claim an executed reproduction. That limitation does not supply evidence that the positively identified branch behavior conforms. Medium severity remains appropriate for incorrect summary semantics.

No files were modified or tests executed. The requested relative schema path was absent; its materialized workflow-bundle copy was readable, and the control object was manually checked against that schema.
