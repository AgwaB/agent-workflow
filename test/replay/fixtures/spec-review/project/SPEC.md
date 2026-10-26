# Workflow stop and cancellation specification

This spec covers `src/workflow-stop.ts`, `src/workflow-cancellation.ts` and
`src/workflow-terminal.ts`. `store.js` and `types.js` are outside this sample.

## Launch signals

1. `bindWorkflowLaunchSignal(cwd, runId, signal)` registers an abort signal for
   the run keyed by `workflowRunPath(cwd, runId)`. With no signal it returns a
   no-op unbind function.
2. The returned unbind function removes only that signal. When the last signal
   for a run is removed, the run's registration is deleted.
3. A run counts as "launch stop requested" when any registered signal for it is
   aborted.

## Stop errors

4. `createWorkflowStopRequestedError(runId)` returns an `Error` named
   `WorkflowStopRequested` with message `workflow stop requested for <runId>`.
5. `isWorkflowStopRequestedError(error)` is true for an `Error` with that name or
   whose message starts with `workflow stop requested`; false for non-errors.
6. `createWorkflowStopPendingError(message)` returns an `Error` named
   `WorkflowStopPending`; `isWorkflowStopPendingError` recognizes exactly that name.

## Stop checks

7. `throwIfWorkflowStopRequested(cwd, runId)` throws the stop-requested error if a
   launch stop is requested, or if a durable stop intent exists for the run. It
   re-checks launch signals after the durable read completes.
8. `createWorkflowStopSignal(cwd, runId, {pollMs})` returns `{signal, dispose}`.
   It checks immediately and then every `pollMs` milliseconds (minimum 10,
   default 50). When a stop is requested its signal aborts with the
   stop-requested error. A failed durable read is treated as "no intent".
   `dispose()` stops polling. The poll timer must not keep the process alive.

## Cancellation markers

9. `isWorkflowAbortError(value)` is true only for values named `AbortError`.
10. `isWorkflowReturnedCancellation(value)` recognizes `cancelled: true` (top
    level or in `details`), `aborted`/`AbortError`/`ABORT_ERR` reasons and
    errors, and JSON text content entries that encode one of these. Arbitrary
    provider errors must not be treated as cancellation.

## Terminal summary

11. `summarizeWorkflowTerminal(cwd, run)` reports `terminal`, `engineStatus`,
    `semanticStatus`, `outputTaskIds`, retry totals, and `artifactRoot`.
12. A completed run with degradation reports `completed_degraded`.
13. Terminal direct-dynamic runs derive their semantic status from the dynamic
    controller's `control.json`; an unreadable control yields
    `completed_without_semantic_result`.
