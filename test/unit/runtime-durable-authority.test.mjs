// New in agent-workflow (WP2a-2): the durable LaunchAuthority in one process — single use
// (in-process and across instances sharing an attempt directory), abort → revoked, V2 barrier
// release/revoke with the engine side simulated, binding handed out only after release, and
// guard failures as typed throws.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	AUTHORITY_RECORD_FILE,
	createDurableLaunchAuthority,
	createDurableLaunchBarrierV2,
	DURABLE_WORKER_BINDING_ENV,
	durableWorkerBindingEnv,
	isDurableAuthorityError,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
} from "../../dist/runtime/index.js";
import { isSdkError } from "../../dist/sdk/index.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let root;
let counter = 0;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-authority-"));
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function attemptDir() {
	counter += 1;
	const dir = join(root, `attempt-${counter}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

function local(dir, extra = {}) {
	return createDurableLaunchAuthority({
		attemptKey: `key-${counter}`,
		runId: `run_${counter}`,
		attemptId: `attempt_${counter}`,
		attemptDir: dir,
		...extra,
	});
}

test("local authority: released once, then AUTHORITY_ALREADY_CONSUMED (also for a second instance)", async () => {
	const dir = await attemptDir();
	const authority = local(dir);
	assert.equal(authority.state(), "unconsumed");
	const decision = await authority.consume();
	assert.equal(decision.kind, "released");
	assert.equal(authority.state(), "released");
	assert.equal(authority.binding(), undefined, "no barrier, no binding");
	assert.deepEqual(durableWorkerBindingEnv(authority), {});
	await assert.rejects(authority.consume(), (error) =>
		isSdkError(error, "AUTHORITY_ALREADY_CONSUMED"),
	);
	const record = JSON.parse(
		await readFile(join(dir, AUTHORITY_RECORD_FILE), "utf8"),
	);
	assert.equal(record.phase, "released");
	assert.equal(record.grantId, decision.grantId);
	// A restarted worker for the same attempt cannot consume again.
	const restarted = local(dir);
	await assert.rejects(restarted.consume(), (error) =>
		isSdkError(error, "AUTHORITY_ALREADY_CONSUMED"),
	);
	assert.equal(restarted.state(), "failed");
});

test("abort before consume resolves revoked (repeatably) without throwing", async () => {
	const dir = await attemptDir();
	const controller = new AbortController();
	controller.abort();
	const authority = local(dir, { signal: controller.signal });
	const first = await authority.consume();
	assert.equal(first.kind, "revoked");
	assert.match(first.reason, /aborted/u);
	assert.deepEqual(await authority.consume(), first);
	assert.equal(authority.state(), "revoked");
});

test("V2 barrier: READY carries both digests, release → binding after ACK", async () => {
	const dir = await attemptDir();
	const descriptor = await createDurableLaunchBarrierV2({
		directory: join(root, `barrier-${counter}`),
		subjectSha256: sha256("subject"),
		timeoutMs: 5_000,
		pollIntervalMs: 5,
	});
	const payload = {
		runId: `run_${counter}`,
		attemptId: `attempt_${counter}`,
		cwd: root,
		input: { durableLaunchBarrier: descriptor },
	};
	const launchPayloadSha256 = sha256("payload");
	const executionPlanSha256 = sha256("plan");
	const authority = local(dir, {
		payload,
		launchPayloadSha256,
		executionPlanSha256,
		executionCwd: root,
	});
	const consumed = authority.consume();
	const ready = await waitForDurableLaunchBarrierV2Ready(descriptor);
	assert.equal(ready.launchPayloadSha256, launchPayloadSha256);
	assert.equal(ready.executionPlanSha256, executionPlanSha256);
	assert.equal(authority.binding(), undefined, "no binding before release");
	const resolution = await resolveDurableLaunchBarrierV2Release(
		descriptor,
		ready,
		sha256("release"),
	);
	const ack = await waitForDurableLaunchBarrierV2Ack(
		descriptor,
		resolution.decision,
	);
	const decision = await consumed;
	assert.equal(decision.kind, "released");
	assert.equal(decision.grantId, resolution.decision.decisionSha256);
	const binding = authority.binding();
	assert.equal(binding.schema, "pi-subagent-durable-worker-binding-v2");
	assert.equal(binding.ackSha256, ack.ackSha256);
	assert.equal(binding.executionPlanSha256, executionPlanSha256);
	assert.deepEqual(Object.keys(durableWorkerBindingEnv(authority)), [
		DURABLE_WORKER_BINDING_ENV,
	]);
	assert.equal(
		DURABLE_WORKER_BINDING_ENV,
		"AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON",
	);
});

test("V2 barrier: engine revoke → revoked (no throw); abort while waiting → revoked", async () => {
	const dir = await attemptDir();
	const descriptor = await createDurableLaunchBarrierV2({
		directory: join(root, `barrier-${counter}`),
		subjectSha256: sha256("subject"),
		timeoutMs: 5_000,
		pollIntervalMs: 5,
	});
	const payload = {
		runId: `run_${counter}`,
		attemptId: `attempt_${counter}`,
		cwd: root,
		input: { durableLaunchBarrier: descriptor },
	};
	const authority = local(dir, {
		payload,
		launchPayloadSha256: sha256("payload"),
		executionPlanSha256: sha256("plan"),
	});
	const consumed = authority.consume();
	await waitForDurableLaunchBarrierV2Ready(descriptor);
	await revokeDurableLaunchBarrierV2(descriptor, {
		cancellationId: "c-1",
		reasonSha256: sha256("stop"),
	});
	const decision = await consumed;
	assert.equal(decision.kind, "revoked");
	assert.match(decision.reason, /c-1/u);
	assert.equal(authority.binding(), undefined);

	const dir2 = await attemptDir();
	const descriptor2 = await createDurableLaunchBarrierV2({
		directory: join(root, `barrier-${counter}`),
		subjectSha256: sha256("subject"),
		timeoutMs: 5_000,
		pollIntervalMs: 5,
	});
	const controller = new AbortController();
	const waiting = local(dir2, {
		payload: { ...payload, input: { durableLaunchBarrier: descriptor2 } },
		launchPayloadSha256: sha256("payload"),
		executionPlanSha256: sha256("plan"),
		signal: controller.signal,
	});
	const pending = waiting.consume();
	await waitForDurableLaunchBarrierV2Ready(descriptor2);
	controller.abort();
	const aborted = await pending;
	assert.equal(aborted.kind, "revoked");
	assert.match(aborted.reason, /aborted/u);
});

test("guard failures throw typed errors: bad descriptor at construction, missing digests in consume", async () => {
	const dir = await attemptDir();
	assert.throws(
		() =>
			local(dir, {
				payload: {
					runId: "r",
					attemptId: "a",
					cwd: root,
					input: { durableLaunchBarrier: { schema: "bogus" } },
				},
			}),
		(error) => isDurableAuthorityError(error),
	);
	const descriptor = await createDurableLaunchBarrierV2({
		directory: join(root, `barrier-guard-${counter}`),
		subjectSha256: sha256("subject"),
		timeoutMs: 1_000,
		pollIntervalMs: 5,
	});
	assert.throws(
		() =>
			local(dir, {
				payload: {
					runId: "r",
					attemptId: "a",
					cwd: root,
					input: { durableLaunchBarrier: descriptor },
				},
				launchPayloadSha256: "not-a-digest",
				executionPlanSha256: sha256("plan"),
			}),
		(error) => isDurableAuthorityError(error),
		"preflight rejects a malformed launch payload digest",
	);
});
