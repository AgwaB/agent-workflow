import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";

/**
 * Waits for a condition instead of a fixed time: polls `read` until `accepts` holds for its value and returns
 * that value. The deadline only guards against a hang; it is not what the test checks.
 */
export async function waitUntil(
	read,
	what,
	{ accepts = Boolean, timeoutMs = 30_000, intervalMs = 20 } = {},
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (accepts(value)) return value;
		if (Date.now() >= deadline)
			throw new Error(
				`timed out waiting for ${what}; last value: ${inspect(value, { depth: 3 })}`,
			);
		await sleep(intervalMs);
	}
}
