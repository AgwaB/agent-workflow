// New in agent-workflow (WP33 item 2, parity row 23): the active-workflows widget and the
// cancellable foreground loader (port of pi-workflow src/workflow-active-ui.ts). The widget lists
// the runs this session tracks with their progress, next to the WP16 footer entry (kept), and is
// cleared when none is active; print/JSON mode shows nothing. `/aw wait` runs behind a cancellable
// loader in the TUI; cancelling cancels only the wait (WP28), the run continues. Runs use the
// workflow executor fixture (no model or agent-CLI calls); the loader is a fake component.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const ui = await import("../../dist/hosts/pi/active-ui.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const instances = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp33-active",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp33-active-ui-")));
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

async function project(stepDelayMs = 800) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	const id = `test-wp33-ui-${counter}`;
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

/** A fake Pi BorderedLoader: `cancel()` is the user pressing Escape. */
function fakeLoaders() {
	const created = [];
	const factory = async () => (_tui, _theme, label) => {
		const controller = new AbortController();
		const loader = {
			label,
			get signal() {
				return controller.signal;
			},
			onAbort: undefined,
			cancel() {
				controller.abort();
				loader.onAbort?.();
			},
		};
		created.push(loader);
		return loader;
	};
	return { created, factory };
}

function install(env, options = {}) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50, ...options })(
		pi,
	);
	instances.push({ pi });
	return { pi, command: pi.commands.get("aw") };
}

test("formatActiveWorkflowLines: progress, elapsed time, truncation and overflow", () => {
	const now = Date.parse("2026-10-28T10:00:00.000Z");
	const run = (index, extra = {}) => ({
		runId: `workflow_${index}`,
		name: `run-${index}`,
		status: "running",
		createdAt: "2026-10-28T09:58:30.000Z",
		taskSummary: { total: 4, completed: 1, running: 2, failed: 0 },
		...extra,
	});
	assert.deepEqual(ui.formatActiveWorkflowLines([], now), []);
	assert.deepEqual(ui.formatActiveWorkflowLines([run(1)], now), [
		"Active workflows",
		"● run-1 3/4 running · 1m",
	]);
	const long = run(2, { name: "x".repeat(40), createdAt: "bad" });
	assert.equal(
		ui.formatActiveWorkflowLines([long], now)[1],
		`● ${"x".repeat(27)}… 3/4 running`,
	);
	const lines = ui.formatActiveWorkflowLines(
		[1, 2, 3, 4, 5, 6, 7].map((index) => run(index)),
		now,
	);
	assert.equal(lines.length, 7);
	assert.equal(lines.at(-1), "… and 2 more");
});

test("widget lists this session's active runs with progress, keeps the footer entry and clears when done", async () => {
	// WP38 load margin: both runs must still be active when the second launch returns; with the
	// default 800 ms steps the first run could finish first on a loaded machine (load average 20+).
	const { cwd, env, executor } = await project(3_000);
	const { command } = install(env);
	const ctx = fakeCtx(cwd);
	await command.handler(`run wf.json "first" --executor ${executor}`, ctx);
	await command.handler(`run wf.json "second" --executor ${executor}`, ctx);
	// Another session's run in the same project is not listed.
	const other = install(env);
	await other.command.handler(
		`run wf.json "foreign" --executor ${executor}`,
		fakeCtx(cwd, { sessionId: "session-b" }),
	);
	await eventually(
		() => (ctx.widgets.get("agent-workflow-active") ?? []).length === 3,
		"two active runs in the widget",
	);
	const lines = ctx.widgets.get("agent-workflow-active");
	assert.equal(lines[0], "Active workflows");
	for (const line of lines.slice(1))
		assert.match(line, /^● wp33-active [01]\/1 (running|pending) · \d+s$/);
	const call = ctx.widgetCalls.find((entry) => entry.lines !== undefined);
	assert.deepEqual(call.options, { placement: "belowEditor" });
	assert.match(
		ctx.footer.get("agent-workflow"),
		/^aw: wp33-active \d\/1 running \+1 more$/,
	);
	await eventually(
		() =>
			!ctx.widgets.has("agent-workflow-active") &&
			!ctx.footer.has("agent-workflow"),
		"widget and footer cleared",
	);
	assert.equal(ctx.widgetCalls.at(-1).lines, undefined);
});

test("print/JSON mode shows no widget, no status and no loader", async () => {
	const { cwd, env, executor } = await project(100);
	const loaders = fakeLoaders();
	const { command } = install(env, { foregroundLoader: loaders.factory });
	const ctx = fakeCtx(cwd, { hasUI: false, custom: true });
	const write = process.stdout.write;
	process.stdout.write = () => true;
	try {
		await command.handler(`run wf.json "headless" --executor ${executor}`, ctx);
		const runId = (await api.statusAction({ cwd, env })).data.runs[0].runId;
		await command.handler(`wait ${runId} 60s`, ctx);
	} finally {
		process.stdout.write = write;
	}
	assert.equal(ctx.widgetCalls.length, 0);
	assert.equal(ctx.statuses.length, 0);
	assert.equal(ctx.customs.length, 0);
	assert.equal(loaders.created.length, 0);
});

test("/aw wait in the TUI runs behind a loader; Escape cancels only the wait", async () => {
	const { cwd, env, executor } = await project(1_500);
	const loaders = fakeLoaders();
	const { command } = install(env, { foregroundLoader: loaders.factory });
	const ctx = fakeCtx(cwd, { mode: "tui", custom: true });
	await command.handler(`run wf.json "loader" --executor ${executor}`, ctx);
	const runId = (await api.statusAction({ cwd, env })).data.runs[0].runId;
	const waiting = command.handler(`wait ${runId} 2m`, ctx);
	await eventually(() => loaders.created.length === 1, "the loader");
	assert.match(loaders.created[0].label, new RegExp(`^Waiting for ${runId}`));
	assert.equal(ctx.customs.length, 1);
	loaders.created[0].cancel();
	await waiting;
	assert.match(
		ctx.notes.at(-1).message,
		/^Stopped waiting for .*; the run continues/,
	);
	assert.equal(ctx.notes.at(-1).type, "info");
	assert.equal(
		(await api.statusAction({ cwd, env }, { runId })).data.run.status,
		"running",
		"the run continues",
	);
	// Not cancelled: the loader closes with the wait result.
	await command.handler(`wait ${runId} 2m`, ctx);
	assert.equal(loaders.created.length, 2);
	assert.match(ctx.notes.at(-1).message, /task-1 done/, "the wait result");
	assert.equal(
		(await api.statusAction({ cwd, env }, { runId })).data.run.status,
		"completed",
	);
});

test("RPC mode (no TUI) waits without a loader", async () => {
	const { cwd, env, executor } = await project(100);
	const loaders = fakeLoaders();
	const { command } = install(env, { foregroundLoader: loaders.factory });
	const ctx = fakeCtx(cwd, { mode: "rpc", custom: true });
	await command.handler(`run wf.json "rpc" --executor ${executor}`, ctx);
	const runId = (await api.statusAction({ cwd, env })).data.runs[0].runId;
	await command.handler(`wait ${runId} 60s`, ctx);
	assert.equal(loaders.created.length, 0);
	assert.equal(ctx.customs.length, 0);
	assert.match(ctx.notes.at(-1).message, /task-1 done/, "the wait result");
});
