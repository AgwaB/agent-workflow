// New in agent-workflow (WP34 item 1, owner decision Q1, parity row 22): the `/aw` board, a port of
// pi-workflow src/workflow-view.ts (runs → stages → tasks → task detail, `r`, `v`, `c`, q/Esc, the
// h/j/k/l, arrow, Enter, b and [/]/n/p keys) whose reads and actions go through the host API.
// Part 1 drives the component over a fake source (navigation, per-task executor/model/effort of a
// mixed run, verdict, report path, pending approvals, the launch viewer and copy, stop/resume/approve
// confirmed in the board). Part 2 drives `/aw` through the Pi host with a fake Pi TUI (`ctx.ui.custom`)
// and runs on the workflow executor fixture (no model or agent-CLI calls): the board opens only in
// the TUI, `/aw <run>` opens the run's stages, every read is a host API call, print/JSON/RPC keep the
// text behavior.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const realApi = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const { AwBoard } = await import("../../dist/hosts/pi/board.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

const ESC = "\u001b";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ENTER = "\r";

// --- part 1: the component over a fake source --------------------------------------------------

const T0 = "2026-10-28T10:00:00.000Z";

function summary(over = {}) {
	return {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
		...over,
	};
}

function task(taskId, stageId, status, runtime = {}) {
	return {
		taskId,
		specId: taskId,
		displayName: taskId,
		agent: "reader",
		stageId,
		status,
		statusDetail: status,
		runtime: { approvalMode: "never", ...runtime },
		files: {},
	};
}

function mixedRun() {
	const tasks = [
		task("plan", "plan", "completed", {
			executor: "claude",
			model: "sonnet",
			thinking: "high",
		}),
		task("worker-1", "work", "completed", {
			executor: "codex",
			model: "gpt-5.6-luna",
			thinking: "medium",
		}),
		task("worker-2", "work", "failed", {
			executor: "codex",
			model: "gpt-5.6-luna",
			thinking: "medium",
		}),
	];
	const record = {
		runId: "workflow_mixed_1",
		name: "mixed-review",
		type: "artifact-graph",
		status: "blocked",
		createdAt: T0,
		updatedAt: T0,
		taskSummary: summary({ completed: 2, failed: 1, total: 3 }),
		tasks,
	};
	const run = {
		runId: record.runId,
		name: record.name,
		type: record.type,
		status: "blocked",
		createdAt: T0,
		updatedAt: T0,
		executor: "claude",
		executors: ["claude", "codex"],
		taskSummary: record.taskSummary,
		verdict: "NEEDS_WORK",
		reportArtifacts: [
			{ kind: "final-report", label: "Final report", path: "reports/final.md" },
		],
		pendingApprovals: [
			{
				requestId: "req-abcdef0123456789",
				controllerSpecId: "dyn.controller",
				taskId: "worker-2",
				title: "Run dynamic workflow controller?",
				message: "Scope: plan the follow-up review.",
				requestedAt: T0,
			},
		],
		tasks: tasks.map((entry) => ({
			taskId: entry.taskId,
			specId: entry.specId,
			status: entry.status,
			statusDetail: entry.status,
			executor: entry.runtime.executor,
			model: entry.runtime.model,
			effort: entry.runtime.thinking,
		})),
	};
	return { run, record };
}

const EXACT_COMMAND =
	'/aw run review "line one\nline two\t\u001b]0;owned\u0007"';

