// New in agent-workflow (WP12a, live bundle 3 open problem 5): one normalized usage shape for every
// executor (SDK UsageEvent): input EXCLUDING cache, cached (cache reads), cacheWrite, output,
// total = sum, model when known, cost or null, source. Driven by the recorded transcripts in
// test/fixtures/executors/*; then the runtime summary, the task record and the run rollup
// (totalTokens no longer 0; blocked runs carry a rollup).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseClaudeStream } from "../../dist/executors/claude/index.js";
import { CodexTurnNormalizer } from "../../dist/executors/codex/index.js";
import { PiEventNormalizer } from "../../dist/executors/pi/index.js";
import { summarizeUsage } from "../../dist/runtime/orchestrate/execute.js";
import { validateExecEvent } from "../../dist/sdk/index.js";
import {
	normalizedUsageValues,
	recordTerminalTaskObservability,
} from "../../dist/core/task-observability.js";
import { readRunRecord, writeRunRecord } from "../../dist/core/store.js";
import { loadTranscript } from "../fixtures/executors/pi/harness.mjs";
import { readTranscript } from "../fixtures/executors/codex/replay.mjs";

async function piRun(name) {
	const transcript = await loadTranscript(name);
	const normalizer = new PiEventNormalizer({ sessionId: null });
	const events = [normalizer.started()];
	for (const line of transcript.stdout) events.push(...normalizer.line(line));
	const raw = transcript.stdout
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.filter(
			(event) =>
				event?.type === "message_end" && event.message?.role === "assistant",
		)
		.map((event) => event.message);
	return { events, raw };
}

function codexEvents(name, model) {
	const entries = readTranscript(
		fileURLToPath(
			new URL(
				`../fixtures/executors/codex/recorded/${name}.jsonl`,
				import.meta.url,
			),
		),
	);
	const normalizer = new CodexTurnNormalizer({});
	normalizer.model = model;
	const events = [];
	for (const { dir, msg } of entries) {
		if (dir !== "in" || typeof msg?.method !== "string" || msg.id !== undefined)
			continue;
		if (msg.method === "turn/completed")
			events.push(...normalizer.finish(msg.params.turn));
		else events.push(...normalizer.push(msg.method, msg.params));
	}
	const lastTotal = entries
		.filter((entry) => entry.msg?.method === "thread/tokenUsage/updated")
		.at(-1).msg.params.tokenUsage.total;
	return { events, lastTotal };
}

function claudeEvents(name) {
	const path = fileURLToPath(
		new URL(
			`../fixtures/executors/claude/transcripts/${name}.jsonl`,
			import.meta.url,
		),
	);
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	const result = lines
		.map((line) => JSON.parse(line))
		.find((m) => m.type === "result");
	return { events: parseClaudeStream(lines), result };
}

const usageOf = (events) => events.filter((event) => event.type === "usage");

test("Pi: input already excludes cache; total equals Pi's totalTokens; the model is recorded", async () => {
	const { events, raw } = await piRun("complete-read");
	for (const event of usageOf(events))
		assert.deepEqual(validateExecEvent(event), []);
	const summary = summarizeUsage(events);
	const piTotal = raw.reduce(
		(sum, message) => sum + message.usage.totalTokens,
		0,
	);
	assert.equal(summary.total, piTotal);
	assert.equal(
		summary.input,
		raw.reduce((sum, message) => sum + message.usage.input, 0),
	);
	assert.equal(summary.model, raw.at(-1).model);
	assert.equal(summary.model, "gemini-2.5-flash-lite");
});

test("Codex: input excludes cached input; total equals Codex totalTokens; the thread model is recorded", () => {
	const { events, lastTotal } = codexEvents("complete", "gpt-5.6-luna");
	const [usage] = usageOf(events);
	assert.deepEqual(validateExecEvent(usage), []);
	assert.equal(
		usage.input,
		lastTotal.inputTokens - lastTotal.cachedInputTokens,
	);
	assert.equal(usage.cached, lastTotal.cachedInputTokens);
	assert.equal(usage.model, "gpt-5.6-luna");
	const summary = summarizeUsage(events);
	assert.equal(summary.total, lastTotal.totalTokens);
	assert.equal(summary.cost, null);
});

