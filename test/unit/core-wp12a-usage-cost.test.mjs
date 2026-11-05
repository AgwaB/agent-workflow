// New in agent-workflow (WP12a, live bundle 3 open problem 4): unknown cost is `null` everywhere —
// adapter usage events, runtime summaries, task usage, run rollups — and host text says "unknown".
// The capability negotiation no longer claims engine cost emulation (there is no price table).
// Usage shapes come from the recorded transcripts of the three adapters.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseClaudeStream } from "../../dist/executors/claude/index.js";
import { CodexTurnNormalizer } from "../../dist/executors/codex/index.js";
import { PiEventNormalizer } from "../../dist/executors/pi/index.js";
import { summarizeUsage } from "../../dist/runtime/orchestrate/execute.js";
import * as sdk from "../../dist/sdk/index.js";
import { createFakeExecutor } from "../../dist/sdk/testing/index.js";
import { normalizedUsageValues } from "../../dist/core/task-observability.js";
import { buildWorkflowRunMetrics } from "../../dist/core/workflow-metrics.js";
import { readRunRecord, writeRunRecord } from "../../dist/core/store.js";
import {
	formatHumanRunOutcome,
	formatRun,
} from "../../dist/core/engine-format.js";
import { loadTranscript } from "../fixtures/executors/pi/harness.mjs";
import { readTranscript } from "../fixtures/executors/codex/replay.mjs";
import { readFileSync } from "node:fs";

async function piEvents(name) {
	const transcript = await loadTranscript(name);
	const normalizer = new PiEventNormalizer({ sessionId: null });
	const events = [normalizer.started()];
	for (const line of transcript.stdout) events.push(...normalizer.line(line));
	events.push(
		normalizer.finish({
			exitCode: transcript.exitCode,
			signal: transcript.signal,
			cancelled: false,
			stderr: transcript.stderr,
		}),
	);
	return events;
}

function codexEvents(name) {
	const entries = readTranscript(
		fileURLToPath(
			new URL(
				`../fixtures/executors/codex/recorded/${name}.jsonl`,
				import.meta.url,
			),
		),
	);
	const normalizer = new CodexTurnNormalizer({});
	const events = [];
	const flat = [];
	for (const entry of entries) {
		if (entry.branches !== undefined) {
			flat.push(...entry.branches[0].entries);
			break;
		}
		flat.push(entry);
	}
	for (const { dir, msg } of flat) {
		if (dir !== "in" || typeof msg.method !== "string" || msg.id !== undefined)
			continue;
		if (msg.method === "turn/completed")
			events.push(...normalizer.finish(msg.params.turn));
		else events.push(...normalizer.push(msg.method, msg.params));
	}
	return events;
}

function claudeEvents(name) {
	const path = fileURLToPath(
		new URL(
			`../fixtures/executors/claude/transcripts/${name}.jsonl`,
			import.meta.url,
		),
	);
	return parseClaudeStream(
		readFileSync(path, "utf8").split("\n").filter(Boolean),
	);
}

/** Task usage the way the core records one executor attempt (runtime summary → values). */
function taskUsage(summary) {
	const values = normalizedUsageValues(summary);
	return {
		source: "executor",
		capturedAt: "2026-10-27T00:00:00.000Z",
		...values,
		aggregate: { attempts: 1, ...values },
		attempts: [
			{
				source: "subagent-result-metadata",
				capturedAt: "2026-10-27T00:00:00.000Z",
				raw: summary,
				...values,
			},
		],
	};
}

function task(taskId, kind, usage) {
	return {
		taskId,
		specId: `${taskId}.main`,
		displayName: taskId,
		agent: "worker",
		agentFile: "agents/worker.md",
		roles: [],
		status: "completed",
		statusDetail: "completed",
		kind,
		runtime: { approvalMode: "never" },
		cwd: "/tmp/usage",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: taskId,
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
		...(usage === undefined ? {} : { usage }),
	};
}

