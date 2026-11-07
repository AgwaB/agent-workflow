#!/usr/bin/env node
import { appendTerminalEventsIfCurrent } from "../artifacts/index.js";
import type { Status } from "../core/constants.js";
import { reconcileWorkerRun } from "../orchestrate/reconcile.js";
import {
	inspectProcessGroup,
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.js";

interface FinalizerPayload {
	ref: { cwd?: string; runId: string; runsDir?: string };
	attemptId: string;
	status: Status;
	worker: ProcessIdentity;
}

const encoded = process.argv[2];
if (!encoded) process.exit(2);
let payload: FinalizerPayload;
try {
	payload = JSON.parse(
		Buffer.from(encoded, "base64url").toString("utf8"),
	) as FinalizerPayload;
} catch {
	// The original crashed with an uncaught SyntaxError (non-zero exit); keep a non-zero exit.
	process.exit(2);
}
const sleep = (ms: number) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
for (let index = 0; index < 600; index += 1) {
	const workerState = await verifyProcessIdentity(payload.worker);
	const groupState = inspectProcessGroup(payload.worker.processGroupId);
	if (workerState !== "alive" && groupState === "dead") break;
	if (workerState === "unknown" || groupState === "unknown") process.exit(3);
	if (index === 599) process.exit(4);
	await sleep(100);
}
for (let index = 0; index < 100; index += 1) {
	const reconciled = await reconcileWorkerRun({
		...payload.ref,
		staleAfterMs: 0,
		expectedAttemptId: payload.attemptId,
	});
	if (reconciled.status === "superseded") process.exit(0);
	if (
		reconciled.status === "committed-result" ||
		reconciled.status === "already-terminal"
	) {
		if (
			reconciled.record?.activeAttemptId !== null ||
			reconciled.record?.latestAttemptId !== payload.attemptId ||
			reconciled.record?.status !== payload.status
		)
			process.exit(0);
		await appendTerminalEventsIfCurrent(payload.ref, {
			attemptId: payload.attemptId,
			status: payload.status,
			attemptMessage: "durable worker exited and ownership was drained",
			runMessage: `run ${payload.status}`,
		});
		process.exit(0);
	}
	await sleep(100);
}
process.exit(5);
