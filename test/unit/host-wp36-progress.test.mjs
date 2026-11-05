// New in agent-workflow (WP36, owner decisions E1/E2): host UX for Claude Code and Codex without a
// model call: `agent-workflow statusline` (Claude Code statusLine command), `agent-workflow watch`
// (terminal live view) and `agent-workflow notify-check` (runs that finished since the last check,
// each settled state once). Synthetic run records in temporary projects, plus one real
// dynamic-approval run on the workflow executor fixture; no model or agent-CLI calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { approvalProject } from "../helpers/dynamic-approval-fixture.mjs";

const cli = await import("../../dist/hosts/cli/index.js");
const statusline = await import("../../dist/hosts/cli/statusline.js");
const progress = await import("../../dist/hosts/run-progress.js");
const watch = await import("../../dist/hosts/watch.js");
const notify = await import("../../dist/hosts/notify-check.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

const BIN = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp36-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(cwd, { recursive: true });
	return cwd;
}

/** A synthetic run record (`run.json`); `report` adds a final-stage control with a verdict. */
async function writeRun(cwd, options) {
	const {
		runId,
		name = "deep-review",
		tasks,
		createdAt = minutesAgo(12),
		updatedAt = minutesAgo(1),
		parentRunId,
		report,
	} = options;
	const dir = join(cwd, ".agent-workflow", "workflows", runId);
	await mkdir(dir, { recursive: true });
	const records = tasks.map((task, index) => {
		const specId = task.specId ?? `task-${index}`;
		return {
			taskId: `${specId}-1`,
			specId,
			displayName: task.displayName ?? specId,
			status: task.status,
			statusDetail: task.statusDetail ?? task.status,
			...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
			...(task.startedAt ? { startedAt: task.startedAt } : {}),
			...(task.completedAt ? { completedAt: task.completedAt } : {}),
			...(task.lastMessage ? { lastMessage: task.lastMessage } : {}),
			files: {
				systemPrompt: "",
				taskPrompt: "",
				output: `.agent-workflow/workflows/${runId}/${specId}/output.log`,
				stderr: "",
				result: "",
			},
		};
	});
	if (report) {
		const taskDir = join(dir, report.specId);
		await mkdir(taskDir, { recursive: true });
		await writeFile(
			join(taskDir, "control.json"),
			JSON.stringify({ verdict: report.verdict }),
		);
		await writeFile(
			join(taskDir, "final-report.md"),
			"# Report\n\nFindings.\n",
		);
	}
	await writeFile(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			name,
			type: "workflow",
			createdAt,
			updatedAt,
			...(parentRunId ? { parentRunId } : {}),
			tasks: records,
			taskSummary: {
				total: 0,
				completed: 0,
				failed: 0,
				interrupted: 0,
				pending: 0,
				running: 0,
				blocked: 0,
				skipped: 0,
			},
		}),
	);
}

const RUNNING = [
	{
		specId: "scope",
		status: "completed",
		startedAt: minutesAgo(12),
		completedAt: minutesAgo(10),
	},
	{ specId: "reviewer", status: "running", startedAt: minutesAgo(10) },
	{ specId: "synthesis", status: "pending", dependsOn: ["reviewer"] },
];
const DONE = [
	{ specId: "scope", status: "completed" },
	{ specId: "render", status: "completed", dependsOn: ["scope"] },
];

function capture() {
	const out = [];
	return { out, write: (text) => out.push(text), text: () => out.join("") };
}

async function runCli(cwd, argv, extra = {}) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env: process.env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
		now: () => NOW,
		...extra,
	});
	return { code, out: out.join(""), err: err.join("") };
}

