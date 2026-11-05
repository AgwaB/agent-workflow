// Track usage for runs this Pi session launches, resumes, or approves.
// Count each parent assistant message while running and the first settled wrap-up once.
// Resume tracking at session start; flush and detach at shutdown. The sidecar contains
// only numbers, timestamps, session id, and hashes, never message content.
// Tracking needs a session id, not a UI; failed writes warn on stderr without one.
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
