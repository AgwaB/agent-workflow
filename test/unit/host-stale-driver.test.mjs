// test-tier: integration
// A run whose driver died (attached launcher gone) must not read as healthy `running`: status,
// show, the run list and the dashboard say it has no live driver, and a read never refreshes the
// driver heartbeat. Negative cases: a driven run, a just-launched run and a settled run stay
// unflagged. The fixture executor makes no model calls.
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
const format = await import("../../dist/core/engine-format.js");
const slots = await import("../../dist/core/launch-slots.js");

const DIST = (path) =>
	fileURLToPath(new URL(`../../dist/${path}`, import.meta.url));

const TWO_STAGE = {
	schemaVersion: 1,
	name: "stale-driver",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{ id: "b", type: "single", prompt: "Summarize stage a.", from: "a" },
		],
	},
};

// The attached launcher: starts the run, exits after the first attempt consumed its launch
// authority. Its worker keeps going; nothing drives the run afterwards (the Pi-session-quit case).
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
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-stale-driver-")));
	launcher = join(root, "launcher.mjs");
	await writeFile(launcher, LAUNCHER);
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** An attached run whose launcher process exited: running, pending work, no live driver. */
async function orphanedRun() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(TWO_STAGE)}\n`);
	const config = {
		id: `test-stale-driver-${counter}`,
		effectLog: join(root, `stale-${counter}-effects.jsonl`),
		stepDelayMs: 400,
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
			JSON.stringify({ ...config, task: `orphan ${counter}` }),
		],
		{ cwd, env, timeout: 150_000 },
	);
	const launched = JSON.parse(stdout);
	assert.equal(launched.status, "running");
	const ctx = { cwd, env, host: "cli" };
	// The first task finishes in its worker; the second never starts without a driver.
	await eventually(
		() =>
			readFixtureLog(config.effectLog).some((entry) => entry.type === "submit"),
		"the first attempt submitted",
	);
	await new Promise((done) => setTimeout(done, 1_500));
	return { cwd, env, ctx, runId: launched.runId, config };
}

/** Age the run record, as if it had been started long ago. */
async function ageRun(cwd, runId, ms = 10 * 60_000) {
	const path = store.workflowRunPath(cwd, runId);
	const record = JSON.parse(await readFile(path, "utf8"));
	record.createdAt = new Date(Date.now() - ms).toISOString();
	await writeFile(path, `${JSON.stringify(record, null, "\t")}\n`);
}

/** The dead driver's last heartbeat is old, as it is when a run was abandoned a while ago. */
async function ageHeartbeat(cwd, runId, ms = 53 * 60_000) {
	const path = store.supervisorPath(cwd, runId);
	const record = JSON.parse(await readFile(path, "utf8"));
	record.updatedAt = new Date(Date.now() - ms).toISOString();
	await writeFile(path, `${JSON.stringify(record, null, "\t")}\n`);
}

const supervisorRecord = async (cwd, runId) =>
	JSON.parse(await readFile(store.supervisorPath(cwd, runId), "utf8"));

test("a run whose driver died is presented as stalled by status, show, raw and the list", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	assert.equal(await store.isWorkflowRunLeaseLive(cwd, runId), false);
	await ageHeartbeat(cwd, runId);
	const before = await supervisorRecord(cwd, runId);
	assert.ok(before.pid !== process.pid, "the launcher's pid, not this process");
	await ageRun(cwd, runId);

	// Persisted-state read (what the dashboard uses).
	const snapshot = await api.statusAction(ctx, { runId, snapshot: true });
	assert.equal(snapshot.data.run.status, "running");
	assert.equal(snapshot.data.run.live, false);
	assert.match(
		snapshot.text,
		/Status: running — no live driver, not progressing/,
	);
	assert.match(snapshot.text, /⚠ stalled — no live driver/);
	assert.ok(
		snapshot.text.includes(`agent-workflow wait ${runId}`),
		snapshot.text,
	);

	// Refreshing read: must not read as driven because it refreshed the run itself.
	const status = await api.statusAction(ctx, { runId });
	assert.equal(status.data.run.status, "running");
	assert.equal(status.data.run.live, false, status.text);
	assert.match(status.text, /⚠ stalled — no live driver/);
	assert.match(status.text, /last supervisor heartbeat 5\dm ago/);
	// The reader left the driver's heartbeat alone (pid and time of the dead launcher).
	assert.deepEqual(
		{
			pid: (await supervisorRecord(cwd, runId)).pid,
			updatedAt: (await supervisorRecord(cwd, runId)).updatedAt,
		},
		{ pid: before.pid, updatedAt: before.updatedAt },
	);

	const shown = await api.showRunAction(ctx, { runId });
	assert.match(shown.text, /⚠ stalled — no live driver/);
	const raw = await api.showRunAction(ctx, { runId, raw: true });
	assert.match(raw.text, /⚠ stalled — no live driver/);
	const list = await api.statusAction(ctx);
	assert.match(list.text, /running \(no live driver — not progressing\)/);
	// Hints follow the calling host.
	const codex = await api.statusAction({ ...ctx, host: "codex" }, { runId });
	assert.ok(codex.text.includes(`workflow_wait {"runId":"${runId}"}`));
	// The dashboard's persisted-state projection says so too.
	assert.equal(await store.isWorkflowRunLeaseLive(cwd, runId), false);

	// Driving it again clears the warning; wait takes the lease like any driver.
	const waited = await api.waitAction(ctx, { runId, timeoutMs: 20_000 });
	assert.doesNotMatch(waited.text, /stalled — no live driver/);
});

test("a read does not stamp a driver heartbeat, a driver does", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	const before = await supervisorRecord(cwd, runId);
	await api.statusAction(ctx, { runId });
	await api.logsAction(ctx, { runId });
	await api.statusAction(ctx);
	assert.deepEqual(await supervisorRecord(cwd, runId), before);
	assert.equal(await store.isWorkflowRunLeaseLive(cwd, runId), false);
	// Negative: a lease taken as a driver does write the heartbeat.
	await store.withRunLease(cwd, runId, async () => undefined);
	const after = await supervisorRecord(cwd, runId);
	assert.equal(after.pid, process.pid);
	assert.notEqual(after.updatedAt, before.updatedAt);
});

test("not flagged: a driven run, a just-launched run, a settled run", async () => {
	const { cwd, ctx, runId } = await orphanedRun();
	// Just launched (record younger than the lease-stale window): the lease may not exist yet.
	const young = await api.statusAction(ctx, { runId, snapshot: true });
	assert.doesNotMatch(young.text, /no live driver/);
	await ageRun(cwd, runId);
	// Driven: a live process holds the lease.
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
	const driven = await api.statusAction(ctx, { runId, snapshot: true });
	assert.equal(driven.data.run.live, true);
	assert.doesNotMatch(driven.text, /no live driver/);
	release();
	await holder;
	// Settled: stop makes it interrupted; the stalled wording must go.
	const stopped = await api.stopAction(ctx, { runId });
	assert.equal(stopped.data.status, "interrupted", stopped.text);
	const settled = await api.statusAction(ctx, { runId, snapshot: true });
	assert.equal(settled.data.run.status, "interrupted");
	assert.doesNotMatch(settled.text, /no live driver|stalled/);
	assert.doesNotMatch(
		(await api.statusAction(ctx)).text,
		/no live driver — not progressing/,
	);
});

test("pure formatter: judged only when the lease check said no driver", () => {
	const run = {
		runId: "r1",
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		taskSummary: { total: 2, pending: 1, running: 0, completed: 1 },
	};
	const nowMs = Date.parse("2026-01-01T01:00:00.000Z");
	assert.equal(format.runHasNoLiveDriver(run, false, nowMs), true);
	assert.equal(format.runHasNoLiveDriver(run, true, nowMs), false);
	assert.equal(format.runHasNoLiveDriver(run, undefined, nowMs), false);
	assert.equal(
		format.runHasNoLiveDriver({ ...run, status: "failed" }, false, nowMs),
		false,
	);
	assert.equal(
		format.runHasNoLiveDriver(
			{ ...run, createdAt: "2026-01-01T00:59:50.000Z" },
			false,
			nowMs,
		),
		false,
	);
	assert.equal(
		format.formatRunStallWarning(run, undefined, nowMs, undefined, true),
		undefined,
	);
});