/** The real bin in a fresh process; `stdin` text is piped and closed. */
function runBin(cwd, argv, stdin) {
	return new Promise((resolveRun) => {
		const started = Date.now();
		const child = spawn(process.execPath, [BIN, ...argv], {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("close", (code) =>
			resolveRun({ code, out, err, ms: Date.now() - started }),
		);
		child.stdin.end(stdin ?? "");
	});
}

// --- statusline ---

test("statusline: empty when idle; the newest active run with progress, state, elapsed and the count of others", async () => {
	const cwd = await project();
	assert.equal(await statusline.statusLineText([cwd], NOW), "");
	await writeRun(cwd, { runId: "workflow_done", tasks: DONE });
	assert.equal(await statusline.statusLineText([cwd], NOW), "");
	await writeRun(cwd, {
		runId: "workflow_old",
		name: "spec-review",
		createdAt: minutesAgo(30),
		tasks: RUNNING,
	});
	await writeRun(cwd, { runId: "workflow_new", tasks: RUNNING });
	// A child run never shows on its own.
	await writeRun(cwd, {
		runId: "workflow_child",
		createdAt: minutesAgo(1),
		parentRunId: "workflow_new",
		tasks: RUNNING,
	});
	assert.equal(
		await statusline.statusLineText([cwd], NOW),
		"aw: deep-review 1/3 running (no supervisor) 12m · +1 more",
	);
	const result = await runCli(cwd, ["statusline"]);
	assert.equal(result.code, 0);
	assert.equal(
		result.out,
		"aw: deep-review 1/3 running (no supervisor) 12m · +1 more\n",
	);
});

test("statusline: blocked runs show as awaiting approval or needs action for a day, then drop out", async () => {
	const cwd = await project();
	await writeRun(cwd, {
		runId: "workflow_approval",
		name: "dynamic",
		tasks: [
			{ specId: "prep", status: "completed" },
			{
				specId: "adaptive.controller",
				status: "blocked",
				statusDetail: "dynamic_ui_unavailable",
			},
		],
	});
	assert.equal(
		await statusline.statusLineText([cwd], NOW),
		"aw: dynamic 1/2 awaiting approval 12m",
	);
	await rm(join(cwd, ".agent-workflow"), { recursive: true });
	await writeRun(cwd, {
		runId: "workflow_blocked",
		tasks: [
			{ specId: "a", status: "blocked", statusDetail: "required_read_failed" },
		],
	});
	assert.equal(
		await statusline.statusLineText([cwd], NOW),
		"aw: deep-review 0/1 needs action 12m",
	);
	await writeRun(cwd, {
		runId: "workflow_blocked",
		createdAt: minutesAgo(3 * 24 * 60),
		updatedAt: minutesAgo(2 * 24 * 60),
		tasks: [
			{ specId: "a", status: "blocked", statusDetail: "required_read_failed" },
		],
	});
	assert.equal(await statusline.statusLineText([cwd], NOW), "");
});

test("statusline: reads Claude Code's stdin JSON (project_dir, current_dir, cwd) and falls back to the working directory", async () => {
	const cwd = await project();
	const other = await project();
	assert.deepEqual(statusline.statusLineDirectories(undefined, cwd), [cwd]);
	assert.deepEqual(statusline.statusLineDirectories("not json", cwd), [cwd]);
	assert.deepEqual(
		statusline.statusLineDirectories(
			JSON.stringify({
				cwd: other,
				workspace: { project_dir: cwd, current_dir: other },
			}),
			"/elsewhere",
		),
		[cwd, other],
	);
	await writeRun(other, { runId: "workflow_other", tasks: RUNNING });
	const out = capture();
	const code = await statusline.runStatusLine({
		cwd,
		readStdin: async () =>
			JSON.stringify({ workspace: { project_dir: cwd, current_dir: other } }),
		stdout: out.write,
		now: () => NOW,
	});
	assert.equal(code, 0);
	assert.equal(out.text(), "aw: deep-review 1/3 running (no supervisor) 12m\n");
	// A run index entry is the candidate list (the run record is read for fresh state).
	await mkdir(join(cwd, ".agent-workflow", "workflows"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "workflows", "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: minutesAgo(0),
			runs: [
				{
					runId: "workflow_missing",
					status: "running",
					taskSummary: {},
					createdAt: minutesAgo(1),
					updatedAt: minutesAgo(1),
				},
			],
		}),
	);
	assert.equal(await statusline.statusLineText([cwd], NOW), "");
});

test("statusline bin: fast path with stdin JSON, silent and exit 0 on idle, bad input or a corrupt run", async () => {
	const cwd = await project();
	await writeRun(cwd, { runId: "workflow_bin", tasks: RUNNING });
	const shown = await runBin(
		"/",
		["statusline"],
		JSON.stringify({ workspace: { project_dir: cwd, current_dir: cwd }, cwd }),
	);
	assert.equal(shown.code, 0, shown.err);
	assert.match(
		shown.out,
		/^aw: deep-review 1\/3 running \(no supervisor\) \d+[smhd]/,
	);
	assert.equal(shown.err, "");
	// Generous bound for a loaded CI machine; typical is well under 200 ms.
	assert.ok(shown.ms < 5_000, `statusline took ${shown.ms} ms`);

	const idle = await runBin(await project(), ["statusline"], "{}");
	assert.deepEqual([idle.code, idle.out, idle.err], [0, "", ""]);
	const garbage = await runBin(cwd, ["statusline", "--bogus"], "{{{");
	assert.equal(garbage.code, 0);
	assert.equal(garbage.err, "");
	await writeFile(
		join(cwd, ".agent-workflow", "workflows", "workflow_bin", "run.json"),
		"{ torn",
	);
	const torn = await runBin(cwd, ["statusline"], "");
	assert.deepEqual([torn.code, torn.err], [0, ""]);
	const help = await runBin(cwd, ["statusline", "--help"], "");
	assert.match(help.out, /Usage: agent-workflow statusline/);
});

// --- watch ---

test("watch: project view of active runs, one frame; nothing active exits at once", async () => {
	const cwd = await project();
	const empty = await runCli(cwd, ["watch"]);
	assert.equal(empty.code, 0);
	assert.match(empty.out, /No active workflow runs in this project/);
	await writeRun(cwd, { runId: "workflow_w1", tasks: RUNNING });
	const once = await runCli(cwd, ["watch", "--once"]);
	assert.equal(once.code, 0);
	assert.match(
		once.out,
		/▶ deep-review workflow_w1 1\/3 12m running \(no live supervisor\) — reviewer/,
	);
	assert.doesNotMatch(once.out, /\u001b\[/, "no ANSI codes without a terminal");
});

test("watch <run>: tasks, elapsed, supervisor warning; exits when the run ends (0 completed) with verdict and report", async () => {
	const cwd = await project();
	await writeRun(cwd, { runId: "workflow_live", tasks: RUNNING });
	const frames = capture();
	let sleeps = 0;
	const code = await watch.runWatch({
		cwd,
		runRef: "workflow_live",
		isTTY: false,
		write: frames.write,
		now: () => NOW,
		sleep: async () => {
			sleeps += 1;
			// Unchanged on the first sleep (no new frame on a pipe), finished on the second.
			if (sleeps === 2)
				await writeRun(cwd, {
					runId: "workflow_live",
					tasks: [
						{ specId: "scope", status: "completed" },
						{ specId: "reviewer", status: "completed", dependsOn: ["scope"] },
						{ specId: "render", status: "completed", dependsOn: ["reviewer"] },
					],
					report: { specId: "render", verdict: "NEEDS_WORK" },
				});
		},
	});
	assert.equal(code, 0);
	assert.equal(sleeps, 2);
	assert.equal(
		frames.out.length,
		2,
		"a pipe gets a frame only when something changed",
	);
	const [first, last] = frames.out;
	assert.match(first, /deep-review \(workflow_live\)/);
	assert.match(
		first,
		/Status: running · 1\/3 completed · 1 running · 0 failed · elapsed 12m/,
	);
	assert.match(
		first,
		/No live supervisor is driving this run\. Start one with: agent-workflow supervise workflow_live/,
	);
	assert.match(first, /✓ scope\s+completed\s+2m/);
	assert.match(first, /▶ reviewer\s+running\s+10m/);
	assert.match(first, /· synthesis\s+pending/);
	assert.match(last, /Finished: completed — verdict NEEDS_WORK/);
	assert.match(
		last,
		/Final report: \.agent-workflow\/workflows\/workflow_live\/render\/final-report\.md/,
	);
});

test("watch: a failed run exits 1; --follow keeps watching until stopped; a terminal gets redraws, colors and the bell", async () => {
	const cwd = await project();
	await writeRun(cwd, {
		runId: "workflow_failed",
		tasks: [
			{
				specId: "a",
				status: "failed",
				lastMessage: "worker exited with code 3",
			},
		],
	});
	const failed = await runCli(cwd, ["watch", "workflow_failed"]);
	assert.equal(failed.code, 1);
	assert.match(failed.out, /✗ a\s+failed\s+.*worker exited with code 3/);
	assert.match(failed.out, /Finished: failed — status failed/);

	const controller = new AbortController();
	const tty = capture();
	let ticks = 0;
	const code = await watch.runWatch({
		cwd,
		runRef: "workflow_failed",
		follow: true,
		bell: true,
		isTTY: true,
		color: true,
		write: tty.write,
		now: () => NOW,
		signal: controller.signal,
		sleep: async () => {
			ticks += 1;
			if (ticks === 3) controller.abort();
		},
	});
	assert.equal(code, 0);
	assert.equal(tty.out.length, 3, "a terminal is redrawn every tick");
	assert.ok(tty.out.every((frame) => frame.startsWith("\u001b[H\u001b[2J")));
	assert.match(tty.text(), /\u001b\[31m/);
	assert.doesNotMatch(tty.text(), /\u0007/, "no bell while following");

	const bell = capture();
	await watch.runWatch({
		cwd,
		runRef: "workflow_failed",
		bell: true,
		isTTY: true,
		write: bell.write,
		now: () => NOW,
	});
	assert.equal(bell.out.at(-1), "\u0007");
});

test("watch: pending approvals show the question and the approve/reject commands; usage errors", async () => {
	const lines = watch
		.renderRunView(
			{
				run: {
					runId: "workflow_ask",
					name: "dynamic",
					status: "blocked",
					createdAt: minutesAgo(5),
					updatedAt: minutesAgo(1),
					tasks: [],
					taskSummary: {
						total: 1,
						completed: 0,
						failed: 0,
						interrupted: 0,
						pending: 0,
						running: 0,
						blocked: 1,
						skipped: 0,
					},
				},
				live: false,
				settled: true,
				terminal: false,
				reportPaths: [],
				pendingApprovals: [
					{
						requestId: "abcdef0123456789",
						controllerSpecId: "adaptive.controller",
						taskId: "t",
						title: "Run dynamic workflow controller?",
						message: "Controller wants to run helpers/controller.mjs",
						requestedAt: minutesAgo(1),
					},
				],
			},
			{ now: NOW },
		)
		.join("\n");
	assert.match(
		lines,
		/Awaiting approval: dynamic controller adaptive\.controller/,
	);
	assert.match(lines, /Controller wants to run helpers\/controller\.mjs/);
	assert.match(
		lines,
		/Approve: agent-workflow approve workflow_ask --request abcdef012345/,
	);
	assert.match(
		lines,
		/Reject: agent-workflow approve workflow_ask --request abcdef012345 --reject/,
	);

	const cwd = await project();
	for (const argv of [
		["watch", "--interval", "0.5"],
		["watch", "--interval", "11"],
		["watch", "a", "b"],
		["watch", "--json"],
	]) {
		const result = await runCli(cwd, argv);
		assert.equal(result.code, 2, argv.join(" "));
	}
	const unknown = await runCli(cwd, ["watch", "workflow_nope"]);
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /not found/);
});

// --- notify-check ---

test("notify-check: nothing (and nothing written) without runs; each settled state printed once; verdict, report, host hints", async () => {
	const cwd = await project();
	const none = await runCli(cwd, ["notify-check"]);
	assert.deepEqual([none.code, none.out], [0, ""]);
	assert.equal(existsSync(join(cwd, ".agent-workflow")), false);

	await writeRun(cwd, {
		runId: "workflow_report",
		tasks: DONE,
		updatedAt: minutesAgo(5),
		report: { specId: "render", verdict: "NEEDS_WORK" },
	});
	await writeRun(cwd, { runId: "workflow_running", tasks: RUNNING });
	// Settled before the first check's look-back window: never reported.
	await writeRun(cwd, {
		runId: "workflow_ancient",
		tasks: DONE,
		updatedAt: minutesAgo(3 * 60),
	});
	const first = await runCli(cwd, ["notify-check", "--host", "claude-code"]);
	assert.equal(first.code, 0);
	assert.equal(
		first.out,
		'agent-workflow: workflow "deep-review" (run workflow_report) finished — verdict NEEDS_WORK, report .agent-workflow/workflows/workflow_report/render/final-report.md. Details: workflow_status {"runId":"workflow_report"}\n',
	);
	const second = await runCli(cwd, ["notify-check", "--host", "claude-code"]);
	assert.equal(second.out, "", "printed once");

	// The running run finishes (failed): reported with CLI hints.
	await writeRun(cwd, {
		runId: "workflow_running",
		updatedAt: minutesAgo(0),
		tasks: [
			{ specId: "scope", status: "completed" },
			{ specId: "reviewer", status: "failed", dependsOn: ["scope"] },
		],
	});
	const third = await runCli(cwd, ["notify-check", "--json"]);
	const parsed = JSON.parse(third.out);
	assert.equal(parsed.data.notifications.length, 1);
	const [note] = parsed.data.notifications;
	assert.equal(note.runId, "workflow_running");
	assert.equal(note.status, "failed");
	assert.match(
		note.text,
		/finished — status failed \(1 failed, 0 interrupted of 2 tasks\)\. Details: agent-workflow status workflow_running$/,
	);
	// Resumed and settled again with a different state: reported again.
	await writeRun(cwd, {
		runId: "workflow_running",
		updatedAt: minutesAgo(0),
		tasks: [
			{ specId: "scope", status: "completed" },
			{ specId: "reviewer", status: "completed", dependsOn: ["scope"] },
		],
	});
	assert.match(
		(await runCli(cwd, ["notify-check"])).out,
		/workflow_running\) finished — status completed/,
	);
	// A pruned run's marker is removed.
	await rm(join(cwd, ".agent-workflow", "workflows", "workflow_report"), {
		recursive: true,
	});
	await runCli(cwd, ["notify-check"]);
	const markers = await readdir(join(cwd, ".agent-workflow", "notify-check"));
	assert.ok(markers.includes("baseline.json"));
	assert.ok(!markers.some((name) => name.startsWith("workflow_report.")));
	assert.ok(markers.some((name) => name.startsWith("workflow_running.")));
	assert.equal((await runCli(cwd, ["notify-check", "--host", "nope"])).code, 2);
});

test("notify-check: concurrent checks print a state once; at most 5 runs per check, the rest next time", async () => {
	const cwd = await project();
	for (let index = 0; index < 7; index += 1)
		await writeRun(cwd, {
			runId: `workflow_many${index}`,
			tasks: DONE,
			updatedAt: minutesAgo(10 - index),
		});
	const results = await Promise.all(
		[1, 2, 3].map(() => notify.notifyCheck(cwd, { now: NOW })),
	);
	const printed = results.flatMap((item) =>
		item.data.notifications.map((n) => n.runId),
	);
	assert.equal(new Set(printed).size, printed.length, "no state printed twice");
	const firstBatch = results.find((item) => item.data.notifications.length);
	assert.ok(printed.length >= 5 && printed.length <= 7);
	assert.ok(
		firstBatch.data.notifications.length <= notify.NOTIFY_CHECK_MAX_RUNS,
	);
	const rest = await notify.notifyCheck(cwd, { now: NOW });
	assert.equal(printed.length + rest.data.notifications.length, 7);
	assert.equal((await notify.notifyCheck(cwd, { now: NOW })).text, "");
	const deferred = await (async () => {
		const other = await project();
		for (let index = 0; index < 7; index += 1)
			await writeRun(other, {
				runId: `workflow_more${index}`,
				tasks: DONE,
				updatedAt: minutesAgo(10 - index),
			});
		return notify.notifyCheck(other, { now: NOW, host: "codex" });
	})();
	assert.equal(deferred.data.notifications.length, 5);
	assert.equal(deferred.data.deferred, 2);
	assert.match(deferred.text, /2 more finished run\(s\).*workflow_status \{\}/);
});

test("notify-check --follow: one line per newly settled run until stopped; usage errors", async () => {
	const cwd = await project();
	await writeRun(cwd, { runId: "workflow_f1", tasks: RUNNING });
	const controller = new AbortController();
	const out = [];
	let ticks = 0;
	const code = await cli.runAgentWorkflowCli(
		["notify-check", "--follow", "--interval", "1", "--host", "claude-code"],
		{
			cwd,
			env: process.env,
			stdout: (text) => out.push(text),
			stderr: () => {},
			isTTY: false,
			now: () => NOW,
			signal: controller.signal,
			sleep: async (ms) => {
				assert.equal(ms, 1_000);
				ticks += 1;
				if (ticks === 2)
					await writeRun(cwd, { runId: "workflow_f1", tasks: DONE });
				if (ticks === 4) controller.abort();
			},
		},
	);
	assert.equal(code, 0);
	assert.equal(out.length, 1);
	assert.match(
		out[0],
		/workflow_f1\) finished — status completed\. Details: workflow_status/,
	);
	for (const argv of [
		["notify-check", "--follow", "--json"],
		["notify-check", "--interval", "5"],
		["notify-check", "--follow", "--interval", "0"],
		["notify-check", "extra"],
	])
		assert.equal((await runCli(cwd, argv)).code, 2, argv.join(" "));
});

