import { stateDir } from "../helpers/state-dir.mjs";
// WP43: real host-API source over isolated persisted records (no executors or models).
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostApiDashboardSource } from "../../dist/hosts/dashboard/source.js";
import {
	readHostRunReport,
	REPORT_MAX_BYTES,
} from "../../dist/hosts/run-artifacts.js";
import { withRunLease } from "../../dist/core/store.js";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";

const AT = "2026-10-29T08:00:00.000Z";
const SECRET = "dashboard-test-secret-0123456789";
async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-dashboard-source-"));
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const ctx = {
		cwd,
		env: { ...process.env, SERVICE_TOKEN: SECRET },
		host: "cli",
	};
	return { ctx, source: hostApiDashboardSource(ctx) };
}
async function writeRun(ctx, id, options = {}) {
	const relativeDir = `.agent-workflow/workflows/${id}`;
	const dir = join(stateDir(ctx.cwd), relativeDir);
	await mkdir(join(dir, "report"), { recursive: true });
	const record = {
		schemaVersion: 1,
		runId: id,
		name: `report ${SECRET}`,
		description: `Task ${SECRET}`,
		type: "workflow",
		createdAt: options.createdAt ?? AT,
		updatedAt: AT,
		cwd: ctx.cwd,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		tasks: [
			{
				taskId: "task-1",
				specId: "report.main",
				stageId: "report",
				agent: "reader",
				agentFile: "",
				agentDescription: "reader",
				roles: [],
				displayName: "Report",
				kind: "single",
				status: options.status ?? "completed",
				statusDetail: options.status ?? "completed",
				startedAt: AT,
				completedAt: AT,
				runtime: { approvalMode: "never" },
				worktree: {
					enabled: false,
					path: null,
					branch: null,
					baseCwd: null,
					warning: null,
				},
				cwd: ctx.cwd,
				backendTaskId: "",
				files: {
					output: `${relativeDir}/report/output.log`,
					stderr: `${relativeDir}/report/stderr.log`,
					systemPrompt: "",
					taskPrompt: "",
					result: "",
				},
				lastMessage: `done ${SECRET}`,
			},
		],
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
	};
	await writeFile(join(dir, "run.json"), JSON.stringify(record));
	await writeFile(
		join(dir, "report", "control.json"),
		JSON.stringify({ verdict: "COMPLETE" }),
	);
	await writeFile(
		join(dir, "report", "output.log"),
		Array.from({ length: 500 }, (_, index) => `${index}: ${SECRET}`).join("\n"),
	);
	await writeFile(
		join(dir, "report", "final-report.md"),
		`# Report\n${SECRET}\n${"long word ".repeat(30000)}`,
	);
	return { dir, record };
}

test("host source projects top-level runs newest first, redacts all strings and checks log files", {
	timeout: 8000,
}, async (t) => {
	const { ctx, source } = await project(t);
	await writeRun(ctx, "workflow_old");
	await writeRun(ctx, "workflow_new", {
		createdAt: "2026-10-29T09:00:00.000Z",
	});
	await writeRun(ctx, "workflow_child", { parentRunId: "workflow_new" });
	const before = await readFile(
		join(stateDir(ctx.cwd), ".agent-workflow/workflows/workflow_new/run.json"),
		"utf8",
	);
	const listed = await source.listRuns();
	assert.deepEqual(
		listed.map((run) => run.runId),
		["workflow_new", "workflow_old"],
	);
	assert.equal(JSON.stringify(listed).includes(SECRET), false);
	assert.equal(listed[0].live, false);
	assert.equal(listed[0].reportAvailable, true);
	const detail = await source.run("workflow_new");
	assert.equal(detail.tasks[0].hasLogs, true);
	assert.equal(detail.usage, null);
	assert.equal(JSON.stringify(detail).includes(SECRET), false);
	assert.equal(detail.verdict, "COMPLETE");
	const logs = await source.taskLogs("workflow_new", "task-1", {
		lines: 400,
		stream: "output",
	});
	assert.ok(logs.streams[0].lines.length <= 400);
	assert.equal(logs.streams[0].truncated, true);
	assert.equal(JSON.stringify(logs).includes(SECRET), false);
	const report = await source.report("workflow_new");
	assert.equal(report.truncated, true);
	assert.match(report.text, /Report truncated/);
	assert.equal(report.text.includes(SECRET), false);
	assert.ok(Buffer.byteLength(report.text) < REPORT_MAX_BYTES + 100);
	assert.equal(
		await readFile(
			join(
				stateDir(ctx.cwd),
				".agent-workflow/workflows/workflow_new/run.json",
			),
			"utf8",
		),
		before,
	);
	assert.deepEqual(
		(
			await readdir(
				join(stateDir(ctx.cwd), ".agent-workflow/workflows/workflow_new"),
			)
		).sort(),
		["report", "run.json"],
	);
	await rm(
		join(
			stateDir(ctx.cwd),
			".agent-workflow/workflows/workflow_new/report/output.log",
		),
	);
	assert.equal((await source.run("workflow_new")).tasks[0].hasLogs, false);
});

