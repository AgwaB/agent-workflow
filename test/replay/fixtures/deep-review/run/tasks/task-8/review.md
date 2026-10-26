# Deep review report

## Executive summary

### Core conclusion

Verdict: **NEEDS_WORK**. The deterministic ledger contains 7 kept or weakened findings and 0 needs-human items.

### Key findings

- **high / KEEP:** Stop polling starts unbounded concurrent persistence reads
- **high / KEEP:** Preserve failed and interrupted outcomes before applying dynamic status overrides
- **medium / KEEP:** Disposing one binding can remove another owner's launch fence
- **medium / KEEP:** An in-flight check can abort the signal after disposal
- **medium / KEEP:** A rejected persistence read bypasses the post-read launch fence
- **medium / KEEP:** Ordinary provider content can be mistaken for workflow cancellation
- 1 additional finding row(s) are included in the full report.

### Evidence level

- Canonical rows: 7 kept or weakened findings, 0 needs-human items, and 0 supporting observations.
- Coverage: complete according to source-status accounting.

### Important limitations

- Evidence and quotes are bound to the reviewed snapshot available to the partition stage; final rendering does not re-read repository files and therefore does not attest current-tree bytes.

## Finding summary

| Severity | Count |
|---|---:|
| high | 2 |
| medium | 5 |

## Synthesis narrative

Summary: Stop/cancel handling needs corrective work: seven findings were retained, none were weakened or deferred for human review, and all eight review sources completed.

## Risks and partial-review limitations

- Narrative context samples only four of seven retained findings and shortens one recommendation; this limits synthesis detail, not the authoritative evidence ledger.
- This synthesis relies on upstream review results without independently inspecting code or executing tests.

Recommended synthesis action: Address all seven retained findings using the complete evidence ledger, add targeted stop/cancel regression coverage, and rerun tests and review.

## High findings

### finding-001 — Stop polling starts unbounded concurrent persistence reads

Severity: **high**  
Root cause: `root-001`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-stop.ts` | 68-81 | `createWorkflowStopSignal` |

Reviewer/source evidence:

```ts
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
```

```text
	void check();
	const timer = setInterval(() => void check(), pollMs);
```

Verifier evidence:

```ts
	const pollMs = Math.max(10, options.pollMs ?? 50);
```

```ts
	const check = async (): Promise<void> => {
		if (controller.signal.aborted) return;
		if (launchStopRequested(cwd, runId)) {
			controller.abort(createWorkflowStopRequestedError(runId));
			return;
		}
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent || launchStopRequested(cwd, runId))
			controller.abort(createWorkflowStopRequestedError(runId));
```

```text
	void check();
	const timer = setInterval(() => void check(), pollMs);
	timer.unref?.();
```

```text
		dispose: () => clearInterval(timer),
```

Rationale:

Slow or stalled persistence causes pending reads and retained promises to accumulate for as long as the watcher remains active. This amplifies storage pressure precisely when cancellation depends on that storage and can exhaust resources or further delay stop propagation.

Recommended action:

Permit only one outstanding intent read per watcher, while checking foreground launch cancellation before the in-flight guard. Add a deferred-read regression test covering repeated ticks and local cancellation before that read settles.

Caveat / counter-evidence:

- The aborted-signal guard and foreground launch check prevent further reads once cancellation is observed. Thus storage stalls do not inherently prevent foreground cancellation detection.
- Disposal clears the interval, limiting future starts to the watcher's active lifetime. It does not bound outstanding reads before disposal.

### finding-007 — Preserve failed and interrupted outcomes before applying dynamic status overrides

Severity: **high**  
Root cause: `root-007`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-terminal.ts` | 80-95 | `summarizeWorkflowTerminal` |
| `src/workflow-terminal.ts` | 48-61 | `readDynamicControllerControl` |
| `src/workflow-terminal.ts` | 64-69 | `nonDynamicSemanticStatus` |
| `src/workflow-terminal.ts` | 98-102 | `summarizeWorkflowTerminal` |

Reviewer/source evidence:

```ts
	return run.status;
```

```ts
	if (!controller) return undefined;
```

```text
	).catch(() => undefined);
```

```ts
	if (terminal && run.provenance?.mode === "direct-dynamic") {
```

```text
		else if (control?.status === "synthesized") semanticStatus = "synthesized";
```

```text
		else semanticStatus = "completed_without_semantic_result";
```

```text
		engineStatus: run.status,
```

Verifier evidence:

```ts
	if (run.status === "completed")
		return run.degradation ? "completed_degraded" : "completed";
	return run.status;
```

```ts
if (terminal && run.provenance?.mode === "direct-dynamic") {
```

```ts
	if (!controller) return undefined;
	const taskOutput = fromProjectPath(cwd, controller.files.output);
	return await readJson<DynamicControllerControl>(
		join(dirname(taskOutput), "control.json"),
	).catch(() => undefined);
```

```ts
		const incomplete = run.tasks.some(
			(task) => task.statusDetail === "dynamic_incomplete",
		);
		if (incomplete) semanticStatus = "dynamic_incomplete";
		else if (control?.status === "synthesized") semanticStatus = "synthesized";
```