function fakeSource({ launch = true } = {}) {
	const { run, record } = mixedRun();
	const other = {
		runId: "workflow_other_2",
		name: "other",
		type: "artifact-graph",
		status: "completed",
		createdAt: T0,
		updatedAt: T0,
		taskSummary: summary({ completed: 1, total: 1 }),
	};
	const calls = [];
	const copied = [];
	const source = {
		calls,
		copied,
		copyFails: false,
		async listRuns() {
			calls.push(["listRuns"]);
			return [run, other];
		},
		async runDetail(runId) {
			calls.push(["runDetail", runId]);
			if (runId === other.runId)
				return {
					run: { ...other, reportArtifacts: [], tasks: [] },
					record: { ...other, tasks: [] },
				};
			return {
				run,
				record,
				...(launch
					? {
							launch: {
								schema: "agent-workflow-run-launch-v1",
								source: "pi",
								entry: "command run",
								requestKind: "named-workflow",
								profile: "profile mixed",
								task: { characters: 18, lines: 2 },
								command: {
									state: "captured",
									fidelity: "exact",
									bytes: 40,
									text: EXACT_COMMAND,
								},
							},
						}
					: {}),
			};
		},
		async taskLogs(runId, taskId) {
			calls.push(["taskLogs", runId, taskId]);
			return {
				taskId,
				specId: taskId,
				status: "failed",
				statusDetail: "failed",
				streams: [
					{
						kind: "output",
						path: `.agent-workflow/x/${taskId}.out`,
						lines: ["out line 1", "out line 2"],
						truncated: false,
					},
					{ kind: "stderr", path: "err", lines: ["boom"], truncated: false },
					{ kind: "events", path: "ev", lines: [], truncated: false },
				],
			};
		},
		async stop(runId) {
			calls.push(["stop", runId]);
			return { text: `Stopped ${runId}.\nmore`, level: "info" };
		},
		async resume(runId) {
			calls.push(["resume", runId]);
			return { text: `Resumed ${runId}.`, level: "info" };
		},
		async approve(runId, requestId, decision) {
			calls.push(["approve", runId, requestId, decision]);
			return {
				text: `${decision === "approve" ? "approved" : "rejected"} ${requestId}`,
				level: "info",
			};
		},
		async copy(text) {
			if (source.copyFails) throw new Error("clipboard failure");
			copied.push(text);
		},
	};
	return source;
}