test("Claude: input excludes cache; cache creation is cacheWrite; total is the sum; resolved model", () => {
	const { events, result } = claudeEvents("complete-tools-mcp");
	const [usage] = usageOf(events);
	assert.deepEqual(validateExecEvent(usage), []);
	assert.equal(usage.input, result.usage.input_tokens);
	assert.equal(usage.cached, result.usage.cache_read_input_tokens);
	assert.equal(usage.cacheWrite, result.usage.cache_creation_input_tokens);
	const summary = summarizeUsage(events);
	assert.equal(
		summary.total,
		result.usage.input_tokens +
			result.usage.cache_read_input_tokens +
			result.usage.cache_creation_input_tokens +
			result.usage.output_tokens,
	);
	assert.equal(summary.model, "claude-haiku-5-5");
});

test("SDK validation: cacheWrite and model are checked when present", () => {
	const base = {
		type: "usage",
		input: 1,
		output: 1,
		cached: 0,
		cost: null,
		source: "unknown",
	};
	assert.deepEqual(
		validateExecEvent({ ...base, cacheWrite: 2, model: "m" }),
		[],
	);
	assert.ok(validateExecEvent({ ...base, cacheWrite: -1 }).length > 0);
	assert.ok(validateExecEvent({ ...base, model: "" }).length > 0);
});

function modelTask(taskId, status = "completed") {
	return {
		taskId,
		specId: `${taskId}.main`,
		displayName: taskId,
		agent: "worker",
		agentFile: "agents/worker.md",
		roles: [],
		status,
		statusDetail: status,
		kind: "main",
		runtime: { approvalMode: "never", model: "haiku" },
		cwd: "/tmp/usage",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		workerTaskId: taskId,
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
	};
}

function observe(task, summary, index) {
	recordTerminalTaskObservability({
		task,
		snapshot: {
			runId: `run_${index}`,
			attemptId: `attempt_${index}`,
			status: "completed",
		},
		workerResult: {
			status: "completed",
			// The request alias stays in runtime metadata; the usage names the resolved model.
			metadata: { usage: summary, model: "haiku" },
		},
		startedAt: "2026-10-27T00:00:00.000Z",
		completedAt: "2026-10-27T00:00:01.000Z",
	});
}

test("task records: totalTokens and cacheCreationInputTokens from the summary; the resolved model wins", () => {
	const { events } = claudeEvents("complete-tools-mcp");
	const summary = summarizeUsage(events);
	const values = normalizedUsageValues(summary);
	assert.equal(values.totalTokens, summary.total);
	assert.equal(values.cacheCreationInputTokens, summary.cacheWrite);
	assert.equal(values.cacheReadInputTokens, summary.cached);
	const task = modelTask("task-1");
	observe(task, summary, 1);
	assert.equal(task.usage.model, "claude-haiku-5-5");
	assert.equal(task.usage.attempts[0].model, "claude-haiku-5-5");
	assert.equal(task.usage.totalTokens, summary.total);
});

test("run rollup: totalTokens is the sum (not 0); a blocked run carries the usage of the attempts that ran", async (t) => {
	const { events } = claudeEvents("complete-tools-mcp");
	const summary = summarizeUsage(events);
	const done = modelTask("task-1");
	observe(done, summary, 1);
	const blocked = modelTask("task-2", "blocked");
	blocked.statusDetail = "executor_needs_decision";
	observe(blocked, summary, 2);
	const cwd = mkdtempSync(join(tmpdir(), "wp12a-usage-normalized-"));
	t.after(() =>
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	await writeRunRecord(cwd, {
		schemaVersion: 1,
		runId: "workflow_wp12a_usage_blocked",
		name: "usage",
		type: "workflow",
		status: "running",
		taskSummary: {
			total: 2,
			pending: 0,
			running: 0,
			completed: 1,
			blocked: 1,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd: "/tmp/usage",
		createdAt: "2026-10-27T00:00:00.000Z",
		updatedAt: "2026-10-27T00:00:00.000Z",
		specPath: "spec.json",
		tasks: [done, blocked],
	});
	const persisted = await readRunRecord(cwd, "workflow_wp12a_usage_blocked");
	assert.equal(persisted.status, "blocked");
	assert.ok(persisted.usage, "blocked run has a usage rollup");
	assert.equal(persisted.usage.tasksReporting, 2);
	assert.equal(persisted.usage.totalTokens, 2 * summary.total);
	assert.equal(persisted.usage.inputTokens, 2 * summary.input);
	assert.equal(persisted.usage.costUsd, 2 * summary.cost);
});
