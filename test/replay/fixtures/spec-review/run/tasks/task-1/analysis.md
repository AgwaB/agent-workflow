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
