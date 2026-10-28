// New in agent-workflow (WP33 item 3, parity row 33): parent-session usage of the Pi host. Port of
// pi-workflow 0.16.4 (b83cc4f) src/extension.ts wiring of src/workflow-parent-usage.ts (ported as
// src/core/workflow-parent-usage.ts): a run this session launched, resumed or approved is tracked
// under the Pi session id (`beginParentUsageTracking`, at the same point as pi-workflow's
// `startWorkflowParentTracking`); every parent assistant message (`message_end`) while it runs adds
// its usage to `<run dir>/parent-usage.json`, and the first message after the run settled is counted
// once as the wrap-up (the core module's rules); `session_start` resumes this session's running
// runs and `session_shutdown` flushes and detaches. The sidecar holds numbers, timestamps, the
// session id and message hashes only: never message content, so no secret can be recorded.
// Changes: tracking does not need a UI (pi-workflow binds without one too), only a session id; a
// failed write shows pi-workflow's "deferred" warning (stderr without a UI).
import {
	beginParentUsageTracking,
	flushParentUsageTracking,
	recordParentSessionUsage,
	resumeParentUsageTracking,
} from "../../core/workflow-parent-usage.js";
import { piSessionId } from "./feedback.js";
import type { PiExtensionContext } from "./pi-types.js";

const DEFERRED_MESSAGE =
	"Parent usage accounting deferred after a write failure; pending totals will retry on the next message or flush. A sanitized diagnostic is saved with recovery.";

function notifyDeferred(ctx: PiExtensionContext): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(DEFERRED_MESSAGE, "warning");
		else process.stderr.write(`${DEFERRED_MESSAGE}\n`);
	} catch {
		// Best effort.
	}
}

/** A run of this session: count the parent's usage while it runs (never throws). */
export async function beginRunParentUsage(
	ctx: PiExtensionContext,
	runId: string,
): Promise<void> {
	const sessionId = piSessionId(ctx);
	if (!sessionId) return;
	try {
		beginParentUsageTracking(ctx.cwd, runId, sessionId);
		await flushParentUsageTracking(ctx.cwd, sessionId);
	} catch {
		notifyDeferred(ctx);
	}
}

/** `message_end`: add a parent assistant message's usage to this session's active runs. */
export async function recordRunParentUsage(
	ctx: PiExtensionContext,
	message: unknown,
): Promise<void> {
	const sessionId = piSessionId(ctx);
	if (!sessionId) return;
	await recordParentSessionUsage(ctx.cwd, message, sessionId).catch(() =>
		notifyDeferred(ctx),
	);
}

/** `session_start`: keep counting for this session's runs that still run. */
export async function resumeRunParentUsage(
	ctx: PiExtensionContext,
): Promise<void> {
	const sessionId = piSessionId(ctx);
	if (!sessionId) return;
	await resumeParentUsageTracking(ctx.cwd, sessionId).catch(() =>
		notifyDeferred(ctx),
	);
}

/** `session_shutdown`: write what is pending and stop counting in this process. */
export async function flushRunParentUsage(
	ctx: PiExtensionContext | undefined,
): Promise<void> {
	if (!ctx) return;
	const sessionId = piSessionId(ctx);
	if (!sessionId) return;
	await flushParentUsageTracking(ctx.cwd, sessionId, true).catch(() =>
		notifyDeferred(ctx),
	);
}
