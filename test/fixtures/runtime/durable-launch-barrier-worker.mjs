#!/usr/bin/env node
// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) test/fixtures/durable-launch-barrier-worker.mjs. MIT, same author. Changes: imports the compiled runtime from dist/.
import { readFile, writeFile } from "node:fs/promises";
import {
	assertDurableLaunchBarrierV2ExecutionAuthorized,
	awaitDurableLaunchBarrierV2,
} from "../../../dist/runtime/durable-launch-barrier.js";

const [descriptorPath, markerPath, runId, attemptId, launchPayloadSha256] =
	process.argv.slice(2);
if (
	!descriptorPath ||
	!markerPath ||
	!runId ||
	!attemptId ||
	!launchPayloadSha256
) {
	throw new Error("durable launch barrier fixture arguments are incomplete");
}
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
const options = {
	descriptor,
	runId,
	attemptId,
	launchPayloadSha256,
	executionPlanSha256: "e".repeat(64),
};
const ack = await awaitDurableLaunchBarrierV2(options);
await assertDurableLaunchBarrierV2ExecutionAuthorized(descriptor, ack);
await writeFile(markerPath, "released\n", "utf8");
