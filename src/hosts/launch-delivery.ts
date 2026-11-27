import type { WorkflowRunRecord } from "../core/types.js";
import { isSettledRun } from "./notify-check.js";

/** Check the original launcher's notifier, not the current driver's lease. */
export function codexLaunchNotifierCanWake(
	run: WorkflowRunRecord | undefined,
	pid: number | undefined,
): boolean {
	if (run?.launch?.source !== "mcp:codex" || isSettledRun(run)) return false;
	// A resumed task may be driven by an attached process, which does not queue a result.
	if (run.tasks.some((task) => task.resumeEvents?.length)) return false;
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