test("approval run (fixture executor): statusline, watch and notify-check show the pending approval; wait marks a settled state seen", async () => {
	counter += 1;
	const p = await approvalProject(root, `approval${counter}`, (descriptor) =>
		unregister.push(core.registerWorkflowExecutor(descriptor)),
	);
	// notify-check in use here (its receipts exist) before the run starts.
	await mkdir(join(p.cwd, ".agent-workflow", "notify-check"), {
		recursive: true,
	});
	const run = await runCli(
		p.cwd,
		["run", "wf.json", "headless", "--executor", p.executor],
		{ env: p.env, now: undefined, waitSliceMs: 2_000 },
	);
	assert.equal(run.code, 1, run.out + run.err);
	const runId = /Run: (workflow_\S+)/.exec(run.out)?.[1];
	assert.ok(runId);
	assert.match(
		await statusline.statusLineText([p.cwd]),
		/^aw: wp29-dynamic-approval 1\/2 awaiting approval /,
	);
	const watched = await runCli(p.cwd, ["watch", runId], {
		env: p.env,
		now: undefined,
	});
	assert.equal(watched.code, 1);
	assert.match(
		watched.out,
		/Awaiting approval: dynamic controller adaptive\.controller/,
	);
	assert.match(
		watched.out,
		new RegExp(`Approve: agent-workflow approve ${runId} --request`),
	);
	// The foreground run's wait returned this blocked state: notify-check does not repeat it …
	const seen = await notify.notifyCheck(p.cwd, { host: "codex" });
	assert.equal(seen.text, "");
	// … but a project without the wait receipt gets the approval line with the MCP tool call.
	await rm(join(p.cwd, ".agent-workflow", "notify-check"), { recursive: true });
	const fresh = await notify.notifyCheck(p.cwd, { host: "codex" });
	assert.equal(fresh.data.notifications.length, 1);
	assert.match(
		fresh.text,
		/is waiting for the user's approval of dynamic controller adaptive\.controller\. .*workflow_approve \{"runId":"workflow_/,
	);
	const marker = (
		await readdir(join(p.cwd, ".agent-workflow", "notify-check"))
	).find((name) => name.startsWith(runId));
	assert.equal(
		JSON.parse(
			await readFile(
				join(p.cwd, ".agent-workflow", "notify-check", marker),
				"utf8",
			),
		).via,
		"notify-check",
	);
});

