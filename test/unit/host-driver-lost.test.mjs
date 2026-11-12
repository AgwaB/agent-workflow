// test-tier: integration
// A `running` run whose driver process is clearly dead (pid gone, heartbeat at least two minutes
// old, no live lock owner) becomes `interrupted` the next time anything reads it, with a reason
// that is not a user stop (`driver_lost`). The conversion runs under the run lease, keeps completed
// work, stops live workers and never touches a run a driver still holds. The dead driver is a
// launcher process that exited, as in host-stale-driver.test.mjs; clocks are aged on disk, never
// slept. The fixture executor makes no model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { eventually } from "../helpers/pi-host-fake.mjs";
import {
	readFixtureLog,
	WORKFLOW_EXECUTOR_FIXTURE_MODULE,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const run = promisify(execFile);
const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const driverLost = await import("../../dist/core/driver-lost.js");
const notices = await import("../../dist/hosts/unfinished-notice.js");
const notify = await import("../../dist/hosts/notify-check.js");
const slots = await import("../../dist/core/launch-slots.js");

const DIST = (path) =>
	fileURLToPath(new URL(`../../dist/${path}`, import.meta.url));

const TWO_STAGE = {
	schemaVersion: 1,
	name: "driver-lost",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{ id: "b", type: "single", prompt: "Summarize stage a.", from: "a" },
		],
	},
};

const SENTENCE =
	"Stopped: the process running it ended (its host was closed). Completed work is kept. Resume to continue.";

// The attached launcher: starts the run, exits once the first attempt consumed its launch
// authority. Its worker keeps going; nothing drives the run afterwards (a force-quit host).
const LAUNCHER = `
const [coreUrl, apiUrl, fixtureUrl, cwd, configJson] = process.argv.slice(2);
const { readFileSync } = await import("node:fs");
const core = await import(coreUrl);
const api = await import(apiUrl);
const { workflowFixtureDescriptor } = await import(fixtureUrl);
const config = JSON.parse(configJson);
core.registerWorkflowExecutor(workflowFixtureDescriptor(config));
const launched = await api.runWorkflowAction(
	{ cwd, env: process.env },
	{ workflow: "wf.json", task: config.task, executor: config.id },
);
process.stdout.write(JSON.stringify(launched.data));
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
	let text = "";
	try { text = readFileSync(config.effectLog, "utf8"); } catch {}
	if (text.includes('"type":"consume"')) break;
	await new Promise((done) => setTimeout(done, 10));
}
process.exit(0);
`;

let root;
let launcher;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-driver-lost-")));
	launcher = join(root, "launcher.mjs");
	await writeFile(launcher, LAUNCHER);
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	store.setRunLeaseTestHooksForTests();
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * An attached run whose launcher exited: running with work left and no live driver. `stepDelayMs`
 * keeps the first task's worker busy that long (a live worker to stop); the default lets it finish.
 */
async function orphanedRun({ stepDelayMs = 100, settle = true } = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(TWO_STAGE)}\n`);
	const config = {
		id: `test-driver-lost-${counter}`,
		effectLog: join(root, `lost-${counter}-effects.jsonl`),
		stepDelayMs,
	};
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor(config)),
	);
	const env = { ...process.env };
	const { stdout } = await run(
		process.execPath,
		[
			launcher,
			new URL(`file://${DIST("core/index.js")}`).href,
			new URL(`file://${DIST("hosts/api.js")}`).href,
			new URL(`file://${WORKFLOW_EXECUTOR_FIXTURE_MODULE}`).href,
			cwd,
			JSON.stringify({ ...config, task: `lost ${counter}` }),
		],
		{ cwd, env, timeout: 150_000 },
	);
	const launched = JSON.parse(stdout);
	assert.equal(launched.status, "running");
	const ctx = { cwd, env, host: "cli" };
	await eventually(
		() =>
			readFixtureLog(config.effectLog).some((entry) => entry.type === "submit"),
		"the first attempt submitted",
	);
	// The default step delay (100 ms) lets the first attempt run to its end in its worker.
	if (settle) await new Promise((done) => setTimeout(done, 3_000));
	assert.equal(await store.isWorkflowRunLeaseLive(cwd, launched.runId), false);
	return { cwd, env, ctx, runId: launched.runId, config };
}

const readRun = async (cwd, runId) =>
	JSON.parse(await readFile(store.workflowRunPath(cwd, runId), "utf8"));
const supervisorRecord = async (cwd, runId) =>
	JSON.parse(await readFile(store.supervisorPath(cwd, runId), "utf8"));

async function patchJson(path, patch) {
	const record = JSON.parse(await readFile(path, "utf8"));
	patch(record);
	await writeFile(path, `${JSON.stringify(record, null, "\t")}\n`);
}

/** Age the run record and the dead driver's heartbeat, as if the host quit `heartbeatMs` ago. */
async function age(cwd, runId, heartbeatMs) {
	await patchJson(store.workflowRunPath(cwd, runId), (record) => {
		record.createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
	});
	await patchJson(store.supervisorPath(cwd, runId), (record) => {
		record.updatedAt = new Date(Date.now() - heartbeatMs).toISOString();
	});
}

