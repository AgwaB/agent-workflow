The finding survives the available counterarguments. For a direct-dynamic run considered terminal, the override does not require successful completion. With no dynamic_incomplete marker, missing controller data selects completed_without_semantic_result; synthesized controller data selects synthesized. Neither path preserves the initial failed/interrupted semantic status.

The accurate engineStatus field mitigates impact: consumers checking it can still recognize unsuccessful termination. This is a summary-classification defect, not evidence that cancellation itself fails.

Post-fix consideration: gating the entire dynamic block would also change outputTaskIds extraction. Restrict semantic assignments independently so unsuccessful runs can retain useful output metadata without appearing successful.

Applicability caveat: this excerpt omits store.ts, types.ts, callers, and tests. Terminal-status membership, real cancellation-state construction, and downstream recovery impact cannot be independently verified here. Those limitations constrain the proposed high severity, not the demonstrated overwrite behavior.

Validation was manual against the bundled workflow schema; the requested ./schemas path is absent. No executable tests were available through the permitted tools.