async function board(options = {}, sourceOptions = {}) {
	const source = fakeSource(sourceOptions);
	const renders = [];
	let closed = 0;
	const view = new AwBoard(
		source,
		{ requestRender: (force) => renders.push(force === true) },
		{},
		() => {
			closed += 1;
		},
		{ refreshMs: 0, now: () => Date.parse(T0) + 65_000, ...options },
	);
	await view.start();
	return {
		view,
		source,
		renders,
		closed: () => closed,
		text: (width = 120) => view.render(width).join("\n"),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("board lists runs and drills runs → stages → tasks → task detail and back", async () => {
	const b = await board();
	assert.equal(b.view.mode, "runs");
	let text = b.text();
	assert.match(text, /agent-workflow board/);
	assert.match(text, /› ◆ mixed-review/);
	assert.match(text, /BLOCKED/);
	assert.match(text, /claude\+codex/, "mixed executors of the run");
	assert.match(text, /✓ other/);
	assert.match(text, /verdict: NEEDS_WORK/);
	assert.match(text, /Pending approval/);
	// Every rendered line fits the width.
	for (const width of [60, 100, 140])
		for (const line of b.view.render(width))
			assert.ok([...line].length <= width, `line fits ${width}`); // plain theme: no ANSI

	b.view.handleInput(ENTER);
	assert.equal(b.view.mode, "stages");
	text = b.text();
	assert.match(text, /Stages/);
	assert.match(text, /plan/);
	assert.match(text, /work/);
	assert.match(text, /final report: reports\/final\.md/);
	assert.match(text, /dyn\.controller/);
	assert.match(text, /source: pi · command run/);

	b.view.handleInput("j"); // stage "work"
	b.view.handleInput(RIGHT);
	assert.equal(b.view.mode, "tasks");
	text = b.text();
	assert.match(text, /work tasks/);
	// Problem tasks first, with each task's executor/model/effort (WP31 mixed run).
	assert.match(text, /› ✕ worker-2[^\n]*failed · codex gpt-5\.6-luna medium/);
	assert.match(text, /worker-1[^\n]*done · codex gpt-5\.6-luna medium/);

	b.view.handleInput("l");
	assert.equal(b.view.mode, "task");
	await eventually(() => b.view.logs !== undefined, "task logs");
	text = b.text();
	assert.match(text, /executor: codex · model: gpt-5\.6-luna · effort: medium/);
	assert.match(text, /run verdict: NEEDS_WORK/);
	assert.match(text, /\[output\]/);
	assert.match(text, /out line 2/);
	assert.match(text, /\/aw logs workflow_mixed_1 --task worker-2/);
	assert.deepEqual(b.source.calls.at(-1), [
		"taskLogs",
		"workflow_mixed_1",
		"worker-2",
	]);
	b.view.handleInput(RIGHT);
	assert.match(b.text(), /\[stderr\][\s\S]*boom/);
	b.view.handleInput("]"); // sibling task
	assert.equal(b.view.currentTask().taskId, "worker-1");

	b.view.handleInput(ESC);
	assert.equal(b.view.mode, "tasks");
	b.view.handleInput("b");
	assert.equal(b.view.mode, "stages");
	b.view.handleInput(LEFT);
	assert.equal(b.view.mode, "runs");
	b.view.handleInput(DOWN);
	await eventually(
		() => b.view.detail?.run.runId === "workflow_other_2",
		"second run's detail",
	);
	assert.match(b.text(), /› ✓ other/);
	b.view.handleInput(ESC);
	assert.equal(b.closed(), 1, "Esc on the run list closes");
	assert.equal(b.renders.at(-1), true, "closing forces a full repaint");
});

test("r refreshes through the source; q closes from any mode", async () => {
	const b = await board();
	const before = b.source.calls.filter(([name]) => name === "listRuns").length;
	b.view.handleInput("r");
	await eventually(() => b.view.message === "refreshed", "refreshed");
	assert.equal(
		b.source.calls.filter(([name]) => name === "listRuns").length,
		before + 1,
	);
	b.view.handleInput(ENTER);
	b.view.handleInput("q");
	assert.equal(b.closed(), 1);
});

test("initialRunId opens the run's stages (/aw <run>)", async () => {
	const b = await board({ initialRunId: "workflow_other" });
	assert.equal(b.view.mode, "stages");
	assert.equal(b.view.selectedRunSummary().runId, "workflow_other_2");
});

test("v opens the launch viewer with escaped controls; c copies the exact text", async () => {
	const b = await board();
	assert.equal(b.text().includes("line one"), false, "never previewed");
	b.view.handleInput("v");
	assert.equal(b.view.launchOpen, true);
	const text = b.text(100);
	assert.match(text, /Launch command/);
	assert.match(text, /Redacted at capture · control characters escaped/);
	assert.match(text, /\\n/);
	assert.match(text, /\\t/);
	assert.match(text, /\\u001b/);
	assert.equal(text.includes("\u001b]0;owned"), false);
	b.view.handleInput("c");
	await eventually(() => b.view.message === "Launch command copied", "copied");
	assert.deepEqual(b.source.copied, [EXACT_COMMAND]);
	b.source.copyFails = true;
	b.view.handleInput("c");
	await eventually(
		() => b.view.message === "Launch command copy failed",
		"copy failure",
	);
	b.view.handleInput("b");
	assert.equal(b.view.launchOpen, false);
	// `c` on the board copies without opening the viewer.
	b.source.copyFails = false;
	b.view.handleInput("c");
	await eventually(() => b.source.copied.length === 2, "copied from board");
	assert.equal(b.view.launchOpen, false);
});

test("a run without launch capture says so for v and c", async () => {
	const b = await board({}, { launch: false });
	b.view.handleInput("v");
	assert.equal(b.view.launchOpen, false);
	assert.equal(b.view.message, "launch command unavailable: not captured");
	b.view.handleInput("c");
	await settle();
	assert.deepEqual(b.source.copied, []);
});

test("s, u and a ask in the board before stop, resume and approve/reject", async () => {
	const b = await board();
	b.view.handleInput("s");
	assert.equal(b.view.prompt.kind, "stop");
	assert.match(b.text(), /Stop run\?[\s\S]*y yes · n no · Esc cancel/);
	b.view.handleInput("n");
	assert.equal(b.view.prompt, undefined);
	assert.equal(b.view.message, "cancelled");
	assert.equal(
		b.source.calls.some(([name]) => name === "stop"),
		false,
	);

	b.view.handleInput("s");
	b.view.handleInput("y");
	await eventually(
		() => !b.view.busy && /^Stopped/.test(b.view.message),
		"stop",
	);
	assert.deepEqual(
		b.source.calls.find(([name]) => name === "stop"),
		["stop", "workflow_mixed_1"],
	);
	assert.equal(b.view.message, "Stopped workflow_mixed_1.", "first line");

	b.view.handleInput("u");
	b.view.handleInput(ESC);
	assert.equal(
		b.source.calls.some(([name]) => name === "resume"),
		false,
	);
	b.view.handleInput("u");
	b.view.handleInput("y");
	await eventually(() => /^Resumed/.test(b.view.message), "resume");

	b.view.handleInput("a");
	assert.equal(b.view.prompt.kind, "approve");
	const prompt = b.text();
	assert.match(prompt, /Run dynamic workflow controller\?/);
	assert.match(prompt, /Scope: plan the follow-up review\./);
	assert.match(prompt, /y approve · x reject/);
	b.view.handleInput("y");
	await eventually(() => /^approved/.test(b.view.message), "approve");
	b.view.handleInput("a");
	b.view.handleInput("x");
	await eventually(() => /^rejected/.test(b.view.message), "reject");
	assert.deepEqual(
		b.source.calls.filter(([name]) => name === "approve"),
		[
			["approve", "workflow_mixed_1", "req-abcdef0123456789", "approve"],
			["approve", "workflow_mixed_1", "req-abcdef0123456789", "reject"],
		],
	);

	// The completed run: nothing to stop, resume or approve.
	b.view.handleInput(DOWN);
	await eventually(
		() => b.view.detail?.run.runId === "workflow_other_2",
		"second run",
	);
	b.view.handleInput("s");
	assert.equal(b.view.message, "stop: run is completed");
	b.view.handleInput("u");
	assert.equal(b.view.message, "resume: run is completed");
	b.view.handleInput("a");
	assert.equal(b.view.message, "approve: no pending approval");
	assert.equal(b.view.prompt, undefined);
});

// --- part 2: /aw through the Pi host -----------------------------------------------------------

let root;
let counter = 0;
const unregister = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp34-board",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp34-board-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const { pi } of instances)
		for (const handler of pi.handlers.get("session_shutdown") ?? [])
			await handler({}, undefined);
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project(stepDelayMs = 50) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp34-board-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				stepDelayMs,
				effectLog: join(root, `${id}-effects.jsonl`),
			}),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	return { cwd, env, executor: id };
}

