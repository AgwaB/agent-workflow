// test-tier: integration
// WP43: a real multi-task engine run and the real dashboard HTTP host (no model).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setWorkerLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { readRunRecord } from "../../dist/core/store.js";
import * as api from "../../dist/hosts/api.js";
import {
	startDashboardServer,
	projectApi,
} from "../helpers/dashboard-server.mjs";
import { hostApiDashboardSource } from "../../dist/hosts/dashboard/source.js";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";
import { runDiagnostics } from "../helpers/run-diagnostics.mjs";

// The stock fixture emits control/analysis/refs, not foreach items or scripted output.
const TWO_STAGES = {
	schemaVersion: 1,
	name: "wp43-dashboard-integration",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{ id: "b", type: "single", from: "a", prompt: "Check the facts." },
		],
	},
};

// Adapted from host-dashboard-server.test.mjs; the default (WP43d open) mode: no cookie,
// mutations carry same-origin fetch metadata, the server Origin and the CSRF value that
// /api/session hands out.
function http(
	server,
	path,
	{ method = "GET", headers = {}, body, timeoutMs = 20_000 } = {},
) {
	path = projectApi(server, path);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port: server.port,
				path,
				method,
				headers: {
					...(server.cookie ? { Cookie: server.cookie } : {}),
					...headers,
				},
			},
			(res) => {
				const chunks = [];
				res.on("error", reject);
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString();
					resolve({
						status: res.statusCode,
						headers: res.headers,
						text,
						json: () => JSON.parse(text),
					});
				});
			},
		);
		req.setTimeout(timeoutMs, () =>
			req.destroy(new Error(`HTTP timeout: ${path}`)),
		);
		req.on("error", reject);
		req.end(body);
	});
}

async function json(server, path) {
	const response = await http(server, path);
	assert.equal(response.status, 200, response.text);
	return response.json();
}

const mutation = (server) => ({
	method: "POST",
	headers: {
		Origin: `http://127.0.0.1:${server.port}`,
		"Sec-Fetch-Site": "same-origin",
		"X-AW-CSRF": server.csrf,
		"Content-Type": "application/json",
	},
	body: "{}",
});

async function dashboard(cleanups, ctx, readonly = false) {
	const server = await startDashboardServer({
		cwd: ctx.cwd,
		env: ctx.env,
		source: hostApiDashboardSource(ctx),
		readonly,
	});
	cleanups.push(() => server.close());
	assert.equal(server.auth, false);
	assert.equal(
		server.url,
		`http://127.0.0.1:${server.port}/?project=${server.projectId}`,
	);
	const session = await json(server, "/api/session");
	assert.equal(session.auth, false);
	server.csrf = session.csrf;
	assert.equal(typeof server.csrf, "string");
	assert.equal(session.mode, readonly ? "read-only" : "read-write");
	return server;
}

async function poll(read, accepts, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (accepts(value)) return value;
		await delay(50);
	} while (Date.now() < deadline);
	// A run record: name each task's reason and the worker logs (rare load-only failures).
	if (value?.runId && value?.cwd)
		assert.fail(
			`Timed out waiting for ${label}:\n${await runDiagnostics(value.cwd, value.runId)}`,
		);
	assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

function events(cleanups, server, runId) {
	const received = [];
	let error;
	let response;
	let buffer = "";
	const req = get(
		{
			hostname: "127.0.0.1",
			port: server.port,
			path: `/api/events?project=${server.projectId}&run=${runId}`,
			headers: server.cookie ? { Cookie: server.cookie } : {},
		},
		(res) => {
			response = res;
			if (
				res.statusCode !== 200 ||
				!res.headers["content-type"]?.startsWith("text/event-stream")
			)
				error = new Error(`Unexpected SSE response: ${res.statusCode}`);
			res.setEncoding("utf8");
			res.on("error", (err) => {
				error = err;
			});
			res.on("data", (chunk) => {
				buffer += chunk;
				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const lines = buffer.slice(0, boundary).split("\n");
					buffer = buffer.slice(boundary + 2);
					const event = lines.find((line) => line.startsWith("event:"));
					const data = lines
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!event || !data) continue;
					try {
						received.push({
							event: event.slice(6).trim(),
							data: JSON.parse(data),
						});
					} catch (err) {
						error = err;
					}
				}
			});
		},
	);
	req.on("error", (err) => {
		error = err;
	});
	const close = () => {
		response?.destroy();
		req.destroy();
	};
	cleanups.push(close);
	return {
		close,
		wait: (accepts, timeoutMs, label) =>
			poll(
				() => {
					if (error) throw error;
					return received;
				},
				accepts,
				timeoutMs,
				label,
			),
	};
}

const topology = (tasks) =>
	tasks.map(({ taskId, specId, stageId, dependsOn }) => ({
		taskId,
		specId,
		stageId,
		dependsOn,
	}));

function unknownCost(run) {
	// Before the first usage event the rollup is legitimately not collected.
	assert.ok(run.usage === null || run.usage.costUsd === null);
	for (const task of run.tasks)
		assert.ok(task.usage === null || task.usage.costUsd === null);
}

