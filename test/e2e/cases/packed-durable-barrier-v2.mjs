#!/usr/bin/env node
//
//   node test/e2e/cases/packed-durable-barrier-v2.mjs <installed-package-root> <consumer-project>
// Release: READY → released decision → ACK → the durable worker's executor makes its one effect →
// completed. Revoke after READY: a later release resolves `revoked`, the worker ends cancelled
// (failureKind revoked) and the executor never makes an effect.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [packageRootArg, consumerArg] = process.argv.slice(2);
if (!packageRootArg || !consumerArg)
	throw new Error(
		"usage: packed-durable-barrier-v2.mjs <installed-package-root> <consumer-project>",
	);
const packageRoot = await realpath(packageRootArg);
const consumerRoot = await realpath(resolve(consumerArg));
const consumerRequire = createRequire(join(consumerRoot, "package.json"));
const runtimePath = consumerRequire.resolve("@agwab/agent-workflow/runtime");
assert.ok(
	runtimePath.startsWith(`${packageRoot}/`),
	"the runtime resolves to the packed package",
);
const api = await import(pathToFileURL(runtimePath).href);
for (const name of [
	"createDurableLaunchBarrierV2",
	"resolveDurableLaunchBarrierV2Release",
	"revokeDurableLaunchBarrierV2",
	"waitForDurableLaunchBarrierV2Ready",
	"waitForDurableLaunchBarrierV2Ack",
	"runWorker",
	"waitForWorker",
])
	assert.equal(typeof api[name], "function", `missing ${name}`);

const root = join(consumerRoot, "packed-durable-barrier-v2");
const cwd = join(root, "project");
await rm(root, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });
const executorModule = join(consumerRoot, "e2e-executor.mjs");
await cp(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"fixtures",
		"e2e-executor.mjs",
	),
	executorModule,
);
const { e2eExecutorDescriptor } = await import(
	pathToFileURL(executorModule).href
);

async function effects(path) {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function launch(barrier, effectLog, suffix) {
	return api.runWorker({
		cwd,
		executor: e2eExecutorDescriptor({ id: "test-e2e", effectLog }),
		task: `durable barrier ${suffix}`,
		systemPrompt: "Return fixture output.",
		tools: ["read"],
		readOnly: true,
		async: true,
		durableLaunchBarrier: barrier,
	});
}

async function terminal(run) {
	const waited = await api.waitForWorker({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 20,
	});
	assert.equal(waited.status, "completed", JSON.stringify(waited));
	return waited.snapshot;
}

try {
	// Release.
	const releaseLog = join(root, "release-effects.jsonl");
	const releaseBarrier = await api.createDurableLaunchBarrierV2({
		directory: join(root, "release-barrier"),
		subjectSha256: "a".repeat(64),
		authorityBindingSha256: "b".repeat(64),
		timeoutMs: 60_000,
		pollIntervalMs: 5,
	});
	const releasedRun = await launch(releaseBarrier, releaseLog, "release");
	assert.equal(releasedRun.status, "running");
	const ready = await api.waitForDurableLaunchBarrierV2Ready(releaseBarrier);
	assert.equal(ready.runId, releasedRun.runId);
	assert.equal(ready.attemptId, releasedRun.attemptId);
	assert.equal(ready.authorityBindingSha256, "b".repeat(64));
	assert.deepEqual(
		(await effects(releaseLog)).filter((entry) => entry.type === "effect"),
		[],
		"no effect before the release decision",
	);
	const release = await api.resolveDurableLaunchBarrierV2Release(
		releaseBarrier,
		ready,
		"c".repeat(64),
	);
	assert.equal(release.outcome, "released");
	const ack = await api.waitForDurableLaunchBarrierV2Ack(
		releaseBarrier,
		release.decision,
	);
	assert.equal(ack.decisionSha256, release.decision.decisionSha256);
	const releasedSnapshot = await terminal(releasedRun);
	assert.equal(
		releasedSnapshot.status,
		"completed",
		JSON.stringify(releasedSnapshot),
	);
	const released = await effects(releaseLog);
	assert.deepEqual(
		released
			.filter((entry) => entry.type !== "submit")
			.map((entry) => [entry.type, entry.outcome]),
		[
			["consume", "released"],
			["effect", undefined],
		],
	);

	// Revoke after READY.
	const revokeLog = join(root, "revoke-effects.jsonl");
	const revokeBarrier = await api.createDurableLaunchBarrierV2({
		directory: join(root, "revoke-barrier"),
		subjectSha256: "d".repeat(64),
		authorityBindingSha256: "e".repeat(64),
		timeoutMs: 60_000,
		pollIntervalMs: 5,
	});
	const revokedRun = await launch(revokeBarrier, revokeLog, "revoke");
	const revokeReady =
		await api.waitForDurableLaunchBarrierV2Ready(revokeBarrier);
	const revoked = await api.revokeDurableLaunchBarrierV2(revokeBarrier, {
		cancellationId: "packed-e2e-revocation",
		reasonSha256: "f".repeat(64),
	});
	assert.equal(revoked.outcome, "revoked");
	const releaseAfterRevoke = await api.resolveDurableLaunchBarrierV2Release(
		revokeBarrier,
		revokeReady,
		"0".repeat(64),
	);
	assert.equal(releaseAfterRevoke.outcome, "revoked");
	const revokedSnapshot = await terminal(revokedRun);
	assert.equal(
		revokedSnapshot.status,
		"cancelled",
		JSON.stringify(revokedSnapshot),
	);
	assert.equal(revokedSnapshot.failureKind, "revoked");
	const revokedEffects = await effects(revokeLog);
	assert.deepEqual(
		revokedEffects
			.filter((entry) => entry.type !== "submit")
			.map((entry) => [entry.type, entry.outcome]),
		[["consume", "revoked"]],
		"the executor consumed, saw revoked, and made no effect",
	);
	console.log("packed durable launch barrier v2 release/revoke passed");
} finally {
	// Terminal finalizers may still be draining; the runner removes the whole work dir later.
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	}).catch(() => undefined);
}
