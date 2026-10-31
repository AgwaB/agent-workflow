// New in agent-workflow (WP2c): SubmitRequest.env and mcpServers[].env values are never written to
// disk by the runtime (D1: the engine stores no credentials). worker.json keeps only the keys; the
// values reach the detached durable worker through its spawn environment; the execution plan
// digest hashes each value so it still changes when only a value changes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	beginRunRecord,
	buildExecutionPlan,
	buildSubmitRequestFields,
	createAttemptArtifactStore,
	createDurableLaunchBarrierV2,
	executionPlanDigest,
	readRunEvents,
	resolveDurableLaunchBarrierV2Release,
	runSubagent,
	runtimeWorkerPath,
	upsertRunAttempt,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
	waitForSubagent,
	writeDurableWorkerPayload,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let root;
let counter = 0;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-env-at-rest-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function fresh(label) {
	counter += 1;
	return {
		cwd: join(root, `${label}-${counter}`),
		effectLog: join(root, `${label}-${counter}.effects.jsonl`),
		barrierDir: join(root, `${label}-${counter}.barrier`),
	};
}

/** Every regular file under `dir` (recursively) whose bytes contain one of `needles`. */
async function filesContaining(dir, needles) {
	const hits = [];
	let scanned = 0;
	async function walk(path) {
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile()) {
				scanned += 1;
				const bytes = await readFile(child);
				for (const needle of needles)
					if (bytes.includes(Buffer.from(needle))) hits.push(child);
			}
		}
	}
	await walk(dir);
	return { hits, scanned };
}

function secrets() {
	return {
		token: `tok-${randomBytes(18).toString("hex")}`,
		mcp: `mcp-${randomBytes(18).toString("hex")}`,
	};
}

async function waitTerminal(cwd, run) {
	const waited = await waitForSubagent({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs: 20_000,
		pollIntervalMs: 25,
	});
	assert.equal(waited.status, "completed", JSON.stringify(waited));
	return waited.snapshot;
}

async function waitFor(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail("condition not reached");
}

test("async run with a barrier: no env value anywhere on disk; the executor still receives them", async () => {
	const { cwd, effectLog, barrierDir } = fresh("async");
	await mkdir(cwd, { recursive: true });
	const secret = secrets();
	const descriptor = await createDurableLaunchBarrierV2({
		directory: barrierDir,
		subjectSha256: sha256(`subject:${barrierDir}`),
		timeoutMs: 20_000,
		pollIntervalMs: 5,
	});
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "use the token",
		env: { SECRET_TOKEN: secret.token, PLAIN: "visible-ok" },
		mcpServers: [
			{
				name: "artifacts",
				command: "node",
				args: ["server.mjs"],
				env: { MCP_API_KEY: secret.mcp },
			},
		],
		async: true,
		durableLaunchBarrier: descriptor,
	});
	const ready = await waitForDurableLaunchBarrierV2Ready(descriptor);
	const resolution = await resolveDurableLaunchBarrierV2Release(
		descriptor,
		ready,
		sha256(`release:${ready.readySha256}`),
	);
	await waitForDurableLaunchBarrierV2Ack(descriptor, resolution.decision);
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "completed", JSON.stringify(snapshot));
	// Let the finalizer publish before scanning.
	await new Promise((resolve) => setTimeout(resolve, 500));

	const submit = readEffectLog(effectLog).find(
		(entry) => entry.type === "submit",
	);
	assert.deepEqual(
		submit.envSha256,
		{ SECRET_TOKEN: sha256(secret.token), PLAIN: sha256("visible-ok") },
		"the executor received the env values",
	);
	assert.deepEqual(submit.mcpEnvSha256, [{ MCP_API_KEY: sha256(secret.mcp) }]);

	const attemptDir = join(
		cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
	const worker = JSON.parse(
		await readFile(join(attemptDir, "worker.json"), "utf8"),
	);
	assert.equal(worker.input.env, undefined);
	assert.deepEqual(worker.input.envKeys, ["PLAIN", "SECRET_TOKEN"]);
	assert.equal(worker.input.mcpServers[0].env, undefined);
	assert.deepEqual(worker.input.mcpServers[0].envKeys, ["MCP_API_KEY"]);

	for (const dir of [cwd, barrierDir, join(root, "run-index")]) {
		const { hits, scanned } = await filesContaining(dir, [
			secret.token,
			secret.mcp,
		]);
		assert.deepEqual(hits, [], `no env value under ${dir}`);
		if (dir === cwd) assert.ok(scanned >= 8, `scanned ${scanned} files`);
	}
	// The effect log (outside the run) holds digests only.
	assert.deepEqual(
		(await filesContaining(root, [secret.token, secret.mcp])).hits,
		[],
	);
});

