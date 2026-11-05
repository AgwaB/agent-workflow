#!/usr/bin/env node
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