```text
else semanticStatus = "completed_without_semantic_result";
```

```text
		terminal,
		engineStatus: run.status,
		semanticStatus,
		outputTaskIds,
```

Rationale:

Cancellation before controller output exists and failures with unavailable controller artifacts lose their failed/interrupted semantic outcome. An existing synthesized artifact can also override those outcomes because controller success and artifact currency are not checked here. Although engineStatus remains accurate, consumers relying on semanticStatus receive a contradictory completion-labelled or successful-looking result and can misreport termination or omit recovery.

Recommended action:

Preserve failed/interrupted semantic outcomes before applying completion-derived dynamic refinements. Keep controller/output metadata extraction separate from status precedence. Add regression cases for absent, unreadable, and synthesized artifacts, including completed-run controls.

Caveat / counter-evidence:

- src/workflow-terminal.ts:99-101 preserves terminal and engineStatus, so the summary does not erase the engine outcome entirely or alter cancellation execution.
- src/workflow-terminal.ts:83-86 gives dynamic\_incomplete precedence; runs carrying that marker do not receive the completion-labelled fallback.

## Medium findings

### finding-002 — Disposing one binding can remove another owner's launch fence

Severity: **medium**  
Root cause: `root-002`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-stop.ts` | 14-20 | `bindWorkflowLaunchSignal` |
| `src/workflow-stop.ts` | 24-27 | `launchStopRequested` |

Reviewer/source evidence:

```ts
	const signals = launchSignals.get(key) ?? new Set<AbortSignal>();
	signals.add(signal);
```

```ts
	return () => {
		signals.delete(signal);
		if (signals.size === 0 && launchSignals.get(key) === signals)
			launchSignals.delete(key);
	};