test("HTTP never accepts a valid-looking run prefix as a full id", {
	timeout: 8000,
}, async (t) => {
	const { ctx } = await project(t);
	await writeRun(ctx, "workflow_unique_full");
	const s = await startDashboardServer(ctx);
	t.after(() => s.close());
	const headers = { Cookie: `aw_session=${s.token}` };
	const origin = `http://127.0.0.1:${s.port}`;
	assert.equal(
		(await fetch(`${origin}/api/runs/workflow_unique_full`, { headers }))
			.status,
		200,
	);
	assert.equal(
		(await fetch(`${origin}/api/runs/workflow_unique`, { headers })).status,
		404,
	);
});

test("live uses running + lease semantics, not merely a persisted running status", {
	timeout: 8000,
}, async (t) => {
	const { ctx, source } = await project(t);
	await writeRun(ctx, "workflow_live", { status: "running" });
	await withRunLease(ctx.cwd, "workflow_live", async () => {
		assert.equal((await source.run("workflow_live")).live, true);
	});
	// Terminal runs never become live just because a stale supervisor receipt exists.
	await writeRun(ctx, "workflow_done");
	await withRunLease(ctx.cwd, "workflow_done", async () => {
		assert.equal((await source.run("workflow_done")).live, false);
	});
});

test("host report reads refuse traversal, absolute paths, symlink escapes and binary files", {
	timeout: 5000,
}, async (t) => {
	const { ctx } = await project(t);
	await mkdir(join(stateDir(ctx.cwd), ".agent-workflow"));
	await writeFile(join(ctx.cwd, "outside.txt"), SECRET);
	await symlink(
		join(ctx.cwd, "outside.txt"),
		join(stateDir(ctx.cwd), ".agent-workflow", "escape.md"),
	);
	await writeFile(
		join(stateDir(ctx.cwd), ".agent-workflow", "binary"),
		Buffer.from([0, 1, 2]),
	);
	for (const path of [
		"outside.txt",
		"../outside.txt",
		join(ctx.cwd, "outside.txt"),
		".agent-workflow/escape.md",
		".agent-workflow/binary",
		".agent-workflow/missing.md",
	])
		assert.equal(await readHostRunReport(ctx, path), undefined, path);
	const text = "x".repeat(300000);
	await writeFile(join(stateDir(ctx.cwd), ".agent-workflow", "long.md"), text);
	const report = await readHostRunReport(ctx, ".agent-workflow/long.md");
	assert.equal(report.truncated, true);
	assert.match(report.text, /Report truncated/);
	assert.equal(
		(
			await readFile(
				join(stateDir(ctx.cwd), ".agent-workflow", "long.md"),
				"utf8",
			)
		).length,
		text.length,
	);
});