function install(env) {
	const pi = fakePi();
	const calls = [];
	const api = {};
	for (const [name, value] of Object.entries(realApi)) {
		if (
			typeof value !== "function" ||
			!/Action$|^registerTestExecutorFromEnv$/.test(name)
		)
			continue;
		api[name] = (...args) => {
			calls.push(name);
			return value(...args);
		};
	}
	ext.createAgentWorkflowPiExtension({ env, api, feedbackPollMs: 50 })(pi);
	instances.push({ pi });
	return { pi, calls, command: pi.commands.get("aw") };
}

async function finishedRun(command, cwd, env, executor) {
	const ctx = fakeCtx(cwd, { hasUI: false });
	const write = process.stdout.write;
	process.stdout.write = () => true;
	try {
		await command.handler(
			`run wf.json "board task" --executor ${executor}`,
			ctx,
		);
		const runId = (await realApi.statusAction({ cwd, env })).data.runs[0].runId;
		await command.handler(`wait ${runId} 60s`, ctx);
		return runId;
	} finally {
		process.stdout.write = write;
	}
}

test("/aw in the TUI opens the board over host API reads; q resolves the command", async () => {
	const { cwd, env, executor } = await project();
	const { command, calls } = install(env);
	const runId = await finishedRun(command, cwd, env, executor);
	const ctx = fakeCtx(cwd, { mode: "tui", custom: true });
	calls.length = 0;
	const open = command.handler("", ctx);
	await eventually(() => ctx.customs.length === 1, "the board");
	const view = ctx.customs[0];
	assert.ok(view instanceof AwBoard);
	await eventually(() => view.detail?.run.runId === runId, "run detail");
	let text = view.render(120).join("\n");
	assert.match(text, /wp34-board/);
	assert.match(text, /COMPLETED/);
	assert.match(text, /source: pi · command run/);
	view.handleInput("v");
	assert.match(
		view.render(120).join("\n"),
		new RegExp(`/aw run wf\\.json "board task" --executor ${executor}`),
		"the WP33 launch capture",
	);
	view.handleInput("b");
	view.handleInput(ENTER);
	view.handleInput(ENTER);
	view.handleInput(ENTER);
	assert.equal(view.mode, "task");
	await eventually(() => view.logs !== undefined, "logs");
	text = view.render(120).join("\n");
	assert.match(text, new RegExp(`executor: ${executor}`));
	assert.match(text, /\[output\]/);
	// Reads are host API calls only.
	assert.deepEqual([...new Set(calls)].sort(), [
		"logsAction",
		"showAction",
		"statusAction",
	]);
	view.handleInput("q");
	await open;
	assert.equal(ctx.notes.length, 0, "no text output");
	assert.equal(ctx.renders.at(-1), true);
});

