// New in agent-workflow (WP2a-2): executeAttempt and the in-process run path. Covers the
// failure-class → status/failureKind table, event and sequence validation (guard_failure),
// post-release submit failure → executor reconcile, timeout before and after release, the
// approval answer policy, usage summation (null ≠ 0), output recovery, idempotent resubmission
// of one attempt, request validation and the execution-plan digest. Ports the still-applicable
// assertions of pi-subagent checks/usage-accumulation.mjs and checks/output-recovery.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import {
	buildExecutionPlan,
	buildSubmitRequestFields,
	createAttemptArtifactStore,
	createDurableLaunchAuthority,
	executeAttempt,
	executionPlanDigest,
	isExecutionNotStartedError,
	NO_DEADLINE_MS,
	runSubagent,
	statusForFailureClass,
	SubagentValidationError,
	summarizeUsage,
	validateRuntimeRunInput,
} from "../../dist/runtime/index.js";
import {
	createExecutorRegistry,
	defaultApprovalPolicy,
	EXECUTOR_CONTRACT_VERSION,
	requireReleased,
} from "../../dist/sdk/index.js";
import {
	createFakeExecutorModule,
	fakeCapabilities,
} from "../../dist/sdk/testing/index.js";
import {
	createExecutor as createFixtureExecutor,
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

let root;
let counter = 0;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-execute-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_CANCEL_GRACE_MS = "500";
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function cwd() {
	counter += 1;
	const dir = join(root, `cwd-${counter}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

function descriptorFor(module, id = "fake") {
	return {
		id,
		version: "0.1.0",
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		module,
		config: null,
	};
}

/** Registry with one module; `make` builds the executor. */
function registryWith(module, make) {
	const registry = createExecutorRegistry();
	registry.register(module, { createExecutor: make });
	return registry;
}

/** Hand-written executor (the SDK fake refuses invalid scripts by construction). */
function scriptedExecutor({
	id = "raw",
	events,
	beforeConsumeMs = 0,
	log = [],
}) {
	return {
		id,
		version: "0.1.0",
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		probe: async () => ({ installed: true, cliVersion: null, auth: "ok" }),
		capabilities: () => fakeCapabilities(),
		async submit(req) {
			if (beforeConsumeMs > 0)
				await new Promise((resolve) => setTimeout(resolve, beforeConsumeMs));
			requireReleased(await req.authority.consume());
			log.push("effect");
			return { executorId: id, attemptKey: req.attemptKey, handle: "h-1" };
		},
		async *observe() {
			for (const event of events) yield event;
		},
		async cancel() {
			log.push("cancel");
			return "cancelled";
		},
		reconcile: async () => ({ absent: true }),
		respond: async () => "accepted",
	};
}

async function runWith(executor, input = {}) {
	const module = `inline:${executor.id}`;
	return await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module, executor.id),
		task: "test task",
		registry: registryWith(module, () => executor),
		...input,
	});
}

async function output(result) {
	return await readFile(
		join(result.cwd, result.artifacts.find((a) => a.type === "output").path),
		"utf8",
	);
}

test("failed.class maps to status/failureKind; transient and rate_limit keep their class", async () => {
	const expected = {
		cancelled: ["cancelled", "cancelled"],
		transient: ["failed", "transient"],
		rate_limit: ["failed", "rate_limit"],
		auth: ["failed", "executor_auth"],
		config: ["failed", "executor_config"],
		permanent: ["failed", "executor_permanent"],
		unknown: ["failed", "executor_unknown"],
	};
	for (const [failureClass, [status, failureKind]] of Object.entries(
		expected,
	)) {
		assert.deepEqual(statusForFailureClass(failureClass), {
			status,
			failureKind,
		});
		const result = await runWith(
			scriptedExecutor({
				id: `class-${failureClass.replace("_", "-")}`,
				events: [
					{ type: "started", sessionId: null },
					{ type: "message_delta", text: "partial finding" },
					{
						type: "failed",
						class: failureClass,
						message: `boom ${failureClass}`,
						raw: null,
					},
				],
			}),
		);
		assert.equal(result.status, status, failureClass);
		assert.equal(result.failureKind, failureKind, failureClass);
		assert.equal(result.metadata.executor.failureClass, failureClass);
		assert.equal(result.metadata.outputPartial, true);
		assert.equal(await output(result), "partial finding");
	}
});

test("invalid events and invalid sequences are guard_failure and the runtime cancels", async () => {
	for (const [label, events, pattern] of [
		[
			"usage cost 0 with unknown source",
			[
				{ type: "started", sessionId: null },
				{
					type: "usage",
					input: 1,
					output: 1,
					cached: 0,
					cost: 0,
					source: "unknown",
				},
			],
			/usage\.cost must be null when source is unknown/u,
		],
		[
			"no started first",
			[{ type: "message_delta", text: "x" }],
			/first event must be started/u,
		],
		[
			"stream ends without terminal",
			[{ type: "started", sessionId: null }],
			/stream ended without a terminal event/u,
		],
		[
			"duplicate approval id",
			[
				{ type: "started", sessionId: null },
				{ type: "approval_request", requestId: "r1", kind: "read", detail: "" },
				{ type: "approval_request", requestId: "r1", kind: "read", detail: "" },
			],
			/duplicate approval requestId/u,
		],
	]) {
		const log = [];
		const result = await runWith(
			scriptedExecutor({ id: `bad-${counter}`, events, log }),
		);
		assert.equal(result.status, "failed", label);
		assert.equal(result.failureKind, "guard_failure", label);
		assert.match(result.metadata.executor.fenceViolation, pattern, label);
		assert.ok(log.includes("cancel"), `${label}: cancel(owned) was sent`);
	}
});

test("usage: summed across events; null stays null (never 0); source preserved", () => {
	assert.equal(
		summarizeUsage([{ type: "started", sessionId: null }]),
		undefined,
	);
	assert.deepEqual(
		summarizeUsage([
			{
				type: "usage",
				input: 1000,
				output: 50,
				cached: 900,
				cost: 0.017,
				source: "reported",
			},
			{
				type: "usage",
				input: 2,
				output: 300,
				cached: 950,
				cost: 0.0133,
				source: "reported",
			},
		]),
		{
			input: 1002,
			output: 350,
			cached: 1850,
			cost: 0.0303,
			source: "reported",
			events: 2,
		},
	);
	assert.deepEqual(
		summarizeUsage([
			{
				type: "usage",
				input: 5,
				output: 7,
				cached: null,
				cost: 0.5,
				source: "estimated",
			},
			{
				type: "usage",
				input: 3,
				output: 4,
				cached: 1,
				cost: 0.25,
				source: "reported",
			},
		]),
		{
			input: 8,
			output: 11,
			cached: null,
			cost: 0.75,
			source: "estimated",
			events: 2,
		},
	);
	assert.deepEqual(
		summarizeUsage([
			{
				type: "usage",
				input: 5,
				output: 7,
				cached: 0,
				cost: 0.5,
				source: "reported",
			},
			{
				type: "usage",
				input: 3,
				output: 4,
				cached: 0,
				cost: null,
				source: "unknown",
			},
		]),
		{
			input: 8,
			output: 11,
			cached: 0,
			cost: null,
			source: "unknown",
			events: 2,
		},
		"one unknown cost makes the total unknown, not 0.5",
	);
});

test("output recovery: completed writes only the final text; a stale delta is never promoted", async () => {
	const completed = await runWith(
		scriptedExecutor({
			id: "final-only",
			events: [
				{ type: "started", sessionId: null },
				{
					type: "message_delta",
					text: "Supported finding before the tool wait",
				},
				{ type: "completed", finalText: "" },
			],
		}),
	);
	assert.equal(completed.status, "completed");
	assert.equal(await output(completed), "");
	assert.equal(completed.metadata.outputPartial, undefined);
});

test("post-release submit failure asks executor.reconcile: unknown → needs_decision (B3)", async () => {
	const module = "inline:crash";
	const registry = createExecutorRegistry();
	registry.register(
		module,
		createFakeExecutorModule({ faults: { crashAfterConsume: true } }),
	);
	const result = await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module),
		task: "crash after consume",
		registry,
	});
	assert.equal(result.status, "failed");
	assert.equal(result.failureKind, "needs_decision");
	assert.equal(result.metadata.executor.reconcile, "unknown");
	assert.equal(result.metadata.executor.authority, "released");
	assert.match(
		await readFile(
			join(result.cwd, result.artifacts.find((a) => a.type === "stderr").path),
			"utf8",
		),
		/fake crash after consume[\s\S]*will not retry/u,
	);
});

test("timeout after release cancels (owned) and records timeout with partial output", async () => {
	const module = "inline:slow";
	const registry = createExecutorRegistry();
	// Text arrives early; the terminal event only after ~3 s, well past the timeout even under load.
	const padding = Array.from({ length: 30 }, () => ({
		type: "tool_call",
		name: "read",
		kind: "read",
		status: "completed",
	}));
	registry.register(
		module,
		createFakeExecutorModule({
			stepDelayMs: 100,
			script: [
				{ type: "started", sessionId: null },
				{ type: "message_delta", text: "fake output" },
				...padding,
				{ type: "completed", finalText: "too late" },
			],
		}),
	);
	const result = await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module),
		task: "slow",
		timeoutMs: 1_000,
		registry,
	});
	assert.equal(result.status, "failed");
	assert.equal(result.failureKind, "timeout");
	assert.equal(result.metadata.executor.cancelResult, "cancelled");
	assert.equal(result.metadata.executor.termination, "confirmed");
	assert.equal(await output(result), "fake output");
	assert.equal(result.metadata.outputPartial, true);
});

test("timeout before release: no launch, timeout, no partial output marker", async () => {
	const log = [];
	const result = await runWith(
		scriptedExecutor({
			id: "gated",
			beforeConsumeMs: 250,
			log,
			events: [{ type: "started", sessionId: null }],
		}),
		{ timeoutMs: 100 },
	);
	assert.equal(result.failureKind, "timeout");
	assert.equal(result.status, "failed");
	assert.deepEqual(log, [], "the adapter never launched");
	assert.equal(result.metadata.outputPartial, undefined);
	assert.equal(result.metadata.executor.authority, "revoked");
});

test("approval requests are answered by policy: readOnly + mutating kind → deny", async () => {
	const module = "inline:approval";
	const registry = createExecutorRegistry();
	registry.register(
		module,
		createFakeExecutorModule({
			script: [
				{ type: "started", sessionId: null },
				{
					approval: {
						type: "approval_request",
						requestId: "edit-1",
						kind: "edit",
						detail: "edit a file",
					},
					ifAllowed: [{ type: "completed", finalText: "edited" }],
					ifDenied: [{ type: "completed", finalText: "not edited" }],
				},
			],
		}),
	);
	const result = await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module),
		task: "try an edit",
		readOnly: true,
		approvalPolicy: { allowKinds: ["edit"] },
		permissionMode: "safe",
		registry,
	});
	assert.equal(result.status, "completed");
	assert.equal(await output(result), "not edited");
	assert.deepEqual(result.metadata.executor.approvals, [
		{
			requestId: "edit-1",
			kind: "edit",
			decision: "deny",
			// WP2b: who decided (audit in approvals.jsonl).
			by: "engine-policy",
			response: "accepted",
		},
	]);
	const audit = (
		await readFile(
			join(
				result.cwd,
				dirname(result.artifacts.find((a) => a.type === "result").path),
				"approvals.jsonl",
			),
			"utf8",
		)
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		audit.map((record) => [
			record.phase,
			record.requestId,
			record.decision ?? null,
			record.by ?? null,
			record.deadlineAt ?? null,
		]),
		[
			["requested", "edit-1", null, null, null],
			["decided", "edit-1", "deny", "engine-policy", null],
		],
	);
	assert.match(audit[1].reason, /readOnly stage denies mutating kind edit/u);
});

test("resubmitting the same attempt from a fresh executor instance produces no second effect", async () => {
	const dir = await cwd();
	const effectLog = join(dir, "effects.jsonl");
	const store = await createAttemptArtifactStore({
		cwd: dir,
		runId: "run_idem",
		attemptId: "attempt_idem",
	});
	const request = buildSubmitRequestFields({
		input: { task: "once", attemptKey: "idem-key" },
		runId: "run_idem",
		attemptId: "attempt_idem",
		cwd: dir,
		startedAt: new Date(),
		artifactsDir: store.attemptDir,
	});
	const authority = () =>
		createDurableLaunchAuthority({
			attemptKey: "idem-key",
			runId: "run_idem",
			attemptId: "attempt_idem",
			attemptDir: store.attemptDir,
		});
	const first = await executeAttempt({
		executor: createFixtureExecutor({ effectLog }),
		request,
		authority: authority(),
		store,
	});
	assert.equal(first.status, "completed");
	// A second process (fresh executor, empty in-memory state) for the same attempt.
	await assert.rejects(
		executeAttempt({
			executor: createFixtureExecutor({ effectLog }),
			request,
			authority: authority(),
			store,
		}),
		(error) =>
			isExecutionNotStartedError(error) &&
			error.failureKind === "guard_failure",
	);
	const effects = readEffectLog(effectLog);
	assert.equal(effects.filter((entry) => entry.type === "effect").length, 1);
	assert.deepEqual(
		effects
			.filter((entry) => entry.type === "consume")
			.map((entry) => [entry.outcome, entry.code ?? null]),
		[
			["released", null],
			["rejected", "AUTHORITY_ALREADY_CONSUMED"],
		],
	);
	// The same executor instance resubmitting returns the same ref without a new effect.
	const executor = createFixtureExecutor({
		effectLog: join(dir, "same.jsonl"),
	});
	const gateKey = "same-instance";
	const make = () =>
		createDurableLaunchAuthority({
			attemptKey: gateKey,
			runId: "run_same",
			attemptId: "attempt_same",
			attemptDir: join(store.attemptDir, ".."),
		});
	const base = { ...request, attemptKey: gateKey };
	const refA = await executor.submit({ ...base, authority: make() });
	const refB = await executor.submit({ ...base, authority: make() });
	assert.deepEqual(refA, refB);
	assert.equal(
		readEffectLog(join(dir, "same.jsonl")).filter(
			(entry) => entry.type === "effect",
		).length,
		1,
	);
});

test("runtime input validation refuses Pi-specific options and requires an executor", async () => {
	const executor = fixtureDescriptor({ effectLog: join(root, "unused.jsonl") });
	assert.equal(validateRuntimeRunInput({ task: "x" }).ok, false);
	for (const key of [
		"agent",
		"backend",
		"extensions",
		"noExtensions",
		"thinking",
		"skills",
	]) {
		const validation = validateRuntimeRunInput({
			executor,
			task: "x",
			[key]: key === "noExtensions" ? true : "v",
		});
		assert.equal(validation.ok, false, key);
		assert.match(validation.failure.error, /Pi-specific option/u, key);
	}
	assert.match(
		validateRuntimeRunInput({ executor, tasks: [{ task: "x", agent: "a" }] })
			.failure.error,
		/tasks\[0\]\.agent is a Pi-specific option/u,
	);
	assert.equal(
		validateRuntimeRunInput({ executor, task: "x", readOnly: "yes" }).ok,
		false,
	);
	assert.equal(
		validateRuntimeRunInput({ executor, task: "x", env: { A: 1 } }).ok,
		false,
	);
	assert.equal(
		validateRuntimeRunInput({
			executor,
			task: "x",
			approvalPolicy: { allowKinds: ["teleport"] },
		}).ok,
		false,
	);
	const ok = validateRuntimeRunInput({
		executor,
		task: "x",
		effort: "high",
		readOnly: true,
		parentSessionId: "parent-1",
		mcpServers: [{ name: "artifact", command: "node", args: ["s.mjs"] }],
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.input.parentSessionId, "parent-1");
	assert.equal(ok.input.backend, undefined, "no Pi backend field");
	await assert.rejects(
		runSubagent({ executor, backend: "headless", task: "x" }),
		(error) =>
			error instanceof SubagentValidationError &&
			error.failureKind === "validation",
	);
	await assert.rejects(
		runSubagent({ executor }),
		(error) =>
			error instanceof SubagentValidationError &&
			/requires a non-empty task/u.test(error.message),
	);
});

test("execution plan digest covers the descriptor and every request field but not the authority", () => {
	const executor = fixtureDescriptor({ effectLog: "/tmp/x.jsonl" });
	const base = {
		input: { task: "plan me", tools: ["read"], timeoutMs: 1000 },
		runId: "run_plan",
		attemptId: "attempt_plan",
		cwd: "/tmp/work",
		startedAt: "2026-10-26T00:00:00.000Z",
		artifactsDir:
			"/tmp/work/.agent-workflow/runs/run_plan/attempts/attempt_plan",
	};
	const request = buildSubmitRequestFields(base);
	assert.equal(request.deadlineMs, Date.parse(base.startedAt) + 1000);
	assert.equal(
		buildSubmitRequestFields({ ...base, input: { task: "x" } }).deadlineMs,
		NO_DEADLINE_MS,
	);
	assert.equal(request.attemptKey, "run_plan:attempt_plan");
	assert.deepEqual(request.approvalPolicy, defaultApprovalPolicy());
	assert.equal("authority" in request, false);
	const workspace = { mode: "shared", cwd: "/tmp/work", worktreePath: null };
	const digest = (overrides = {}, executorOverride = executor) =>
		executionPlanDigest(
			buildExecutionPlan({
				executor: executorOverride,
				runId: "run_plan",
				attemptId: "attempt_plan",
				workspace,
				request: { ...request, ...overrides },
			}),
		);
	assert.equal(digest(), digest(), "deterministic");
	assert.match(digest(), /^[a-f0-9]{64}$/u);
	for (const change of [
		{ prompt: "other" },
		{ tools: [] },
		{ readOnly: true },
		{ env: { A: "1" } },
		{ model: "m" },
		{ deadlineMs: 1 },
		{ artifactsDir: "/tmp/other" },
	])
		assert.notEqual(digest(change), digest(), JSON.stringify(change));
	assert.notEqual(digest({}, { ...executor, version: "0.1.1" }), digest());
	assert.notEqual(
		digest({}, { ...executor, config: { other: true } }),
		digest(),
	);
	const withBinding = buildSubmitRequestFields({
		...base,
		input: {
			task: "x",
			env: {
				AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON: "{}",
				PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON: "{}",
				KEEP: "1",
			},
		},
	});
	assert.deepEqual(
		withBinding.env,
		{ KEEP: "1" },
		"the binding never comes from the caller",
	);
});

test("captureToolCalls: normalized tool_call events produce the ported telemetry artifacts", async () => {
	const module = "inline:telemetry";
	const registry = createExecutorRegistry();
	registry.register(
		module,
		createFakeExecutorModule({
			script: [
				{ type: "started", sessionId: null },
				{
					type: "tool_call",
					name: "read",
					kind: "read",
					status: "running",
					callId: "c1",
					input: { path: "a.md" },
				},
				{
					type: "tool_call",
					name: "read",
					kind: "read",
					status: "completed",
					callId: "c1",
					output: "ok",
				},
				{
					type: "tool_call",
					name: "bash",
					kind: "execute",
					status: "failed",
					input: { command: "ls", token: "sk-secret" },
				},
				{ type: "completed", finalText: "done" },
			],
		}),
	);
	const result = await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module),
		task: "use tools",
		captureToolCalls: true,
		registry,
	});
	assert.equal(result.status, "completed");
	const path = (type) =>
		join(result.cwd, result.artifacts.find((a) => a.type === type).path);
	const records = (await readFile(path("tool-calls"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		records.map((record) => [record.toolName, record.status, record.category]),
		[
			["read", "completed", "filesystem"],
			["bash", "failed", "shell"],
		],
	);
	assert.equal(records[1].failedArgs.value.token, "[REDACTED]");
	const summary = JSON.parse(
		await readFile(path("tool-calls-summary"), "utf8"),
	);
	assert.deepEqual(summary.statusCounts, {
		completed: 1,
		failed: 1,
		incomplete: 0,
	});
	const plain = await runSubagent({
		cwd: await cwd(),
		executor: descriptorFor(module),
		task: "no capture",
		registry,
	});
	assert.equal(
		plain.artifacts.some((a) => a.type === "tool-calls"),
		false,
	);
});