test("progress helpers: elapsed formatting and name cutting", () => {
	assert.equal(progress.formatElapsed(45_000), "45s");
	assert.equal(progress.formatElapsed(12 * 60_000), "12m");
	assert.equal(progress.formatElapsed(65 * 60_000), "1h05m");
	assert.equal(progress.formatElapsed(50 * 3_600_000), "2d02h");
	assert.equal(
		progress.shortRunName({ runId: "x", name: "a".repeat(30) }),
		`${"a".repeat(23)}…`,
	);
});

// WP39b O5: in a fresh project (no `.agent-workflow/notify-check/` yet) a settled state that `wait`
// returned was announced again by the first notify-check (the hook). `wait` now creates the
// receipts directory and baseline itself.
test("wait marks a returned settled state seen in a fresh project; notify-check does not repeat it", async () => {
	const cwd = await project();
	await writeRun(cwd, {
		runId: "workflow_fresh",
		tasks: DONE,
		updatedAt: new Date().toISOString(),
		report: { specId: "render", verdict: "NEEDS_WORK" },
	});
	const runFile = join(
		cwd,
		".agent-workflow",
		"workflows",
		"workflow_fresh",
		"run.json",
	);
	const record = JSON.parse(await readFile(runFile, "utf8"));
	record.backend = { type: "local", mode: "headless" };
	await writeFile(runFile, JSON.stringify(record));
	assert.equal(existsSync(join(cwd, ".agent-workflow", "notify-check")), false);
	const waited = await runCli(cwd, ["wait", "workflow_fresh", "--json"], {
		now: undefined,
	});
	assert.equal(
		JSON.parse(waited.out).data?.terminal,
		true,
		waited.out + waited.err,
	);
	const receipts = await readdir(join(cwd, ".agent-workflow", "notify-check"));
	assert.ok(receipts.includes("baseline.json"));
	assert.ok(receipts.some((name) => name.startsWith("workflow_fresh.")));
	assert.equal(
		(await notify.notifyCheck(cwd, { host: "claude-code" })).text,
		"",
	);
	// A run the host never waited for is still announced.
	await writeRun(cwd, {
		runId: "workflow_other",
		tasks: DONE,
		updatedAt: new Date().toISOString(),
	});
	assert.match(
		(await notify.notifyCheck(cwd, { host: "claude-code" })).text,
		/workflow_other\) finished/,
	);
});
