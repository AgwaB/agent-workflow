import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFileLinesBounded } from "../../dist/core/workflow-preview.js";
import * as usage from "../../dist/core/workflow-parent-usage.js";
import * as store from "../../dist/core/store.js";
import { bindFeedbackAudience } from "../../dist/hosts/pi/feedback.js";

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "surface-regression-"));
	t.after(async () => {
		usage.resetParentUsageTrackingForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	return cwd;
}
async function index(cwd, runs) {
	await mkdir(join(stateDir(cwd), ".agent-workflow/workflows"), {
		recursive: true,
	});
	await writeFile(
		join(stateDir(cwd), ".agent-workflow/workflows/index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: new Date().toISOString(),
			runs,
		}),
	);
}
const message = (n, timestamp) => ({
	role: "assistant",
	timestamp,
	usage: { totalTokens: n },
});
async function child(code) {
	return new Promise((res, rej) => {
		const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let err = "";
		p.stderr.on("data", (s) => (err += s));
		p.on("error", rej);
		p.on("exit", (n) => (n === 0 ? res() : rej(new Error(err || `exit ${n}`))));
	});
}

test("ownership survives separate processes; same-session concurrent deltas and replay are not lost", async (t) => {
	const cwd = await project(t),
		runId = "workflow_owner";
	await index(cwd, [{ runId, status: "running" }]);
	const mod = JSON.stringify(resolve("dist/core/workflow-parent-usage.js"));
	const run = async (owner, n, id, begin = false) =>
		child(
			`const u=await import(${mod});const cwd=${JSON.stringify(cwd)};${begin ? 'await u.beginParentUsageTracking(cwd,"workflow_owner",' + JSON.stringify(owner) + ");" : "await u.resumeParentUsageTracking(cwd," + JSON.stringify(owner) + ");"}await u.recordParentSessionUsage(cwd,${JSON.stringify(message(n, id))},${JSON.stringify(owner)});`,
		);
	await run("A", 10, 1, true);
	await run("B", 777, 2);
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 10);
	await Promise.all([run("A", 20, 3), run("A", 30, 4)]);
	await run("A", 20, 3);
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 60);
});

test("owner-less historical sidecars are readable but never claimed by a new session", async (t) => {
	const cwd = await project(t),
		runId = "workflow_legacy";
	await index(cwd, [{ runId, status: "running" }]);
	await mkdir(store.workflowRunDir(cwd, runId), { recursive: true });
	await writeFile(
		join(store.workflowRunDir(cwd, runId), "parent-usage.json"),
		JSON.stringify({
			schema: "workflow-parent-usage-v1",
			runId,
			source: "parent-session",
			assistantMessages: 1,
			totalTokens: 10,
		}),
	);
	await usage.resumeParentUsageTracking(cwd, "new-owner");
	await usage.recordParentSessionUsage(cwd, message(777, 2), "new-owner");
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 10);
});

test("8MiB single-line preview has a hard IO and returned-text bound", async (t) => {
	const cwd = await project(t);
	await writeFile(join(stateDir(cwd), "big.log"), "X".repeat(8 * 1024 * 1024));
	let bytes = 0;
	const started = performance.now();
	const lines = await readFileLinesBounded(cwd, "big.log", 1000, {
		onRead: (n) => (bytes += n),
	});
	t.diagnostic(
		JSON.stringify({
			fixtureBytes: 8 * 1024 * 1024,
			bytesRead: bytes,
			returnedBytes: Buffer.byteLength(lines.join("\n")),
			elapsedMs: performance.now() - started,
		}),
	);
	assert.ok(bytes <= 256 * 1024, `read ${bytes} bytes`);
	assert.ok(Buffer.byteLength(lines.join("\n")) <= 256 * 1024);
	assert.match(lines.join("\n"), /truncat|omitted/i);
	await writeFile(
		join(stateDir(cwd), "invalid-utf8.log"),
		Buffer.concat(
			Array.from({ length: 900 }, () =>
				Buffer.concat([Buffer.alloc(200, 255), Buffer.from("\n")]),
			),
		),
	);
	const invalid = await readFileLinesBounded(cwd, "invalid-utf8.log", 1000);
	assert.ok(Buffer.byteLength(invalid.join("\n")) <= 256 * 1024);
	assert.match(invalid.join("\n"), /truncated/);
	assert.deepEqual(await readFileLinesBounded(cwd, "big.log", 0.5), []);
});

