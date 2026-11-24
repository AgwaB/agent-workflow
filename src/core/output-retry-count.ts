/**
 * Every "output retries" counter (inspect, run telemetry and metrics, the terminal summary and `wait`'s
 * `outputRetryAttempts`, the dashboard) means attempts made after the first, and derives from this one function.
 * The raw task record is different on purpose: `outputRetry.attempts` stays the number of the invalid attempt
 * just recorded (docs/usage.md: `attempts: 3` for a task that failed after 3 attempts).
 *
 * `outputRetry.attempts` is the number of the invalid attempt that was just recorded. While repairs remain it
 * equals the repairs scheduled; once they are exhausted it also counts the last attempt, which is not a retry
 * (with AGENT_WORKFLOW_ARTIFACT_OUTPUT_RETRIES=0 the one failing attempt used to read as "output=1").
 */
export function outputRetriesUsed(attempts: unknown, reason: unknown): number {
	if (typeof attempts !== "number" || !Number.isFinite(attempts)) return 0;
	const count = Math.max(0, Math.floor(attempts));
	const exhausted = typeof reason === "string" && reason.endsWith("_exhausted");
	return exhausted ? Math.max(0, count - 1) : count;
}