function run(runId, tasks) {
	return {
		schemaVersion: 1,
		runId,
		name: "usage-cost",
		type: "workflow",
		status: "completed",
		taskSummary: {
			total: tasks.length,
			pending: 0,
			running: 0,
			completed: tasks.length,
			blocked: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd: "/tmp/usage",
		backend: { type: "local", mode: "headless" },
		createdAt: "2026-10-27T00:00:00.000Z",
		updatedAt: "2026-10-27T00:00:00.000Z",
		specPath: "spec.json",
		tasks,
	};
}

test("adapter usage shapes: Codex cost unknown, Pi estimated, Claude reported; never 0", async () => {
	const codex = summarizeUsage(codexEvents("complete"));
	assert.equal(codex.cost, null);
	assert.equal(codex.source, "unknown");
	assert.equal(normalizedUsageValues(codex).costUsd, null);

	const pi = summarizeUsage(await piEvents("complete-read"));
	assert.ok(pi.cost > 0);
	assert.equal(pi.source, "estimated");
	assert.equal(normalizedUsageValues(pi).costUsd, pi.cost);

	const claude = summarizeUsage(claudeEvents("complete-tools-mcp"));
	assert.ok(claude.cost > 0);
	assert.equal(claude.source, "reported");

	const interrupted = summarizeUsage(claudeEvents("interrupt"));
	assert.equal(interrupted.cost, null);
	assert.equal(normalizedUsageValues(interrupted).costUsd, null);
});

test("a run whose model tasks report no cost rolls up cost null, not 0 (support tasks do not count)", async (t) => {
	const codex = summarizeUsage(codexEvents("complete"));
	const record = run("workflow_wp12a_cost_codex", [
		task("task-1", "main", taskUsage(codex)),
		task("task-2", "main", taskUsage(codex)),
		task("task-3", "support", undefined),
	]);
	const metrics = buildWorkflowRunMetrics(record);
	assert.equal(metrics.totals.usage.observed.costUsd, null);
	assert.equal(metrics.totals.usage.costUsd, null);

	const cwd = mkdtempSync(join(tmpdir(), "wp12a-usage-cost-"));
	t.after(() =>
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	await writeRunRecord(cwd, record);
	const persisted = await readRunRecord(cwd, record.runId);
	assert.equal(persisted.usage.tasksReporting, 2);
	assert.ok(Object.hasOwn(persisted.usage, "costUsd"));
	assert.equal(persisted.usage.costUsd, null);

	assert.match(formatHumanRunOutcome(persisted), /cost unknown/);
	assert.match(formatRun(persisted), /cost=unknown/);
});

test("a run whose model tasks report cost rolls up that cost and shows it", async (t) => {
	const claude = summarizeUsage(claudeEvents("complete-tools-mcp"));
	const record = run("workflow_wp12a_cost_claude", [
		task("task-1", "main", taskUsage(claude)),
		task("task-2", "support", undefined),
	]);
	const cwd = mkdtempSync(join(tmpdir(), "wp12a-usage-cost-"));
	t.after(() =>
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	await writeRunRecord(cwd, record);
	const persisted = await readRunRecord(cwd, record.runId);
	assert.equal(persisted.usage.costUsd, claude.cost);
	assert.match(formatHumanRunOutcome(persisted), /cost \$0\.001857 /);
	assert.match(formatRun(persisted), /cost=0\.001857,/);
});

test("negotiation: a tokens-only executor records usage.cost as unknown, never engine emulation", () => {
	const executor = createFakeExecutor({ id: "tokens-only", version: "0.1.0" });
	const capabilities = {
		...executor.capabilities(),
		usage: { level: "native", source: "declared", detail: "tokens" },
	};
	const report = sdk.negotiateCapabilities(executor, capabilities, {
		readOnly: false,
		hasRequiredReads: false,
		interactive: true,
	});
	const cost = report.entries.find((entry) => entry.key === "usage.cost");
	assert.equal(cost.outcome, "degraded");
	assert.equal(cost.emulatedBy, undefined);
	assert.equal(cost.code, "CAPABILITY_MISSING:usage.cost");
	assert.match(cost.note, /unknown/);
	assert.doesNotMatch(cost.note, /price table/);
	assert.ok(report.accepted);
	// Recording an unknown cost changes nothing about the worker: no confirmation for it alone.
	assert.equal(report.needsConfirmation, false);
	const preview = sdk.formatNegotiationPreview(report).join("\n");
	assert.doesNotMatch(preview, /emulated by engine|price table/);
	assert.match(preview, /usage\.cost: degraded/);
});