test("dashboard HTTP observes, streams and stops a real multi-task workflow", {
	timeout: 70_000,
}, async (t) => {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "aw-wp43-dashboard-")),
	);
	const ctx = {
		cwd,
		host: "cli",
		env: {
			...process.env,
			AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
			AGENT_WORKFLOW_HOME: join(cwd, "home"),
		},
	};
	let runId;
	let unregister;
	const cleanups = [];
	t.after(async () => {
		try {
			// Close SSE and servers before removing the project they poll.
			for (const cleanup of cleanups.reverse()) await cleanup();
			if (runId && (await readRunRecord(cwd, runId)).status === "running")
				await api.stopAction(ctx, { runId });
		} finally {
			unregister?.();
			setWorkerLaunchControlsForTests({});
			await rm(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	});
	setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(TWO_STAGES)}\n`);
	const executor = "test-wp43-dashboard";
	unregister = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: executor,
			effectLog: join(cwd, "effects.jsonl"),
			stepDelayMs: 1500,
		}),
	);
	const task = "Collect and check dashboard integration facts.";
	const secret = "wp43-planted-secret-do-not-display";
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task,
		executor,
		// No scripted output in this fixture: exercise the permitted launch-command
		// redaction fallback, while leaving the task text independently comparable.
		launchOrigin: {
			kind: "command",
			text: `DASHBOARD_TOKEN=${secret} agent-workflow run wf.json '${task}' --executor ${executor}`,
		},
	});
	assert.equal(launched.outcome, "running", launched.text);
	runId = launched.data.runId;
	assert.ok(runId);
	const record = () => readRunRecord(cwd, runId);
	await poll(
		record,
		(run) => run.tasks[0].status === "running",
		5000,
		"first task running",
	);
	const server = await dashboard(cleanups, ctx);
	const path = `/api/runs/${runId}`;
	const listed = async () =>
		(await json(server, "/api/runs")).runs.find((run) => run.runId === runId);
	let summary = await listed();
	assert.ok(summary);
	assert.equal(summary.status, "running");
	assert.equal(summary.live, true);
	let status = await api.statusAction(ctx, { runId, snapshot: true });
	if (!isDeepStrictEqual(summary.taskSummary, status.data.run.taskSummary)) {
		// One scheduler tick may fall between the HTTP and host-API snapshots.
		summary = await listed();
		status = await api.statusAction(ctx, { runId, snapshot: true });
	}
	assert.deepEqual(summary.taskSummary, status.data.run.taskSummary);
	const detail = await json(server, path);
	assert.deepEqual(topology(detail.tasks), topology((await record()).tasks));
	assert.deepEqual(
		detail.tasks.map((item) => item.stageId),
		["a", "b"],
	);
	assert.deepEqual(detail.tasks[1].dependsOn, [detail.tasks[0].specId]);
	assert.deepEqual(detail.needsYou, []);
	unknownCost(detail);

	const sse = events(cleanups, server, runId);
	const initial = await sse.wait(
		(items) =>
			["runs", "run"].every((kind) =>
				items.some((item) => item.event === kind),
			),
		// 2026-11-10: a hang guard, not a latency check (was "each within 2 s"): with a 1 s poll a 2 s bound could
		// not tell the snapshot sent on connect from the first poll (host-dashboard-server covers the former).
		20_000,
		"initial runs and run SSE events",
	);
	const firstRun = initial.find((item) => item.event === "run").data;
	assert.equal(firstRun.runId, runId);
	assert.ok(
		initial
			.find((item) => item.event === "runs")
			.data.runs.some((run) => run.runId === runId),
	);

	const readonly = await dashboard(cleanups, ctx, true);
	const refused = await http(readonly, `${path}/stop`, mutation(readonly));
	assert.equal(refused.status, 403);
	assert.deepEqual(refused.json(), { error: "read-only" });
	assert.equal((await record()).status, "running");

	const completed = await poll(
		record,
		(run) => run.tasks[0].status === "completed",
		12_000,
		"first task completed",
	);
	const taskId = completed.tasks[0].taskId;
	const logs = await json(
		server,
		`${path}/tasks/${taskId}/logs?stream=all&lines=400`,
	);
	assert.equal(logs.taskId, taskId);
	assert.deepEqual(
		logs.streams.map((stream) => stream.kind),
		["output", "stderr", "events"],
	);
	for (const stream of logs.streams) {
		assert.ok(stream.lines.length <= 400);
		assert.equal(stream.refused, undefined);
	}
	assert.ok(
		logs.streams.find((stream) => stream.kind === "output").lines.length > 0,
	);
	assert.ok(
		logs.streams.find((stream) => stream.kind === "events").lines.length > 0,
	);
	const progressed = await json(server, path);
	assert.equal(progressed.usage.costUsd, null);
	unknownCost(progressed);
	const shown = await api.showAction(ctx, { ref: runId, snapshot: true });
	assert.equal(progressed.launch.command, shown.data.launch.command.text);
	assert.equal(progressed.launch.command.includes(secret), false);
	assert.match(progressed.launch.command, /DASHBOARD_TOKEN=.*REDACTED/);

	await sse.wait(
		(items) =>
			items.some(
				(item) =>
					item.event === "run" &&
					item.data.tasks.some(
						(task) =>
							firstRun.tasks.find((previous) => previous.taskId === task.taskId)
								?.status !== task.status,
					),
			),
		4000,
		"SSE task status change",
	);
	sse.close();
	const stoppingAt = Date.now();
	// 2026-11-05 (first CI runs: one ubuntu/Node 26 job timed out on this request after 20 s, the
	// test took 36 s against 9-13 s locally): record how long the stop took and where the run stood.
	// 2026-11-05 (owner): the client waits 30 s here; the stop confirmation itself may take up to
	// 15 s (HOST_STOP_CONFIRM_TIMEOUT_MS) plus a retry, and the 20 s bound below still holds.
	const stopped = await http(server, `${path}/stop`, {
		...mutation(server),
		timeoutMs: 30_000,
	}).catch(async (error) => {
		const run = await record().catch(() => undefined);
		t.diagnostic(
			JSON.stringify({
				stopMs: Date.now() - stoppingAt,
				status: run?.status,
				tasks: run?.tasks.map((task) => task.status),
			}),
		);
		throw error;
	});
	t.diagnostic(JSON.stringify({ stopMs: Date.now() - stoppingAt }));
	if (stopped.status !== 200) t.diagnostic(await runDiagnostics(cwd, runId));
	assert.equal(stopped.status, 200, stopped.text);
	await poll(
		record,
		(run) => run.status === "interrupted",
		Math.max(1, 20_000 - (Date.now() - stoppingAt)),
		"interrupted run",
	);
	assert.ok(Date.now() - stoppingAt < 20_000);
	const interrupted = await listed();
	assert.equal(interrupted.status, "interrupted");
	// Product question: projectNeedsYou only emits generic failed/blocked alerts,
	// not interrupted alerts, although resuming an interrupted run needs a human.
	assert.deepEqual(interrupted.needsYou, []);
	assert.deepEqual((await json(server, path)).needsYou, []);
	// Check task text last so a projection regression cannot hide the lifecycle
	// checks above: record.description is the spec description, not the launch task.
	assert.equal(detail.task, task);
	// Resume intentionally omitted: hostApiDashboardSource unconditionally calls
	// resumeAction({ detach: true }), spawning an unmanaged supervisor. This test
	// owns only an attached fixture run and must not leave detached processes behind.
});

test("dashboard stop recovers an escalated worker without a terminal finalizer", {
	timeout: 70_000,
}, async (t) => {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "aw-dashboard-stop-")),
	);
	const ctx = {
		cwd,
		host: "cli",
		env: {
			...process.env,
			AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
			AGENT_WORKFLOW_HOME: join(cwd, "home"),
		},
	};
	const cleanups = [];
	let runId;
	let unregister;
	t.after(async () => {
		try {
			for (const cleanup of cleanups.reverse()) await cleanup();
			if (runId && (await readRunRecord(cwd, runId)).status === "running")
				await api.stopAction(ctx, { runId });
		} finally {
			unregister?.();
			setWorkerLaunchControlsForTests({});
			await rm(cwd, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	});
	setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			...TWO_STAGES,
			artifactGraph: { stages: [TWO_STAGES.artifactGraph.stages[0]] },
		}),
	);
	const executor = "test-dashboard-stop";
	const effectLog = join(cwd, "effects.jsonl");
	unregister = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: executor,
			effectLog,
			// Cancellation cannot emit a terminal event before the 3 s SIGKILL escalation.
			stepDelayMs: 30_000,
		}),
	);
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "Stop an executing worker.",
		executor,
	});
	assert.equal(launched.outcome, "running", launched.text);
	runId = launched.data.runId;
	await poll(
		() => readFixtureLog(effectLog),
		(entries) => entries.some((entry) => entry.type === "effect"),
		15_000,
		"executor effect before stop",
	);
	const server = await dashboard(cleanups, ctx);
	const startedAt = Date.now();
	const stopped = await http(server, `/api/runs/${runId}/stop`, {
		...mutation(server),
		timeoutMs: 30_000,
	});
	if (stopped.status !== 200) t.diagnostic(await runDiagnostics(cwd, runId));
	assert.equal(stopped.status, 200, stopped.text);
	assert.ok(Date.now() - startedAt < 20_000);
	const run = await readRunRecord(cwd, runId);
	assert.equal(run.status, "interrupted");
	assert.equal(run.tasks[0].status, "interrupted");
	assert.equal(
		run.tasks[0].durableLaunchBarrier.records.at(-1).phase,
		"cancellation_acknowledged",
	);
	assert.ok(readFixtureLog(effectLog).some((entry) => entry.type === "cancel"));
});
