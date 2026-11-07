import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP4c-1): the engine on the runtime API. Workflows run through the real
// engine → task runner → runtime durable worker → executor descriptor (the SDK fake executor
// wrapped by test/helpers/workflow-executor-fixture.mjs). No model or agent-CLI calls.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
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
const requiredReads = await import("../../dist/core/required-reads.js");
const artifactTool = await import("../../dist/core/workflow-artifact-tool.js");
const taskBackend = await import("../../dist/core/task-runner.js");
const notices = await import("../../dist/core/workflow-notices.js");
const runtimeApi = await import("../../dist/runtime/api.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp4c1-")));
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function project(name) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		[
			"---",
			"name: reader",
			"description: reads and reports",
			"tools: read",
			"---",
			"You read workflow artifacts and report.",
			"",
		].join("\n"),
	);
	return cwd;
}

async function writeSpec(cwd, spec) {
	const path = join(cwd, "workflow.json");
	await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`);
	return path;
}

const TWO_STAGE = {
	schemaVersion: 1,
	name: "wp4c1-two-stage",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{
				id: "b",
				type: "single",
				prompt: "Summarize stage a.",
				from: "a",
				inputPolicy: { requiredReads: ["a.control"], enforcement: "fail" },
			},
		],
	},
};

function register(config) {
	const descriptor = workflowFixtureDescriptor(config);
	unregister.push(core.registerWorkflowExecutor(descriptor));
	return descriptor;
}

function fastLaunchControls(extra = {}) {
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
		...extra,
	});
}

function taskBySpec(run, specId) {
	const task = run.tasks.find(
		(item) => item.specId === specId || item.stageId === specId,
	);
	assert.ok(task, `missing task ${specId}`);
	return task;
}

test("two-stage workflow runs end to end: engine → task runner → durable worker → fake executor", async () => {
	fastLaunchControls();
	const cwd = await project("e2e");
	const effectLog = join(root, "e2e-effects.jsonl");
	register({
		id: "wf-fake",
		effectLog,
		reads: [{ source: "a", artifact: "control" }],
		ownSessions: "always",
	});
	const specPath = await writeSpec(cwd, TWO_STAGE);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "summarize the fixture",
		executor: "wf-fake",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));

	// The completed run record lives under .agent-workflow/workflows/.
	const runJson = join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		run.runId,
		"run.json",
	);
	assert.equal(existsSync(runJson), true);
	const persisted = JSON.parse(await readFile(runJson, "utf8"));
	assert.equal(persisted.status, "completed");
	assert.equal(persisted.executor.id, "wf-fake");
	assert.equal(persisted.executor.source, "run-flag");
	assert.equal(existsSync(join(cwd, ".pi")), false);

	const a = taskBySpec(persisted, "a");
	const b = taskBySpec(persisted, "b");
	assert.equal(a.status, "completed");
	assert.equal(b.status, "completed");
	// Runtime runs live under .agent-workflow/worker-runs/<run>/<task>.
	assert.equal(
		b.durableLaunchBarrier.records.at(-1).phase,
		"acknowledged",
		JSON.stringify(b.durableLaunchBarrier),
	);

	const entries = readFixtureLog(effectLog);
	const submits = entries.filter((entry) => entry.type === "submit");
	assert.equal(submits.length, 2);
	for (const submit of submits) {
		assert.match(
			submit.attemptKey,
			new RegExp(`^awf1:${run.runId}:task-[0-9]+:[0-9a-f]{16}$`),
		);
		assert.equal(submit.readOnly, true);
		assert.deepEqual(submit.isolation, { inherit: false });
		assert.ok(submit.envKeys.includes("AGENT_WORKFLOW_ROLE"));
		assert.equal(submit.hasSystemPrompt, true);
		assert.ok(!submit.approvalAllowKinds.includes("edit"));
		assert.ok(!submit.approvalAllowKinds.includes("execute"));
	}
	const bSubmit = submits.find((entry) => entry.attemptKey.includes(b.taskId));
	assert.deepEqual(bSubmit.mcpServers, ["workflow_artifact"]);
	assert.ok(bSubmit.tools.includes("workflow_artifact"));
	assert.ok(
		entries.some(
			(entry) =>
				entry.type === "artifact-read" &&
				entry.attemptKey === bSubmit.attemptKey &&
				entry.source === "a",
		),
		JSON.stringify(entries),
	);
	for (const submit of submits) {
		const consumes = entries.filter(
			(entry) =>
				entry.type === "consume" && entry.attemptKey === submit.attemptKey,
		);
		assert.deepEqual(
			consumes.map((entry) => entry.outcome),
			["released"],
		);
		assert.equal(
			entries.filter(
				(entry) =>
					entry.type === "effect" && entry.attemptKey === submit.attemptKey,
			).length,
			1,
		);
	}
	// Stage b launched only after stage a's effect.
	const aEffect = entries.findIndex(
		(entry) => entry.type === "effect" && entry.attemptKey.includes(a.taskId),
	);
	const bSubmitIndex = entries.indexOf(bSubmit);
	assert.ok(aEffect >= 0 && aEffect < bSubmitIndex);

	// R#10: owned worker sessions are recorded; D3 (WP12a): the completed run already released
	// them through deleteOwnedSession, so pruning has nothing left to delete.
	const owned = persisted.tasks.flatMap((task) => task.ownedSessions ?? []);
	assert.equal(owned.length, 2);
	assert.deepEqual(
		owned.map((entry) => entry.release?.outcome),
		["deleted", "deleted"],
	);
	// The in-process supervisor (same pid as this test) may still be finishing after the run
	// is terminal and can refresh its lease heartbeat. Prune correctly refuses a run whose
	// supervisor looks alive, so wait for the supervisor lock to clear, age the lease records,
	// and retry while the supervisor's last heartbeat races the ageing (test-only race).
	const runDir = join(stateDir(cwd), ".agent-workflow", "workflows", run.runId);
	let summary;
	let pruned;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		// The lock and its release/reclaim files (release renames the lock before removing it).
		if (
			readdirSync(runDir).some(
				(name) =>
					name === "supervisor.lock" || name.startsWith("supervisor.lock."),
			)
		) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			continue;
		}
		for (const name of ["supervisor.json", "supervisor-lease.json"]) {
			const file = join(runDir, name);
			if (!existsSync(file)) continue;
			const record = JSON.parse(await readFile(file, "utf8"));
			const stale = new Date(Date.now() - 3_600_000).toISOString();
			await writeFile(
				file,
				JSON.stringify({ ...record, heartbeatAt: stale, updatedAt: stale }),
			);
		}
		summary = await retention.pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		pruned = summary.runs.find((entry) => entry.runId === run.runId);
		// Both are the supervisor still finishing (a heartbeat after the ageing above).
		if (
			pruned?.error !== "supervisor lease acquired concurrently" &&
			pruned?.error !== "live or indeterminate supervisor lease"
		)
			break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	assert.equal(pruned.deleted, true, JSON.stringify(summary));
	assert.deepEqual(pruned.ownedSessions, {
		deleted: 0,
		notFound: 0,
		unsupported: 0,
	});
	const deletions = readFixtureLog(effectLog).filter(
		(entry) => entry.type === "delete-owned-session",
	);
	assert.deepEqual(
		deletions.map((entry) => entry.locator).sort(),
		owned.map((entry) => entry.locator).sort(),
	);
	assert.equal(existsSync(runJson), false);
});

test("stop during stage 1 revokes the durable barrier before consume: no effect", async () => {
	const cwd = await project("stop");
	const effectLog = join(root, "stop-effects.jsonl");
	register({ id: "wf-stop", effectLog });
	const specPath = await writeSpec(cwd, TWO_STAGE);
	const runId = "wp4c1-stop-run";
	let stopRequested = false;
	fastLaunchControls({
		beforeDurableBarrierRelease: async () => {
			stopRequested = true;
			await store.requestWorkflowStop(cwd, runId);
		},
	});
	try {
		await engine
			.runWorkflowSpec(specPath, cwd, {
				task: "stop me",
				executor: "wf-stop",
				runId,
			})
			.catch(() => undefined);
		const run = await engine.waitForRun(cwd, runId, 60_000);
		assert.equal(stopRequested, true);
		const a = taskBySpec(run, "a");
		const b = taskBySpec(run, "b");
		assert.notEqual(a.status, "completed");
		assert.notEqual(b.status, "completed");
		const record = a.durableLaunchBarrier.records.at(-1);
		assert.equal(record.releaseWinner, false, JSON.stringify(record));
		assert.ok(
			["revoked", "cancellation_acknowledged"].includes(record.phase),
			record.phase,
		);
		const entries = readFixtureLog(effectLog);
		// The worker reached its effect boundary (READY) and was told "revoked".
		const consumes = entries.filter((entry) => entry.type === "consume");
		assert.deepEqual(
			consumes.map((entry) => entry.outcome),
			["revoked"],
			JSON.stringify(entries),
		);
		assert.equal(
			entries.filter((entry) => entry.type === "effect").length,
			0,
			JSON.stringify(entries),
		);
		assert.equal(entries.filter((entry) => entry.type === "submit").length, 1);
		assert.equal(b.workerHandle, undefined);
	} finally {
		fastLaunchControls();
	}
});

test("runtime needs_decision blocks the task and the run with a notice; nothing retries", async () => {
	fastLaunchControls();
	const cwd = await project("needs-decision");
	const effectLog = join(root, "needs-decision-effects.jsonl");
	register({ id: "wf-crash", effectLog, mode: "crash-after-consume" });
	const specPath = await writeSpec(cwd, {
		schemaVersion: 1,
		name: "wp4c1-needs-decision",
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "only", type: "single", prompt: "Do it." }],
		},
	});
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "crash after consume",
		executor: "wf-crash",
	});
	let run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "blocked", JSON.stringify(run.tasks, null, 2));
	const task = taskBySpec(run, "only");
	assert.equal(task.status, "blocked");
	assert.equal(task.statusDetail, core.EXECUTOR_NEEDS_DECISION_STATUS_DETAIL);
	assert.equal(task.launchRetry, undefined);
	assert.match(task.lastMessage, /owner decision/);
	// The worker itself recorded the decision (it did not exit without a result): no worker line.
	assert.doesNotMatch(task.lastMessage, /; worker: /);
	const result = JSON.parse(
		await readFile(join(stateDir(cwd), task.files.result), "utf8"),
	);
	assert.equal(result.failureKind, "needs_decision");

	// No automatic retry or relaunch, even after more scheduler passes.
	await new Promise((resolve) => setTimeout(resolve, 300));
	run = await engine.refreshRun(cwd, started.runId);
	assert.equal(run.status, "blocked");
	const entries = readFixtureLog(effectLog);
	assert.equal(entries.filter((entry) => entry.type === "submit").length, 1);
	assert.deepEqual(
		entries
			.filter((entry) => entry.type === "reconcile")
			.map((entry) => Object.keys(entry.result)[0]),
		["unknown"],
	);

	// The blocked run surfaces as a notice.
	const listed = JSON.parse(
		await notices.executeWorkflowNoticesCommand(cwd, ["list", "--json"]),
	);
	assert.ok(
		listed.notices.some(
			(notice) => notice.runId === run.runId && notice.status === "blocked",
		),
		JSON.stringify(listed),
	);
});

test("runtime not_started is eligible for the normal retry policy with a new attempt key", async () => {
	fastLaunchControls();
	const cwd = await project("not-started");
	const effectLog = join(root, "not-started-effects.jsonl");
	register({ id: "wf-retry", effectLog });
	const specPath = await writeSpec(cwd, {
		schemaVersion: 1,
		name: "wp4c1-not-started",
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "only", type: "single", prompt: "Do it." }],
		},
	});
	// Injected runtime API: the first launch is "orphaned" and reconcile proves it never started;
	// later launches go to the real runtime. No barrier functions → the injected path skips it.
	const fakeRunId = "run_notstarted_fake";
	const calls = [];
	const injected = {
		async runWorker(options) {
			calls.push(options);
			if (calls.length === 1)
				return {
					runId: fakeRunId,
					attemptId: "attempt_1",
					status: "running",
					artifacts: [],
				};
			return runtimeApi.runWorker(options);
		},
		async getWorkerStatus(options) {
			if (options.runId !== fakeRunId)
				return runtimeApi.getWorkerStatus(options);
			const now = new Date().toISOString();
			return {
				runId: fakeRunId,
				attemptId: "attempt_1",
				executorId: "wf-retry",
				status: "failed",
				failureKind: "not_started",
				startedAt: now,
				completedAt: now,
				logs: [],
				metadata: {},
			};
		},
		async reconcileWorkerRun(options) {
			if (options.runId !== fakeRunId)
				return runtimeApi.reconcileWorkerRun(options);
			return { status: "marked-not-started", runId: fakeRunId, record: null };
		},
		interruptWorker: (options) => runtimeApi.interruptWorker(options),
	};
	core.setTaskRuntimeApiForTests(injected);
	try {
		const started = await engine.runWorkflowSpec(specPath, cwd, {
			task: "retry after not_started",
			executor: "wf-retry",
		});
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));
		const task = taskBySpec(run, "only");
		assert.equal(task.launchRetry.attempts, 1);
		assert.equal(task.launchRetry.reason, "not_started");
		assert.equal(calls.length, 2);
		assert.notEqual(calls[0].attemptKey, calls[1].attemptKey);
		assert.equal(calls[0].executor.id, "wf-retry");
		assert.equal(calls[0].thinking, undefined);
		assert.equal(calls[0].executorId, undefined);
		const submits = readFixtureLog(effectLog).filter(
			(entry) => entry.type === "submit",
		);
		assert.deepEqual(
			submits.map((entry) => entry.attemptKey),
			[calls[1].attemptKey],
		);
	} finally {
		core.setTaskRuntimeApiForTests(undefined);
	}
});

test("an unknown or unavailable executor fails the run before any launch", async () => {
	fastLaunchControls();
	const cwd = await project("missing");
	const specPath = await writeSpec(cwd, TWO_STAGE);
	await assert.rejects(
		engine.runWorkflowSpec(specPath, cwd, { task: "t", executor: "nope" }),
		(error) =>
			error instanceof core.WorkflowExecutorUnavailableError &&
			/executor "nope" from run flag is unknown/.test(error.message),
	);
	// All built-in adapters (pi, codex, claude) exist since WP6–WP8; the unknown-id refusal above
	// is the remaining no-substitution case reachable from a run flag.
	assert.equal(
		existsSync(join(stateDir(cwd), ".agent-workflow", "workflows")) &&
			(await import("node:fs")).readdirSync(
				join(stateDir(cwd), ".agent-workflow", "workflows"),
			).length > 0,
		false,
	);
	assert.equal(
		existsSync(join(stateDir(cwd), ".agent-workflow", "worker-runs")),
		false,
	);
});

test("executor precedence: run flag > workflow profile > user profile > default", async () => {
	register({ id: "wf-a", effectLog: join(root, "unused.jsonl") });
	register({ id: "wf-b", effectLog: join(root, "unused.jsonl") });
	register({ id: "wf-c", effectLog: join(root, "unused.jsonl") });
	const all = {
		runFlag: "wf-a",
		workflowProfileName: "fast",
		workflowProfileExecutor: "wf-b",
		userProfileName: "mine",
		userProfileExecutor: "wf-c",
		defaultExecutor: "wf-c",
	};
	assert.equal(core.resolveRunExecutorSelection(all).id, "wf-a");
	const profile = core.resolveRunExecutorSelection({
		...all,
		runFlag: undefined,
	});
	assert.deepEqual(
		[profile.id, profile.source, profile.profile],
		["wf-b", "workflow-profile", "fast"],
	);
	const user = core.resolveRunExecutorSelection({
		...all,
		runFlag: undefined,
		workflowProfileExecutor: undefined,
	});
	assert.deepEqual([user.id, user.source], ["wf-c", "user-profile"]);
	const fallback = core.resolveRunExecutorSelection({
		defaultExecutor: "wf-a",
	});
	assert.deepEqual([fallback.id, fallback.source], ["wf-a", "default"]);
	// A higher-precedence unknown executor is an error, never a fallback.
	assert.throws(
		() => core.resolveRunExecutorSelection({ ...all, runFlag: "missing" }),
		/executor "missing" from run flag is unknown/,
	);
	assert.throws(
		() =>
			core.resolveRunExecutorSelection({
				workflowProfileName: "fast",
				workflowProfileExecutor: "missing-adapter",
				defaultExecutor: "wf-a",
			}),
		/executor "missing-adapter" from workflow execution profile "fast" is unknown/,
	);

	// Declared profile executors come from the spec and are recorded on the run.
	const cwd = await project("profile");
	const specPath = await writeSpec(cwd, {
		...TWO_STAGE,
		executionProfiles: { quick: {} },
		executionProfileExecutors: { quick: "wf-b" },
	});
	const blocked = engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executionProfile: "quick",
		runId: "wp4c1-profile-run",
	});
	const run = await blocked;
	assert.equal(run.executor.id, "wf-b");
	assert.equal(run.executor.source, "workflow-profile");
	await engine.stopRun(cwd, run.runId).catch(() => undefined);
	await engine.waitForRun(cwd, run.runId, 60_000).catch(() => undefined);
});

test("required reads: ledger rows marked deliveryUnverified never satisfy a read", async () => {
	const taskDir = join(root, "ledger-task");
	await mkdir(taskDir, { recursive: true });
	const row = {
		schema: "placeholder",
		runId: "run-x",
		taskId: "task-2",
		source: "a",
		artifact: "control",
		at: new Date().toISOString(),
		bytes: 10,
		returnedBytes: 10,
		truncated: false,
	};
	const ledger = join(taskDir, "read-ledger.jsonl");
	const schema = (
		await readFile(
			new URL("../../dist/core/workflow-artifact-tool.js", import.meta.url),
			"utf8",
		)
	).match(/WORKFLOW_ARTIFACT_READ_SCHEMA = "([^"]+)"/)?.[1];
	assert.ok(schema);
	row.schema = schema;

	await writeFile(
		ledger,
		`${JSON.stringify({ ...row, deliveryUnverified: true })}\n`,
	);
	const parsed = await artifactTool.readWorkflowArtifactReadLedger(ledger);
	assert.equal(parsed[0].deliveryUnverified, true);
	const unverified = await requiredReads.checkRequiredArtifactReads(
		taskDir,
		["a.control"],
		[{ source: "a", artifact: "control" }],
	);
	assert.deepEqual(unverified.missing, ["a.control"]);

	await writeFile(ledger, `${JSON.stringify(row)}\n`);
	const verified = await requiredReads.checkRequiredArtifactReads(taskDir, [
		"a.control",
	]);
	assert.deepEqual(verified.missing, []);

	await writeFile(
		ledger,
		`${JSON.stringify({ ...row, deliveryUnverified: "yes" })}\n`,
	);
	const invalid = await requiredReads.checkRequiredArtifactReads(taskDir, [
		"a.control",
	]);
	assert.deepEqual(invalid.missing, ["a.control"]);
	assert.match(invalid.ledgerError, /deliveryUnverified must be a boolean/);
});

test("attempt keys are engine-issued and stable per task attempt", () => {
	const run = { runId: "run-1" };
	const task = { taskId: "task-3" };
	const first = {
		attemptKey: "launch-retry:0;output-retry:0;resume:0;session:none",
	};
	const again = taskBackend.workflowExecutorAttemptKey(run, task, first);
	assert.equal(taskBackend.workflowExecutorAttemptKey(run, task, first), again);
	assert.match(again, /^awf1:run-1:task-3:[0-9a-f]{16}$/);
	assert.notEqual(
		taskBackend.workflowExecutorAttemptKey(run, task, {
			attemptKey: "launch-retry:1;output-retry:0;resume:0;session:none",
		}),
		again,
	);
	assert.notEqual(
		taskBackend.workflowExecutorAttemptKey({ runId: "run-2" }, task, first),
		again,
	);
});

test("SubmitRequest mapping: approvals, isolation, MCP servers, worktree gate (R#5)", () => {
	const readOnlyTask = {
		inheritProjectContext: undefined,
		runtime: { tools: ["read", "grep", "bash", "edit"] },
		safety: { capability: "read-only", requiresWorktree: false },
	};
	assert.deepEqual(taskBackend.workflowTaskApprovalPolicy(readOnlyTask), {
		allowKinds: ["read", "search"],
		interactive: false,
	});
	const writeTask = {
		...readOnlyTask,
		safety: { capability: "write-capable", requiresWorktree: true },
	};
	assert.deepEqual(
		taskBackend.workflowTaskApprovalPolicy(writeTask).allowKinds,
		["edit", "execute", "read", "search"],
	);
	assert.deepEqual(taskBackend.workflowTaskIsolation(readOnlyTask), {
		inherit: false,
	});
	assert.deepEqual(
		taskBackend.workflowTaskIsolation({ ...readOnlyTask, inheritSkills: true }),
		{ inherit: true },
	);
	const server = {
		name: "workflow_artifact",
		command: "/node",
		args: ["s.js"],
	};
	assert.deepEqual(
		taskBackend.preparedMcpServers({
			toolProviders: {
				read: { classification: "read-only" },
				workflow_artifact: { classification: "read-only", mcpServer: server },
			},
			artifactBinding: { serverSpec: server },
		}),
		[server],
	);
	assert.throws(
		() =>
			taskBackend.preparedMcpServers({
				toolProviders: { workflow_artifact: { mcpServer: server } },
				artifactBinding: { serverSpec: { ...server, args: ["other.js"] } },
			}),
		/drifted/,
	);
	// R#5: a worktree-requiring task never launches outside its managed worktree.
	assert.throws(
		() =>
			taskBackend.assertWorktreeEnforced(
				{ taskId: "task-1", cwd: "/repo", worktree: { enabled: false } },
				writeTask,
			),
		/requires a managed worktree/,
	);
	assert.throws(
		() =>
			taskBackend.assertWorktreeEnforced(
				{
					taskId: "task-1",
					cwd: "/repo",
					worktree: { enabled: true, path: "/repo/.agent-workflow/wt/t1" },
				},
				writeTask,
			),
		/requires a managed worktree/,
	);
	taskBackend.assertWorktreeEnforced(
		{
			taskId: "task-1",
			cwd: "/repo/.agent-workflow/wt/t1",
			worktree: { enabled: true, path: "/repo/.agent-workflow/wt/t1" },
		},
		writeTask,
	);
	taskBackend.assertWorktreeEnforced(
		{ taskId: "task-1", cwd: "/repo", worktree: { enabled: false } },
		readOnlyTask,
	);
});