const THREE_MIN = 3 * 60_000;
const processAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};

test("a dead driver with a heartbeat of 2+ minutes: the next read interrupts the run, keeps completed work, with a distinct reason", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	await age(cwd, runId, THREE_MIN);
	const heartbeat = await supervisorRecord(cwd, runId);
	assert.equal((await readRun(cwd, runId)).status, "running");

	const status = await api.statusAction(ctx, { runId });
	assert.equal(status.data.run.status, "interrupted", status.text);
	assert.equal(status.data.run.statusDetail, "driver_lost");
	assert.equal(status.data.run.live, false);
	assert.ok(status.text.includes(SENTENCE), status.text);
	assert.doesNotMatch(status.text, /by user request|Stopped by you/);
	assert.ok(status.text.includes(`agent-workflow resume ${runId}`));

	const record = await readRun(cwd, runId);
	assert.equal(record.status, "interrupted");
	const [first, second] = record.tasks;
	// Work the worker finished while nobody was looking is kept, the rest is interrupted.
	assert.equal(first.status, "completed", JSON.stringify(first));
	assert.equal(second.status, "interrupted");
	assert.equal(second.statusDetail, "driver_lost");
	assert.match(second.lastMessage, /process running it ended/);
	// The conversion did not stamp a driver heartbeat over the evidence.
	assert.deepEqual(await supervisorRecord(cwd, runId), heartbeat);
	assert.equal(await store.readWorkflowStopIntent(cwd, runId), undefined);

	// Every reader shows the same, and a second read changes nothing.
	const shown = await api.showRunAction(ctx, { runId });
	assert.ok(shown.text.includes(SENTENCE), shown.text);
	const again = await readRun(cwd, runId);
	assert.equal(again.updatedAt, record.updatedAt);
	const list = await api.statusAction(ctx);
	assert.match(list.text, /interrupted/);
	assert.doesNotMatch(list.text, /no live driver/);
});

test("a live worker of the dead driver's run is stopped by the interruption", async () => {
	const { cwd, ctx, runId, config } = await orphanedRun({
		stepDelayMs: 25_000,
		settle: false,
	});
	await eventually(async () => {
		const task = (await readRun(cwd, runId)).tasks[0];
		return task.status === "running";
	}, "the first task running in its worker");
	const [submit] = readFixtureLog(config.effectLog).filter(
		(entry) => entry.type === "submit",
	);
	assert.ok(processAlive(submit.pid), "the worker process is alive");
	await age(cwd, runId, THREE_MIN);

	const snapshot = await api.statusAction(ctx, { runId, snapshot: true });
	assert.equal(snapshot.data.run.status, "interrupted", snapshot.text);
	const record = await readRun(cwd, runId);
	assert.equal(record.tasks[0].status, "interrupted");
	assert.equal(record.tasks[0].statusDetail, "driver_lost");
	assert.ok(
		readFixtureLog(config.effectLog).some((entry) => entry.type === "cancel"),
		"the worker attempt was cancelled",
	);
	await eventually(
		() => !processAlive(submit.pid),
		"the worker process is gone",
		15_000,
	);
});

test("a dead driver under two minutes: still running and shown as stalled", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	await age(cwd, runId, 100_000);
	const status = await api.statusAction(ctx, { runId });
	assert.equal(status.data.run.status, "running");
	assert.match(status.text, /⚠ stalled — no live driver/);
	assert.match(status.text, /last supervisor heartbeat 1m ago/);
	assert.equal(
		(await api.statusAction(ctx, { snapshot: true })).data.runs[0].status,
		"running",
	);
	assert.deepEqual(await driverLost.interruptDriverLostRuns(cwd), []);
	assert.equal((await readRun(cwd, runId)).status, "running");
	// The clock is the only difference: two minutes later the same run is lost.
	const later = await driverLost.interruptRunIfDriverLost(cwd, runId, {
		nowMs: Date.now() + 60_000,
	});
	assert.equal(later?.status, "interrupted");
});

test("a live driver, or a held lock, is never interrupted", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	await age(cwd, runId, 60 * 60_000);
	// A live pid in the heartbeat record, however old the heartbeat.
	await patchJson(store.supervisorPath(cwd, runId), (record) => {
		record.pid = process.pid;
	});
	const alive = await api.statusAction(ctx, { runId });
	assert.equal(alive.data.run.status, "running", alive.text);
	assert.equal((await readRun(cwd, runId)).status, "running");
	assert.deepEqual(await driverLost.interruptDriverLostRuns(cwd), []);

	// A dead pid but a live owner holding the run lock.
	await patchJson(store.supervisorPath(cwd, runId), (record) => {
		record.pid = 2 ** 22 + 12345;
	});
	assert.equal(
		(await store.assessRunDriverLost(cwd, runId)).lost,
		true,
		"without the lock the run is lost",
	);
	let release;
	const held = new Promise((done) => {
		release = done;
	});
	let inside;
	const entered = new Promise((done) => {
		inside = done;
	});
	const holder = store.withRunLease(cwd, runId, async () => {
		inside();
		await held;
	});
	await entered;
	try {
		assert.equal((await store.assessRunDriverLost(cwd, runId)).lost, false);
		assert.equal(
			await driverLost.interruptRunIfDriverLost(cwd, runId),
			undefined,
		);
		assert.equal((await readRun(cwd, runId)).status, "running");
	} finally {
		release();
		await holder;
	}
});