test("/aw <run prefix> opens the run's stages; an unknown token stays an unknown action", async () => {
	const { cwd, env, executor } = await project();
	const { command } = install(env);
	const runId = await finishedRun(command, cwd, env, executor);
	const ctx = fakeCtx(cwd, { mode: "tui", custom: true });
	const open = command.handler(runId.slice(0, 20), ctx);
	await eventually(() => ctx.customs.length === 1, "the board");
	const view = ctx.customs[0];
	await eventually(() => view.detail?.run.runId === runId, "run detail");
	assert.equal(view.mode, "stages");
	view.handleInput("q");
	await open;
	await command.handler("nonsense", ctx);
	assert.equal(ctx.customs.length, 1, "no board for an unknown token");
	assert.match(ctx.notes.at(-1).message, /Unknown \/aw action "nonsense"/);
	// An action name is the action, not a run.
	await command.handler("help", ctx);
	assert.match(ctx.notes.at(-1).message, /^\/aw — agent-workflow in Pi/);
	assert.equal(ctx.customs.length, 1);
});

test("s and u in the board stop and resume a real run through the host API (resume is tracked)", async () => {
	const { cwd, env, executor } = await project(3_000);
	const { pi, command, calls } = install(env);
	const ctx = fakeCtx(cwd, { mode: "tui", custom: true });
	await command.handler(
		`run wf.json "long task" --executor ${executor}`,
		fakeCtx(cwd, { mode: "rpc" }),
	);
	const runId = (await realApi.statusAction({ cwd, env })).data.runs[0].runId;
	const open = command.handler(runId, ctx);
	await eventually(() => ctx.customs.length === 1, "the board");
	const view = ctx.customs[0];
	await eventually(() => view.detail?.run.status === "running", "running run");
	view.handleInput("s");
	view.handleInput("y");
	await eventually(
		() => !view.busy && view.detail?.run.status === "interrupted",
		"stopped",
	);
	assert.ok(calls.includes("stopAction"));
	const statusesBeforeResume = ctx.statuses.length;
	const messagesBeforeResume = pi.messages.length;
	// Tracked like `/aw resume`: the status line shows the run while it runs, and its completion is
	// delivered when it settles (under load the resumed run can finish before the first status tick).
	const tracked = () =>
		ctx.statuses
			.slice(statusesBeforeResume)
			.some(
				(entry) =>
					entry.key === "agent-workflow" &&
					entry.text?.startsWith("aw: wp34-board"),
			) ||
		pi.messages
			.slice(messagesBeforeResume)
			.some(
				(entry) =>
					entry.message?.customType === "agent-workflow-completion" &&
					JSON.stringify(entry.message).includes(runId),
			);
	// Under load the stopped run's supervisor can still hold its lease after the 10 s resume
	// wait (WP37): resume then refuses with "still shutting down; try again", and the user presses
	// `u` again. Any other refusal fails the test with its message.
	for (let attempt = 0; ; attempt += 1) {
		const resumesBefore = calls.filter(
			(name) => name === "resumeAction",
		).length;
		view.handleInput("u");
		view.handleInput("y");
		await eventually(
			() =>
				calls.filter((name) => name === "resumeAction").length >
					resumesBefore && !view.busy,
			"resumed",
		);
		if (/shutting down|try again/i.test(view.message ?? "") && attempt < 3) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			continue;
		}
		break;
	}
	await eventually(
		() => tracked(),
		`the resumed run is tracked (status line or completion message); board message: ${view.message}`,
	);
	view.handleInput("q");
	await open;
});

test("RPC and print/JSON modes keep the text behavior of /aw and /aw <run>", async () => {
	const { cwd, env, executor } = await project();
	const { command } = install(env);
	const runId = await finishedRun(command, cwd, env, executor);
	const rpc = fakeCtx(cwd, { mode: "rpc", custom: true });
	await command.handler("", rpc);
	assert.equal(rpc.customs.length, 0);
	assert.match(rpc.notes.at(-1).message, /^\/aw — agent-workflow in Pi/);
	assert.match(
		rpc.notes.at(-1).message,
		/\/aw \[<run>\]\s+open the run board \(TUI only/,
	);
	await command.handler(runId, rpc);
	assert.equal(rpc.customs.length, 0);
	assert.equal(rpc.notes.at(-1).type, "error");
	assert.match(rpc.notes.at(-1).message, /Unknown \/aw action/);
	const json = fakeCtx(cwd, { hasUI: false, custom: true });
	const out = [];
	const write = process.stdout.write;
	process.stdout.write = (chunk) => {
		out.push(String(chunk));
		return true;
	};
	try {
		await command.handler("", json);
	} finally {
		process.stdout.write = write;
	}
	assert.equal(json.customs.length, 0);
	assert.match(out.join(""), /^\/aw — agent-workflow in Pi/);
});