test("sync run: no env value on disk either", async () => {
	const { cwd, effectLog } = fresh("sync");
	await mkdir(cwd, { recursive: true });
	const secret = secrets();
	const result = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog }),
		task: "sync token",
		env: { SECRET_TOKEN: secret.token },
		mcpServers: [
			{ name: "m", command: "x", args: [], env: { MCP_API_KEY: secret.mcp } },
		],
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(
		readEffectLog(effectLog).find((entry) => entry.type === "submit").envSha256,
		{ SECRET_TOKEN: sha256(secret.token) },
	);
	assert.deepEqual(
		(await filesContaining(root, [secret.token, secret.mcp])).hits,
		[],
	);
});

test("execution plan: values are hashed per key; the digest changes when only a value changes", () => {
	const secret = secrets();
	const plan = (env, mcpEnv) =>
		buildExecutionPlan({
			executor: fixtureDescriptor({ effectLog: "/tmp/x.jsonl" }),
			runId: "run_env",
			attemptId: "attempt_env",
			workspace: { mode: "shared", cwd: "/tmp/w", worktreePath: null },
			request: buildSubmitRequestFields({
				input: {
					task: "t",
					env,
					mcpServers: [{ name: "m", command: "c", args: [], env: mcpEnv }],
				},
				runId: "run_env",
				attemptId: "attempt_env",
				cwd: "/tmp/w",
				startedAt: "2026-10-26T00:00:00.000Z",
			}),
		});
	const base = plan({ SECRET_TOKEN: secret.token }, { K: secret.mcp });
	assert.equal(
		JSON.stringify(base).includes(secret.token) ||
			JSON.stringify(base).includes(secret.mcp),
		false,
		"the plan object carries no value",
	);
	assert.deepEqual(base.request.env, {
		SECRET_TOKEN: `sha256:${sha256(secret.token)}`,
	});
	assert.deepEqual(base.request.mcpServers[0].env, {
		K: `sha256:${sha256(secret.mcp)}`,
	});
	const digest = executionPlanDigest(base);
	assert.equal(
		executionPlanDigest(
			plan({ SECRET_TOKEN: secret.token }, { K: secret.mcp }),
		),
		digest,
	);
	assert.notEqual(
		executionPlanDigest(plan({ SECRET_TOKEN: "other" }, { K: secret.mcp })),
		digest,
		"env value change",
	);
	assert.notEqual(
		executionPlanDigest(plan({ SECRET_TOKEN: secret.token }, { K: "other" })),
		digest,
		"mcp env value change",
	);
	assert.notEqual(
		executionPlanDigest(plan({ OTHER: secret.token }, { K: secret.mcp })),
		digest,
		"env key change",
	);
});

test("a worker started without the env channel fails closed with guard_failure, naming keys only", async () => {
	const { cwd, effectLog } = fresh("no-channel");
	await mkdir(cwd, { recursive: true });
	const runId = "run_env_no_channel";
	const attemptId = "attempt_env_no_channel";
	const executor = fixtureDescriptor({ effectLog });
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const payloadPath = store.pathFor("worker");
	const startedAt = new Date();
	await writeDurableWorkerPayload({
		payloadPath,
		input: {
			task: "needs a token",
			envKeys: ["SECRET_TOKEN"],
			attemptKey: `${runId}:${attemptId}`,
		},
		cwd,
		backend: executor.id,
		executor,
		runId,
		attemptId,
		startedAt: startedAt.toISOString(),
	});
	const running = await store.writeResult({
		backend: executor.id,
		status: "running",
		failureKind: null,
		cwd,
		startedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await upsertRunAttempt({
		cwd,
		runId,
		attemptId,
		status: "running",
		backend: executor.id,
		startedAt,
		artifactCwd: cwd,
		resultPath: running.artifacts.find((artifact) => artifact.type === "result")
			?.path,
		createOnly: true,
		requireNoActive: true,
		activate: true,
	});
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: executor.id,
		startedAt,
		activeAttemptId: attemptId,
		attempts: [],
	});
	const env = { ...process.env };
	delete env.AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON;
	spawn(process.execPath, [runtimeWorkerPath("durable-worker"), payloadPath], {
		cwd,
		detached: process.platform !== "win32",
		stdio: "ignore",
		env,
	}).unref();
	const snapshot = await waitTerminal(cwd, { runId, attemptId });
	assert.equal(snapshot.status, "failed", JSON.stringify(snapshot));
	assert.equal(snapshot.failureKind, "guard_failure");
	// WP2b terminal-last-write: stderr.log is complete once the result is terminal (no polling).
	assert.match(
		await readFile(join(store.attemptDir, "stderr.log"), "utf8"),
		/SECRET_TOKEN/u,
	);
	assert.deepEqual(readEffectLog(effectLog), [], "nothing was submitted");
	// WP2b: the terminal finalizer is still committing/publishing after the registry turned
	// terminal; removing the fixture under it (after()) raced it (ENOTEMPTY on rm).
	await waitFor(async () => {
		const events = await readRunEvents({ cwd, runId }, Infinity);
		return events.some((event) => event.type === "run.failed");
	});
});
