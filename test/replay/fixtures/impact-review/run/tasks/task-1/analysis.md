The changed lines are narrow, but the enabled-mode reach is broad: `loadSubagentApi()` is the shared boundary for launch preparation, execution, durable-launch coordination, polling, cancellation, one-shot routing, and parent-child events. Unset or blank configuration returns the real module unchanged. Injected test APIs return before the recording seam, so injection-based lifecycle tests do not exercise loader integration.

Recording is selected during cached API initialization—not per workflow or per call. Initialization creates the directory, opens the append-only call log, and overwrites surface metadata. Function calls receive their original arguments via `fn.apply(real, args)`; detected ES classes and nonfunction exports pass through. Asynchronous functions return a chained promise, and entries are appended at settlement, so physical line order can differ from invocation sequence. Calls that never settle have no completed record.

The main follow-up impact areas are:

- **Reliability and latency:** projection and synchronous filesystem writes execute directly on the API path without best-effort isolation. Initialization failures can reject the cached loader promise; append failures can replace successful results or original errors. Argument projection occurs before the underlying function is called.
- **Recording ownership:** `seq` resets per wrapper, calls append to existing files, and surface metadata is overwritten. Reused or shared directories therefore need examination for recording isolation; a process-global sequence or cross-process ownership mechanism is not present.
- **Data handling:** launch arguments include compiled task prompts, system prompts, model configuration, and host paths. Ordinary strings are recorded without redaction or size limits. Projection intentionally loses information: callbacks/signals become markers, error stacks are omitted, and nullish results are recorded as null.
- **Compatibility:** the wrapper copies enumerable exports into a plain object and detects constructors using class-source syntax. These are narrower guarantees than preserving every possible module/object characteristic.

The inspected recorder test covers basic forwarding and serialization. It directly constructs a fake wrapped API, rather than exercising the dynamic-import/cache path, and does not demonstrate filesystem-failure handling, shared-directory behavior, concurrent settlement ordering, or constructor preservation.

Confidence is high in the two-file scope and traced consumers. Runtime correctness remains unverified.
