// New in agent-workflow (WP12a, owner decision D3, plan R#10): worker CLI sessions are not kept by
// default. The engine asks the executor to keep a session only when a same-session repair may
// continue it, and releases every engine-owned session once no attempt can use it again
// (completed/skipped task, completed/failed run). Blocked and interrupted runs keep theirs until
// resolved or pruned. Fake executor only (test/helpers/workflow-executor-fixture.mjs).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");
const retention = await import("../../dist/core/run-retention.js");
const release = await import("../../dist/core/owned-session-release.js");
const flags = await import("../../dist/core/experimental-speed-flags.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-sessions-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	// Durable workers/finalizers may still be closing files: retry like host-cli.test.mjs.
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

const TWO_STAGE = {
	schemaVersion: 1,
	name: "wp12a-sessions",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{ id: "b", type: "single", prompt: "Summarize stage a.", from: "a" },
		],
	},
};

async function project(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead and report.\n",
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(specPath, `${JSON.stringify(TWO_STAGE, null, 2)}\n`);
	return { cwd, specPath };
}

function register(config) {
	const descriptor = workflowFixtureDescriptor(config);
	unregister.push(core.registerWorkflowExecutor(descriptor));
	return descriptor;
}

const submits = (log) =>
	readFixtureLog(log).filter((entry) => entry.type === "submit");
const deletions = (log) =>
	readFixtureLog(log).filter((entry) => entry.type === "delete-owned-session");
const ownedOf = (run) => run.tasks.flatMap((task) => task.ownedSessions ?? []);

test("default: no worker session is requested, so a completed run leaves 0 owned sessions", async () => {
	const { cwd, specPath } = await project("default");
	const effectLog = join(root, "default.jsonl");
	// Like the real adapters: a session is kept (and reported) only when the request asks.
	register({ id: "wf-s-default", effectLog, ownSessions: true });
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "sessions",
		executor: "wf-s-default",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	const sent = submits(effectLog);
	assert.equal(sent.length, 2);
	for (const entry of sent) {
		assert.equal(entry.sessionId, null, JSON.stringify(entry));
		assert.equal(entry.resumeSessionId, null);
	}
	assert.deepEqual(ownedOf(run), []);
	assert.deepEqual(deletions(effectLog), []);
	// The engine session id stays the attempt identity in the run record.
	const identities = run.tasks.flatMap((task) =>
		(task.launchBootstrap?.records ?? []).map((record) => record.sessionId),
	);
	assert.equal(identities.length, 2, JSON.stringify(run.tasks, null, 2));
	for (const sessionId of identities)
		assert.match(sessionId, /^agent-workflow\./);
});

test("an executor that keeps sessions anyway: the completed run deletes every owned session", async () => {
	const { cwd, specPath } = await project("always");
	const effectLog = join(root, "always.jsonl");
	register({ id: "wf-s-always", effectLog, ownSessions: "always" });
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "sessions",
		executor: "wf-s-always",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed");
	const owned = ownedOf(await store.readRunRecord(cwd, run.runId));
	assert.equal(owned.length, 2);
	for (const entry of owned) assert.equal(entry.release?.outcome, "deleted");
	assert.deepEqual(
		deletions(effectLog)
			.map((entry) => entry.locator)
			.sort(),
		owned.map((entry) => entry.locator).sort(),
	);
});

test("experimental same-session repair: the attempt asks to keep its session; the completed run releases it", async () => {
	const { cwd, specPath } = await project("same-session");
	const effectLog = join(root, "same-session.jsonl");
	register({ id: "wf-s-same", effectLog, ownSessions: true });
	const previous = process.env[flags.EXPERIMENTAL_SAME_SESSION_REPAIR_ENV];
	process.env[flags.EXPERIMENTAL_SAME_SESSION_REPAIR_ENV] = "1";
	try {
		const started = await engine.runWorkflowSpec(specPath, cwd, {
			task: "sessions",
			executor: "wf-s-same",
		});
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		assert.equal(run.status, "completed");
		const sent = submits(effectLog);
		assert.equal(sent.length, 2);
		for (const entry of sent)
			assert.match(entry.sessionId ?? "", /^agent-workflow\./);
		const owned = ownedOf(await store.readRunRecord(cwd, run.runId));
		assert.equal(owned.length, 2);
		for (const entry of owned) assert.equal(entry.release?.outcome, "deleted");
		assert.equal(deletions(effectLog).length, 2);
	} finally {
		if (previous === undefined)
			delete process.env[flags.EXPERIMENTAL_SAME_SESSION_REPAIR_ENV];
		else process.env[flags.EXPERIMENTAL_SAME_SESSION_REPAIR_ENV] = previous;
	}
});

test("workflowTaskKeepsSession: only with experimental same-session repair", () => {
	const env = { [flags.EXPERIMENTAL_SAME_SESSION_REPAIR_ENV]: "1" };
	const graph = { artifactGraph: { enabled: true } };
	assert.equal(release.workflowTaskKeepsSession(graph, {}), false);
	assert.equal(release.workflowTaskKeepsSession(graph, env), true);
	assert.equal(
		release.workflowTaskKeepsSession({ artifactGraph: undefined }, env),
		false,
	);
});