test("no driver record, a young run and a settled run are left alone", async () => {
	const { cwd, runId } = await orphanedRun();
	// Young run: past the heartbeat age but inside the 30 s launch grace.
	await age(cwd, runId, THREE_MIN);
	await patchJson(store.workflowRunPath(cwd, runId), (record) => {
		record.createdAt = new Date().toISOString();
	});
	assert.equal(
		await driverLost.interruptRunIfDriverLost(cwd, runId),
		undefined,
	);
	// No driver was ever recorded: nothing proves a dead driver.
	await patchJson(store.workflowRunPath(cwd, runId), (record) => {
		record.createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
	});
	await rm(store.supervisorPath(cwd, runId));
	assert.equal(
		await driverLost.interruptRunIfDriverLost(cwd, runId),
		undefined,
	);
	assert.equal((await readRun(cwd, runId)).status, "running");
});

test("a driver that returns between the pre-check and the lease is not overwritten", async () => {
	const { cwd, runId } = await orphanedRun();
	await age(cwd, runId, THREE_MIN);
	// As our lease starts, a driver comes back: it has refreshed supervisor.json with its live pid.
	store.setRunLeaseTestHooksForTests({
		onBeforeHeartbeat: async ({ initial }) => {
			if (!initial) return;
			store.setRunLeaseTestHooksForTests();
			await patchJson(store.supervisorPath(cwd, runId), (record) => {
				record.pid = process.pid;
				record.updatedAt = new Date().toISOString();
			});
		},
	});
	try {
		assert.equal(
			await driverLost.interruptRunIfDriverLost(cwd, runId),
			undefined,
		);
	} finally {
		store.setRunLeaseTestHooksForTests();
	}
	const record = await readRun(cwd, runId);
	assert.equal(record.status, "running");
	assert.ok(record.tasks.every((task) => task.status !== "interrupted"));
});

test("after the conversion `resume` is accepted directly, and so it is without any earlier read", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	await age(cwd, runId, THREE_MIN);
	// No read before: resume itself interrupts the dead run first, then resumes it.
	const resumed = await api.resumeAction(ctx, { runId });
	assert.notEqual(resumed.outcome, "failure", resumed.text);
	assert.match(resumed.text, /resumed|Reset|scheduled/i);
	const waited = await api.waitAction(ctx, { runId, timeoutMs: 30_000 });
	assert.equal(waited.data.status, "completed", waited.text);

	// Read first, then resume: the same one step.
	const second = await orphanedRun();
	await age(second.cwd, second.runId, THREE_MIN);
	const read = await api.statusAction(second.ctx, { runId: second.runId });
	assert.equal(read.data.run.status, "interrupted");
	const again = await api.resumeAction(second.ctx, { runId: second.runId });
	assert.notEqual(again.outcome, "failure", again.text);
	const done = await api.waitAction(second.ctx, {
		runId: second.runId,
		timeoutMs: 30_000,
	});
	assert.equal(done.data.status, "completed", done.text);
});

test("the unfinished-run reminder and notify-check list the converted run", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	// A first check sets the notify baseline, as in a real project.
	await notify.notifyCheck(cwd, { host: "claude-code" });
	await age(cwd, runId, THREE_MIN);
	const reminder = await notices.unfinishedRunReminder(api, ctx, Date.now());
	assert.ok(reminder, "a reminder is given");
	assert.ok(reminder.includes(runId), reminder);
	assert.match(reminder, /interrupted/);
	assert.equal((await readRun(cwd, runId)).status, "interrupted");
	assert.equal(
		(await readRun(cwd, runId)).tasks[1].statusDetail,
		"driver_lost",
	);

	// notify-check is a reader too: a second dead run is interrupted and reported by the check.
	const other = await orphanedRun();
	await notify.notifyCheck(other.cwd, { host: "claude-code" });
	await age(other.cwd, other.runId, THREE_MIN);
	const checked = await notify.notifyCheck(other.cwd, { host: "claude-code" });
	assert.equal(checked.data.notifications.length, 1, checked.text);
	assert.equal(checked.data.notifications[0].runId, other.runId);
	assert.equal((await readRun(other.cwd, other.runId)).status, "interrupted");
});

test("dashboard snapshot reads convert too, and project the reason", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	await age(cwd, runId, THREE_MIN);
	const source = (
		await import("../../dist/hosts/dashboard/source.js")
	).hostApiDashboardSource(ctx);
	const [summary] = await source.listRuns();
	assert.equal(summary.runId, runId);
	assert.equal(summary.status, "interrupted");
	assert.equal(summary.statusDetail, "driver_lost");
});