```

```ts
	return [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(
		(signal) => signal.aborted,
	);
```

Verifier evidence:

```ts
	const signals = launchSignals.get(key) ?? new Set<AbortSignal>();
	signals.add(signal);
	launchSignals.set(key, signals);
```

```ts
	return () => {
		signals.delete(signal);
		if (signals.size === 0 && launchSignals.get(key) === signals)
			launchSignals.delete(key);
	};
```

```ts
	return [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(
		(signal) => signal.aborted,
	);
```

```ts
	if (launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
	const intent = await readWorkflowStopIntent(cwd, runId);
	// Cancellation may have arrived while the disk read was in flight.
	if (intent || launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
```

Rationale:

Registration lifetime is tracked by signal identity rather than binding ownership. Overlapping owners sharing a signal can therefore lose the synchronous fence that is meant to cover the durable-write window. Callers are absent, so the frequency of shared-signal registrations cannot be established.

Recommended action:

Track each binding with a unique registration token or reference count, make cleanup idempotent, and test that disposing one duplicate binding leaves the other effective.

Caveat / counter-evidence:

- The map-identity guard prevents an old cleanup from deleting a replacement Set, but does not preserve multiple registrations within the same Set.
- A readable durable stop intent still triggers cancellation, limiting the lost-fence effect to the interval before that intent becomes readable.

### finding-003 — An in-flight check can abort the signal after disposal

Severity: **medium**  
Root cause: `root-003`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-stop.ts` | 74-85 | `createWorkflowStopSignal` |

Reviewer/source evidence:

```ts
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent || launchStopRequested(cwd, runId))
			controller.abort(createWorkflowStopRequestedError(runId));
```

```text
		dispose: () => clearInterval(timer),
```

Verifier evidence:

```ts
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent || launchStopRequested(cwd, runId))
			controller.abort(createWorkflowStopRequestedError(runId));
```

```text
	void check();
	const timer = setInterval(() => void check(), pollMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => clearInterval(timer),
```

```ts
		if (controller.signal.aborted) return;
```

Rationale:

Disposal stops future timer ticks but does not end cancellation notifications from work already launched. A retained abort listener can consequently run after the consumer has torn down this watcher or released its lifecycle ownership. Downstream listener effects are not available in this excerpt.

Recommended action:

Set a disposed flag synchronously in dispose, check it before polling and immediately after the awaited read, and add a regression test resolving a pending read with a stop intent after disposal.

Caveat / counter-evidence:

- dispose clears the interval, preventing future scheduled polling; the defect concerns checks already in flight.
- The existing aborted guard prevents subsequent checks once cancellation is observed, but neither represents disposal nor guards the post-await continuation.

### finding-004 — A rejected persistence read bypasses the post-read launch fence

Severity: **medium**  
Root cause: `root-004`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-stop.ts` | 93-98 | `throwIfWorkflowStopRequested` |
| `src/workflow-stop.ts` | 53-58 | `isWorkflowStopRequestedError` |

Reviewer/source evidence:

```ts
	if (launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
	const intent = await readWorkflowStopIntent(cwd, runId);
	// Cancellation may have arrived while the disk read was in flight.
	if (intent || launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
```

```text
		error instanceof Error &&
		(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||
			error.message.startsWith("workflow stop requested"))
```

Verifier evidence:

```ts
	if (launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
	const intent = await readWorkflowStopIntent(cwd, runId);
	// Cancellation may have arrived while the disk read was in flight.
	if (intent || launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
```

```ts
export function isWorkflowStopRequestedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||
			error.message.startsWith("workflow stop requested"))
	);
}
```

```ts
function launchStopRequested(cwd: string, runId: string): boolean {
	return [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(
		(signal) => signal.aborted,
	);
}
```

```ts
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent || launchStopRequested(cwd, runId))
			controller.abort(createWorkflowStopRequestedError(runId));
```

Rationale:

The race protection covers fulfilled reads only. An unrelated persistence error generally fails the stop-error classifier, so callers cannot reliably distinguish cancellation from operational failure during this race. Actual caller recovery behavior is unavailable.

Recommended action:

Catch intent-read rejection, recheck the launch fence, and throw WorkflowStopRequested only when locally stopped; otherwise rethrow the original error. Add regression tests for both outcomes.

Caveat / counter-evidence:

- The rejected await still rejects the guard: this demonstrates incorrect cancellation classification, not successful dispatch past cancellation.
- The polling helper catches read rejection before its second launch check, so this specific rejection race does not affect that helper.

### finding-005 — Ordinary provider content can be mistaken for workflow cancellation

Severity: **medium**  
Root cause: `root-005`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-cancellation.ts` | 23-29 | `isWorkflowReturnedCancellation` |
| `src/workflow-cancellation.ts` | 16-21 | `isWorkflowReturnedCancellation` |

Reviewer/source evidence:

```ts
if (!isRecord(entry) || typeof entry.text !== "string") continue;
```

```ts
const parsed: unknown = JSON.parse(entry.text);
```

```ts
if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;
```

```ts
if (value.cancelled === true) return true;
```

Verifier evidence:

```ts
if (value.cancelled === true) return true;
```

```ts
if (Array.isArray(value.content)) {
		for (const entry of value.content) {
			if (!isRecord(entry) || typeof entry.text !== "string") continue;
```

```ts
const parsed: unknown = JSON.parse(entry.text);
				if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;
```

Rationale:

Application data and provider cancellation metadata share the same interpretation here. A cancellation field describing an application entity can therefore become a workflow cancellation signal. Callers relying on this predicate could discard valid output or suppress diagnostics. The false-positive return is established by the implementation; downstream handling is not included in this excerpt.

Recommended action:

Restrict text-based recognition to explicitly identified adapter cancellation envelopes, preserve legacy wrappers explicitly, and add a regression test showing successful content containing domain JSON with cancelled:true is not classified as cancellation.

Caveat / counter-evidence:

- Recognition uses exact cancellation markers, and JSON parsing failures are caught; arbitrary prose does not automatically become cancellation. These safeguards do not exclude valid domain JSON containing cancelled:true.

### finding-006 — Stop-error matching accepts unrelated failures with a similar message prefix

Severity: **medium**  
Root cause: `root-006`  

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/workflow-stop.ts` | 53-58 | `isWorkflowStopRequestedError` |
| `src/workflow-stop.ts` | 43-50 | `createWorkflowStopRequestedError` |

Reviewer/source evidence:

```text
error instanceof Error &&
```

```text
(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||
```

```text
error.message.startsWith("workflow stop requested"))
```

```ts
return `workflow stop requested for ${runId}`;
```

Verifier evidence:

```text
error instanceof Error &&
		(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||
			error.message.startsWith("workflow stop requested"))
```

```ts
return `workflow stop requested for ${runId}`;
```

```text
error.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;
```

```text
error.name = WORKFLOW_STOP_PENDING_ERROR_NAME;
```

Rationale:

A failure while requesting or processing a stop can be indistinguishable from the intentional stop sentinel. Consumers that use this classifier to suppress expected cancellation errors can consequently hide an operational failure. No consumer is supplied, so the downstream consequence remains unverified.

Recommended action:

Prefer the explicit stop sentinel. If legacy message-only errors must remain supported, compare against the exact expected-run message without overriding conflicting error names. Add regression tests for similarly prefixed operational failures and WorkflowStopPending errors.

Caveat / counter-evidence:

- The instanceof Error guard excludes plain strings and plain records; the false-positive scope is limited to Error instances.
- Canonical stop errors already receive the dedicated WorkflowStopRequested name, so their classification is intentional.

## Recommended next action

Address kept or weakened findings and resolve needs-human items before release.

## Evidence and review coverage

- Canonical ledger rows rendered: 7 kept or weakened findings, 0 needs-human items, and 0 supporting observations.
- Source coverage: complete according to deterministic source-status accounting.
- Finding cards preserve ledger locations, evidence quotes, verifier dispositions, counter-evidence, and recommended actions where present.
- Counts, dispositions, and the effective verdict come from deterministic partition state; narrative synthesis cannot override them.

## Limitations

- Evidence and quotes are bound to the reviewed snapshot available to the partition stage; final rendering does not re-read repository files and therefore does not attest current-tree bytes.

## Related artifacts

- [Machine-readable report](control.json) — structured renderer output and completion-summary contract.
- [Structured source references](refs.json) — source pointers retained by the final workflow task.
- [Legacy compatibility report](review.md) — byte-identical copy of this report.
