import assert from "node:assert/strict";
import { createResultEnvelope } from "../../dist/runtime/artifacts/index.js";
import { validateResolveInput } from "../../dist/runtime/core/validation.js";
import {
	createRunStatusSnapshot,
	isTerminalStatus,
	statusFailedClosed,
	statusSucceeded,
	summarizeChildEvents,
} from "../../dist/runtime/orchestrate/index.js";
import { test } from "node:test";

test("contracts", async () => {
	const plannedInput = {
		task: "inspect public contracts",
		mode: "parallel",
		tasks: [
			{ task: "review schemas" },
			{ task: "review schemas", timeoutMs: 1000 },
		],
		concurrency: 2,
		failFast: true,
		cancelSiblingsOnFailure: true,
		asyncDependency: "needed-before-final",
		sandbox: true,
		workspace: { mode: "auto", path: "." },
		worktree: true,
		worktreePolicy: "auto",
		cwd: process.cwd(),
		async: true,
		onComplete: "return",
		timeoutMs: 5000,
		model: "kimi-coding/kimi-for-coding",
		tools: ["read", "grep"],
		systemPrompt: "Compiled system prompt",
		captureToolCalls: true,
		runsDir: ".agent-workflow/custom-runs",
		correlationId: "corr_contracts",
	};

	const validation = validateResolveInput(plannedInput);
	assert.equal(validation.ok, true);
	assert.equal(validation.input.task, plannedInput.task);
	assert.equal(validation.input.tasks.length, 2);
	assert.equal(validation.input.concurrency, 2);
	assert.equal(validation.input.failFast, true);
	assert.equal(validation.input.cancelSiblingsOnFailure, true);
	assert.equal(validation.input.asyncDependency, "needed-before-final");
	assert.equal(validation.input.workspace.mode, "auto");
	assert.equal(validation.input.model, "kimi-coding/kimi-for-coding");
	assert.deepEqual(validation.input.tools, ["read", "grep"]);
	assert.equal(validation.input.systemPrompt, "Compiled system prompt");
	assert.equal(validation.input.captureToolCalls, true);
	assert.equal(validation.input.runsDir, ".agent-workflow/custom-runs");
	assert.equal(validation.input.correlationId, "corr_contracts");

	const sessionIdValidation = validateResolveInput({
		task: "inspect",
		sessionId: "abc-123_ok",
	});
	assert.equal(sessionIdValidation.ok, true);
	assert.equal(sessionIdValidation.input.sessionId, "abc-123_ok");

	const emptySessionIdValidation = validateResolveInput({
		task: "inspect",
		sessionId: "",
	});
	assert.equal(emptySessionIdValidation.ok, false);
	assert.match(
		emptySessionIdValidation.failure.error,
		/sessionId must be a non-empty string/,
	);

	const badSessionIdValidation = validateResolveInput({
		task: "inspect",
		sessionId: "bad id",
	});
	assert.equal(badSessionIdValidation.ok, false);
	assert.match(
		badSessionIdValidation.failure.error,
		/sessionId must contain only letters/,
	);

	const taskSessionValidation = validateResolveInput({
		mode: "parallel",
		tasks: [
			{ task: "a", sessionId: "child-a" },
			{ task: "b", sessionId: "child-b" },
		],
	});
	assert.equal(taskSessionValidation.ok, true);
	assert.equal(taskSessionValidation.input.tasks[0].sessionId, "child-a");
	assert.equal(taskSessionValidation.input.tasks[1].sessionId, "child-b");

	const sharedParallelSessionValidation = validateResolveInput({
		mode: "parallel",
		sessionId: "shared-session",
		tasks: [{ task: "a" }],
	});
	assert.equal(sharedParallelSessionValidation.ok, false);
	assert.match(
		sharedParallelSessionValidation.failure.error,
		/top-level sessionId is not supported with parallel tasks/,
	);

	const badTaskSessionValidation = validateResolveInput({
		mode: "parallel",
		tasks: [{ task: "a", sessionId: "bad id" }],
	});
	assert.equal(badTaskSessionValidation.ok, false);
	assert.match(
		badTaskSessionValidation.failure.error,
		/tasks\[0\]\.sessionId must contain only letters/,
	);

	const badFailFastValidation = validateResolveInput({
		task: "inspect",
		failFast: "yes",
	});
	assert.equal(badFailFastValidation.ok, false);
	assert.match(
		badFailFastValidation.failure.error,
		/failFast must be a boolean/,
	);

	const taskModelValidation = validateResolveInput({
		mode: "parallel",
		tasks: [
			{
				task: "audit",
				model: "kimi-coding/kimi-for-coding",
				tools: [],
				captureToolCalls: true,
			},
		],
	});
	assert.equal(taskModelValidation.ok, true);
	assert.equal(
		taskModelValidation.input.tasks[0].model,
		"kimi-coding/kimi-for-coding",
	);
	assert.deepEqual(taskModelValidation.input.tasks[0].tools, []);
	assert.equal(taskModelValidation.input.tasks[0].captureToolCalls, true);

	const childSummary = summarizeChildEvents([
		{
			schemaVersion: 2,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "child.started",
			runId: "run_parent",
			status: "running",
			data: { childRunId: "run_child" },
		},
		{
			schemaVersion: 2,
			timestamp: "2026-01-01T00:00:01.000Z",
			type: "child.failed",
			runId: "run_parent",
			status: "failed",
			data: { childRunId: "run_child", failureKind: "model" },
		},
	]);
	assert.equal(childSummary?.total, 1);
	assert.equal(childSummary?.failed, 1);
	assert.equal(childSummary?.latestFailure?.childRunId, "run_child");

	// Sandbox object form: explicit per-run network egress (C-style caller control).
	const sandboxObject = validateResolveInput({
		sandbox: {
			allowedDomains: ["api.anthropic.com", "*.npmjs.org", "localhost"],
		},
		task: "inspect",
	});
	assert.equal(sandboxObject.ok, true);
	assert.deepEqual(sandboxObject.input.sandbox, {
		allowedDomains: ["api.anthropic.com", "*.npmjs.org", "localhost"],
	});

	const sandboxEmptyObject = validateResolveInput({
		sandbox: {},
		task: "inspect",
	});
	assert.equal(sandboxEmptyObject.ok, true);
	assert.deepEqual(sandboxEmptyObject.input.sandbox, {});

	const sandboxTaskObject = validateResolveInput({
		mode: "parallel",
		tasks: [
			{
				task: "audit",
				sandbox: { allowedDomains: ["api.openai.com"] },
			},
		],
	});
	assert.equal(sandboxTaskObject.ok, true);
	assert.deepEqual(sandboxTaskObject.input.tasks[0].sandbox, {
		allowedDomains: ["api.openai.com"],
	});

	const sandboxBadDomain = validateResolveInput({
		sandbox: { allowedDomains: ["https://api.anthropic.com"] },
		task: "inspect",
	});
	assert.equal(sandboxBadDomain.ok, false);
	assert.match(sandboxBadDomain.failure.error, /must be a bare domain/);

	const sandboxBroadWildcard = validateResolveInput({
		sandbox: { allowedDomains: ["*.com"] },
		task: "inspect",
	});
	assert.equal(sandboxBroadWildcard.ok, false);
	assert.match(sandboxBroadWildcard.failure.error, /must be a bare domain/);

	const sandboxUnknownKey = validateResolveInput({
		sandbox: { domains: ["api.anthropic.com"] },
		task: "inspect",
	});
	assert.equal(sandboxUnknownKey.ok, false);
	assert.match(sandboxUnknownKey.failure.error, /unsupported sandbox option/);

	// Result envelope records the sandbox network policy.
	const sandboxedResult = createResultEnvelope({
		runId: "run_contracts_002",
		attemptId: "attempt-contracts-002",
		executorId: "fixture",
		status: "completed",
		failureKind: null,
		cwd: process.cwd(),
		startedAt: "2026-06-07T00:00:00.000Z",
		completedAt: "2026-06-07T00:00:00.010Z",
		sandbox: { enabled: true, allowedDomains: ["api.anthropic.com"] },
		artifacts: [],
		metadata: {
			contextLengthExceeded: false,
			contextOverflowRecovered: true,
			recoveredStreamErrors: ["context_length_exceeded: compacted"],
			parentSessionId: "parent-contracts",
			sessionId: "contract-session",
			session: {
				id: "contract-session",
				requested: true,
				disposition: "resumed",
			},
		},
	});
	assert.deepEqual(sandboxedResult.metadata.session, {
		id: "contract-session",
		requested: true,
		disposition: "resumed",
	});
	assert.equal(sandboxedResult.metadata.parentSessionId, "parent-contracts");
	assert.equal(sandboxedResult.metadata.sessionId, "contract-session");
	assert.equal(sandboxedResult.metadata.contextOverflowRecovered, true);
	assert.deepEqual(sandboxedResult.metadata.recoveredStreamErrors, [
		"context_length_exceeded: compacted",
	]);
	assert.deepEqual(sandboxedResult.sandbox, {
		enabled: true,
		allowedDomains: ["api.anthropic.com"],
	});

	const invalid = validateResolveInput({ mode: "fanout" });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.failure.failureKind, "validation");
	assert.match(invalid.failure.error, /unsupported mode/);

	const chain = validateResolveInput({
		chain: [{ task: "summarize findings" }],
	});
	assert.equal(chain.ok, false);
	assert.equal(chain.failure.failureKind, "validation");
	assert.equal(chain.failure.error, "unsupported request field chain");

	const result = createResultEnvelope({
		runId: "run_contracts_001",
		attemptId: "attempt-contracts-001",
		executorId: "fixture",
		status: "failed",
		failureKind: "validation",
		cwd: process.cwd(),
		startedAt: "2026-06-07T00:00:00.000Z",
		completedAt: "2026-06-07T00:00:00.010Z",
		artifacts: [
			{
				type: "result",
				path: ".agent-workflow/runs/run_contracts_001/attempts/attempt-contracts-001/result.json",
			},
		],
		metadata: { contextLengthExceeded: false },
	});
	const snapshot = createRunStatusSnapshot(result);
	assert.equal(snapshot.runId, result.runId);
	assert.equal(snapshot.attemptId, "attempt-contracts-001");
	assert.equal(
		snapshot.resultPath,
		".agent-workflow/runs/run_contracts_001/attempts/attempt-contracts-001/result.json",
	);
	assert.equal(isTerminalStatus("failed"), true);
	assert.equal(statusSucceeded("completed"), true);
	assert.equal(statusFailedClosed("failed", "validation"), true);

	console.log(
		JSON.stringify(
			{
				name: "check-contracts",
				status: "completed",
				plannedKeys: Object.keys(plannedInput).length,
				statusHelpers: 4,
			},
			null,
			2,
		),
	);
});