test("owner usage persists before the first turn, flushes on detach, and retains finalized totals on resume", async (t) => {
	const cwd = await project(t),
		runId = "workflow_resume";
	await index(cwd, [{ runId, status: "running" }]);
	usage.beginParentUsageTracking(cwd, runId, "owner");
	await usage.flushParentUsageTracking(cwd, "owner", true);
	assert.equal((await usage.readParentUsage(cwd, runId)).sessionId, "owner");
	await usage.resumeParentUsageTracking(cwd, "owner");
	await usage.recordParentSessionUsage(cwd, message(10, 1), "owner");
	await index(cwd, [{ runId, status: "completed" }]);
	await usage.recordParentSessionUsage(cwd, message(20, 2), "owner");
	await index(cwd, [{ runId, status: "running" }]);
	await usage.resumeParentUsageTracking(cwd, "owner");
	await usage.recordParentSessionUsage(cwd, message(30, 3), "owner");
	await usage.flushParentUsageTracking(cwd, "owner", true);
	await usage.recordParentSessionUsage(cwd, message(777, 4), "owner");
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 60);
});

test("durable feedback audience rejects a conflicting explicit usage owner", async (t) => {
	const cwd = await project(t),
		runId = "workflow_conflict";
	await index(cwd, [{ runId, status: "running" }]);
	await mkdir(store.workflowRunDir(cwd, runId), { recursive: true });
	assert.ok(await bindFeedbackAudience(cwd, runId, "owner", "tool"));
	usage.beginParentUsageTracking(cwd, runId, "other");
	await usage.recordParentSessionUsage(cwd, message(777, 1), "other");
	await usage.flushParentUsageTracking(cwd, "other", true);
	assert.equal(await usage.readParentUsage(cwd, runId), undefined);
});

test("foreign feedback-audience sidecars do not claim current parent usage ownership", async (t) => {
	const cwd = await project(t),
		runId = "workflow_foreign_audience";
	await index(cwd, [{ runId, status: "running" }]);
	await mkdir(store.workflowRunDir(cwd, runId), { recursive: true });
	await writeFile(
		join(store.workflowRunDir(cwd, runId), "feedback-audience.json"),
		JSON.stringify({
			schema: "workflow-feedback-audience-v1",
			runId,
			sessionId: "other",
		}),
	);
	usage.beginParentUsageTracking(cwd, runId, "owner");
	await usage.recordParentSessionUsage(cwd, message(7, 1), "owner");
	await usage.flushParentUsageTracking(cwd, "owner", true);
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 7);
});

// Exercise bounded tail IO for huge single-line output using a completed run fixture.
// Host logs use logsAction; this test covers the core formatLogs helper.
test("formatLogs uses bounded tail IO for huge single-line output", async (t) => {
	const { formatLogs } = await import("../../dist/core/engine-format.js");
	(
		await import("../../dist/core/task-backend.js")
	).ensureWorkflowTaskBackendRegistered();
	const cwd = await project(t),
		runId = "workflow_huge_log",
		dir = `.agent-workflow/workflows/${runId}/tasks/task-1`;
	const now = new Date().toISOString();
	await mkdir(join(stateDir(cwd), dir), { recursive: true });
	await writeFile(
		join(stateDir(cwd), ".agent-workflow/workflows", runId, "run.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId,
			name: "huge-log",
			type: "artifact-graph",
			status: "completed",
			taskSummary: {
				total: 1,
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 1,
				failed: 0,
				skipped: 0,
				interrupted: 0,
			},
			cwd,
			backend: { type: "local", mode: "headless" },
			createdAt: now,
			updatedAt: now,
			specPath: "spec.json",
			tasks: [
				{
					taskId: "task-1",
					specId: "main",
					displayName: "main",
					status: "completed",
					statusDetail: "completed",
					files: {
						systemPrompt: `${dir}/system.md`,
						taskPrompt: `${dir}/task.md`,
						output: `${dir}/output.log`,
						stderr: `${dir}/stderr.log`,
						result: `${dir}/result.json`,
					},
				},
			],
		}),
	);
	await writeFile(
		join(stateDir(cwd), dir, "output.log"),
		"X".repeat(8 * 1024 * 1024),
	);
	const text = await formatLogs(cwd, runId, "task-1");
	assert.ok(Buffer.byteLength(text) < 256 * 1024);
	assert.match(text, /truncated/i);
});
