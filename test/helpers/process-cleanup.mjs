// Test cleanup that never kills somebody else's process. A pid kept until a test ends can belong to
// a different process by then: macOS hands pids out again once its counter wraps, and the full suite
// (twice in parallel) wraps it within minutes. Killing a stored pid, or its group, then took down
// another test's durable worker, whose run ended `blocked` (executor_needs_decision: owner gone, no
// result). Record a process's identity (birth time and process group) when its pid is learned;
// at cleanup it is killed only while that same process is still alive.
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../dist/runtime/process-identity.js";

const tracked = new Map();

/** Remember `pid`'s identity now, while it is the process the test started (never throws). */
export function trackProcess(pid) {
	if (!Number.isInteger(pid) || pid <= 0 || tracked.has(pid)) return;
	tracked.set(
		pid,
		captureProcessIdentity(pid).catch(() => undefined),
	);
}

/**
 * SIGKILL `pid` (with `group`, its whole process group) if it is still the process recorded by
 * `trackProcess`. An untracked pid is identified now (the old behaviour: best effort). A process
 * that exited, or a pid now used by another process, is left alone. Never throws.
 */
export async function killTrackedProcess(pid, { group = false } = {}) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	const identity = await (tracked.get(pid) ??
		captureProcessIdentity(pid).catch(() => undefined));
	tracked.delete(pid);
	if (identity === undefined) return;
	if ((await verifyProcessIdentity(identity)) !== "alive") return;
	try {
		// The recorded process is alive in that group, so the group id is still its own.
		process.kill(group ? -identity.processGroupId : identity.pid, "SIGKILL");
	} catch {
		try {
			process.kill(identity.pid, "SIGKILL");
		} catch {
			// Exited meanwhile.
		}
	}
}

/** SIGKILL a child of this process (its group with `group`) only if Node has not seen it exit. */
export function killLiveChild(child, { group = false } = {}) {
	if (
		child?.pid === undefined ||
		child.exitCode !== null ||
		child.signalCode !== null
	)
		return;
	try {
		process.kill(group ? -child.pid : child.pid, "SIGKILL");
	} catch {
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			// Exited meanwhile.
		}
	}
}