function syntheticRun(descriptor, statuses) {
	return {
		runId: "wp12a-synthetic",
		executor: { id: descriptor.id, source: "run-flag", descriptor },
		tasks: statuses.map((status, index) => ({
			taskId: `task-${index + 1}`,
			status,
			statusDetail: status,
			ownedSessions: [
				{
					executorId: descriptor.id,
					kind: "wf-fake-session",
					locator: `session-${index + 1}`,
					backendRunId: `sa-${index + 1}`,
					backendAttemptId: "attempt-1",
					recordedAt: new Date(0).toISOString(),
				},
			],
		})),
	};
}

test("a blocked run keeps sessions of tasks that may resume; completed tasks release theirs; prune still cleans", async () => {
	const effectLog = join(root, "blocked.jsonl");
	const descriptor = workflowFixtureDescriptor({
		id: "wf-s-blocked",
		effectLog,
	});
	const run = syntheticRun(descriptor, [
		"completed",
		"blocked",
		"failed",
		"interrupted",
	]);
	assert.equal(await release.releaseUnneededOwnedSessions(run), true);
	assert.deepEqual(
		deletions(effectLog).map((entry) => entry.locator),
		["session-1"],
	);
	assert.deepEqual(
		run.tasks.map((task) => task.ownedSessions[0].release?.outcome ?? null),
		["deleted", null, null, null],
	);
	// Nothing new to release while the run stays blocked.
	assert.equal(await release.releaseUnneededOwnedSessions(run), false);

	// Prune deletes the kept ones and does not touch the released one again.
	const pruned = await retention.deleteRunOwnedSessions(run);
	assert.deepEqual(pruned, { deleted: 3, notFound: 0, unsupported: 0 });
	assert.deepEqual(
		deletions(effectLog)
			.map((entry) => entry.locator)
			.sort(),
		["session-1", "session-2", "session-3", "session-4"],
	);
});

test("a failed run releases every remaining owned session; never a session of another executor", async () => {
	const effectLog = join(root, "failed.jsonl");
	const descriptor = workflowFixtureDescriptor({
		id: "wf-s-failed",
		effectLog,
	});
	const run = syntheticRun(descriptor, ["completed", "failed", "interrupted"]);
	run.tasks[2].ownedSessions[0].executorId = "someone-else";
	assert.equal(await release.releaseUnneededOwnedSessions(run), true);
	assert.deepEqual(
		deletions(effectLog)
			.map((entry) => entry.locator)
			.sort(),
		["session-1", "session-2"],
	);
	assert.equal(run.tasks[2].ownedSessions[0].release.outcome, "refused");
});

test("deletion failures are recorded and left to prune; executors without deleteOwnedSession are unsupported", async () => {
	const failingLog = join(root, "failing.jsonl");
	const failing = syntheticRun(
		workflowFixtureDescriptor({
			id: "wf-s-failing",
			effectLog: failingLog,
			deleteResult: "failed",
		}),
		["completed"],
	);
	await release.releaseUnneededOwnedSessions(failing);
	assert.equal(failing.tasks[0].ownedSessions[0].release.outcome, "failed");
	assert.equal(
		release.ownedSessionReleased(failing.tasks[0].ownedSessions[0]),
		false,
	);

	const missingLog = join(root, "missing.jsonl");
	const missing = syntheticRun(
		workflowFixtureDescriptor({
			id: "wf-s-missing",
			effectLog: missingLog,
			deleteResult: "missing",
		}),
		["completed"],
	);
	await release.releaseUnneededOwnedSessions(missing);
	assert.equal(
		missing.tasks[0].ownedSessions[0].release.outcome,
		"unsupported",
	);
	assert.deepEqual(deletions(missingLog), []);
});

test("resume still works: an interrupted run resumes with a fresh attempt and releases its sessions", async () => {
	const { cwd, specPath } = await project("resume");
	const effectLog = join(root, "resume.jsonl");
	register({ id: "wf-s-resume", effectLog, ownSessions: "always" });
	const runId = "wp12a-resume-run";
	let stopRequested = false;
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
		beforeDurableBarrierRelease: async () => {
			if (stopRequested) return;
			stopRequested = true;
			await store.requestWorkflowStop(cwd, runId);
		},
	});
	try {
		await engine
			.runWorkflowSpec(specPath, cwd, {
				task: "resume me",
				executor: "wf-s-resume",
				runId,
			})
			.catch(() => undefined);
		const stopped = await engine.waitForRun(cwd, runId, 60_000);
		assert.equal(stopRequested, true);
		assert.notEqual(stopped.status, "completed");
	} finally {
		slots.setSubagentLaunchControlsForTests({
			releaseDelayMs: 0,
			retryJitterMs: 0,
		});
	}
	await engine.resumeRun(cwd, runId);
	const run = await engine.waitForRun(cwd, runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
	const owned = ownedOf(await store.readRunRecord(cwd, runId));
	assert.ok(owned.length >= 2);
	for (const entry of owned) assert.equal(entry.release?.outcome, "deleted");
	for (const entry of submits(effectLog)) assert.equal(entry.sessionId, null);
});
