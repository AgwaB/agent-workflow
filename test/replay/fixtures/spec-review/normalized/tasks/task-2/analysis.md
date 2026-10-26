SPEC.md limits review to the three files present in src/. The implementation splits into:

- **workflow-stop.ts — spec items 1–8:** module-local launch registrations feed both the throwing checkpoint and polling AbortSignal. Durable intent is supplied by the unavailable store module. The checkpoint propagates durable-read failures, whereas polling suppresses them.
- **workflow-cancellation.ts — items 9–10:** shared exact-name and marker recognition, followed by recursive inspection of JSON text content. This module has no imports.
- **workflow-terminal.ts — items 11–13:** baseline status, outputs, retry totals, and artifact location are assembled first. Terminal direct-dynamic runs then load controller control.json and replace semantic status and output IDs.

For subsequent comparison, preserve these concrete branch distinctions: dynamic_incomplete is evaluated before control status and unreadable-control fallback; direct-dynamic processing replaces completed_degraded; disposal clears polling but does not cancel an in-flight read. Cancellation recognition checks particular fields and exact marker values rather than broadly classifying provider errors.

Confidence is high in the local source mapping. Dependency behavior and runtime timing remain unverified. The control object was manually checked against the located bundled schema, not validated by an executed validator.
