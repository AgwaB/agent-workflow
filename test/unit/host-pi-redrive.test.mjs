// Pi session start re-drives runs without a live driver after an attached launcher exits.
// Blocked runs stay blocked; uncertain launches require an owner decision, never relaunch.
// Re-driving binds no audience, and skips live-driven runs. The fixture makes no model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { eventually, fakeCtx, fakePi } from "../helpers/pi-host-fake.mjs";
import {
	readFixtureLog,
	WORKFLOW_EXECUTOR_FIXTURE_MODULE,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const run = promisify(execFile);
const api = await import("../../dist/hosts/api.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");
const core = await import("../../dist/core/index.js");
const store = await import("../../dist/core/store.js");
const slots = await import("../../dist/core/launch-slots.js");

const DIST = (path) =>
	fileURLToPath(new URL(`../../dist/${path}`, import.meta.url));

const TWO_STAGE = {
	schemaVersion: 1,
	name: "wp28-redrive",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{ id: "b", type: "single", prompt: "Summarize stage a.", from: "a" },
		],
	},
};

// The gone launcher: registers the fixture, launches an attached run, exits once the first
// attempt consumed its launch authority (its worker keeps running; nothing drives the run).
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
if (config.stay) {
	// A live driver: keep supervising until the run settles.
	await api.waitAction(
		{ cwd, env: process.env },
		{ runId: launched.data.runId, longWait: true, timeoutMs: 120000 },
	);
	process.exit(0);
}
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
const instances = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp28-redrive-")));
	launcher = join(root, "launcher.mjs");
	await writeFile(launcher, LAUNCHER);
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

async function project(config = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(TWO_STAGE)}\n`);
	const fixtureConfig = {
		id: `test-wp28-redrive-${counter}`,
		effectLog: join(root, `redrive-${counter}-effects.jsonl`),
		stepDelayMs: 400,
		...config,
	};
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor(fixtureConfig)),
	);
	const env = { ...process.env };
	return { cwd, env, ctx: { cwd, env }, fixtureConfig };
}

/** Launch an attached run from a child process that then exits (no live supervisor remains). */
async function orphanedRun({ cwd, env, fixtureConfig }) {
	const { stdout } = await launch({ cwd, env, fixtureConfig });
	const launched = JSON.parse(stdout);
	assert.equal(launched.status, "running");
	return launched.runId;
}

function launch({ cwd, env, fixtureConfig }, extra = {}) {
	return run(
		process.execPath,
		[
			launcher,
			new URL(`file://${DIST("core/index.js")}`).href,
			new URL(`file://${DIST("hosts/api.js")}`).href,
			new URL(`file://${WORKFLOW_EXECUTOR_FIXTURE_MODULE}`).href,
			cwd,
			JSON.stringify({ ...fixtureConfig, task: `orphan ${counter}`, ...extra }),
		],
		{ cwd, env, timeout: 150_000 },
	);
}

function install(env) {
	const calls = [];
	const wrapped = {};
	for (const [name, value] of Object.entries(api)) {
		if (typeof value !== "function") continue;
		wrapped[name] = async (...args) => {
			const result = await value(...args);
			if (/Action$/.test(name)) calls.push({ name, result });
			return result;
		};
	}
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({
		api: wrapped,
		env,
		feedbackPollMs: 50,
	})(pi);
	instances.push({ pi });
	const start = async (ctx) => {
		for (const handler of pi.handlers.get("session_start"))
			await handler({ type: "session_start", reason: "startup" }, ctx);
		await ext.unfinishedNoticeSettledForTests(pi);
	};
	const redrives = () =>
		calls
			.filter((call) => call.name === "redriveRunsAction")
			.map((call) => call.result.data);
	return { pi, start, redrives };
}

const submits = (fixtureConfig, runId) =>
	readFixtureLog(fixtureConfig.effectLog).filter(
		(entry) => entry.type === "submit" && entry.attemptKey.includes(runId),
	);
const completion = (pi, runId) =>
	pi.messages.filter(
		(entry) =>
			entry.message.customType === "agent-workflow-completion" &&
			entry.message.details?.runId === runId,
	);

test("session start picks up a run whose launcher died; delivery stays with the run's audience", async () => {
	const p = await project();
	const runId = await orphanedRun(p);
	// The launching Pi session ("session-b") is the run's delivery audience.
	await feedback.bindFeedbackAudience(
		p.cwd,
		runId,
		"session-b",
		"tool",
		Date.now(),
	);
	// Nothing drives the run: its first task finishes in its worker, the second never starts.
	await new Promise((done) => setTimeout(done, 2_500));
	// (Read the record without a refresh: a status call would drive the run itself.)
	assert.equal(await store.isWorkflowRunLeaseLive(p.cwd, runId), false);
	assert.equal((await store.readRunRecord(p.cwd, runId)).status, "running");
	assert.equal(submits(p.fixtureConfig, runId).length, 1);
	let current;

	// Another session starts in the project: it re-drives the run to completion…
	const other = install(p.env);
	const ctxA = fakeCtx(p.cwd, { sessionId: "session-a" });
	await other.start(ctxA);
	assert.deepEqual(other.redrives()[0], {
		redriven: [runId],
		skipped: [],
		errors: [],
	});
	await eventually(async () => {
		current = await api.statusAction(p.ctx, { runId });
		return current.data.run.status === "completed";
	}, "the re-driven run completes");
	// …without relaunching the first task, and without taking over delivery.
	assert.equal(
		submits(p.fixtureConfig, runId).length,
		2,
		"a then b, once each",
	);
	assert.equal(
		(await feedback.readFeedbackAudience(p.cwd, runId)).sessionId,
		"session-b",
	);
	await new Promise((done) => setTimeout(done, 300));
	assert.equal(completion(other.pi, runId).length, 0, "not session-a's run");

	// The audience session gets it when it starts (catch-up), once.
	const owner = install(p.env);
	await owner.start(fakeCtx(p.cwd, { sessionId: "session-b" }));
	await eventually(
		() => completion(owner.pi, runId).length === 1,
		"the audience session's catch-up",
	);
	assert.deepEqual(owner.redrives()[0].redriven, [], "nothing left to drive");
});

test("B3: a crashed attempt whose launch cannot be proven becomes a decision, never a relaunch", async () => {
	const p = await project({ stepDelayMs: 2_000 });
	const runId = await orphanedRun(p);
	// The attempt's worker dies after consuming its launch authority, before any terminal record.
	const consumed = readFixtureLog(p.fixtureConfig.effectLog).find(
		(entry) => entry.type === "consume" && entry.attemptKey.includes(runId),
	);
	process.kill(consumed.pid, "SIGKILL");
	await new Promise((done) => setTimeout(done, 300));
	// (No status call here: its refresh would already turn the run into the decision.)
	assert.equal(
		(await store.readRunRecord(p.cwd, runId)).status,
		"running",
		"left running by the launcher",
	);
	const { start, redrives } = install(p.env);
	await start(fakeCtx(p.cwd, { sessionId: "session-c" }));
	assert.deepEqual(redrives()[0].redriven, [runId]);
	let current;
	await eventually(async () => {
		current = await api.statusAction(p.ctx, { runId });
		return current.data.run.status === "blocked";
	}, "the run blocks on an owner decision");
	const blocked = current.data.run.tasks.filter(
		(entry) => entry.status === "blocked",
	);
	assert.equal(blocked.length, 1, JSON.stringify(current.data.run.tasks));
	assert.equal(
		blocked[0].statusDetail,
		core.EXECUTOR_NEEDS_DECISION_STATUS_DETAIL,
	);
	assert.equal(submits(p.fixtureConfig, runId).length, 1, "no relaunch");
	assert.ok(
		readFixtureLog(p.fixtureConfig.effectLog).some(
			(entry) => entry.type === "reconcile" && "unknown" in entry.result,
		),
	);

	// A later session start leaves the blocked run alone (resume is the user's decision).
	const next = install(p.env);
	await next.start(fakeCtx(p.cwd, { sessionId: "session-d" }));
	assert.deepEqual(next.redrives()[0].redriven, []);
	await new Promise((done) => setTimeout(done, 1_500));
	assert.equal(
		(await api.statusAction(p.ctx, { runId })).data.run.status,
		"blocked",
	);
	assert.equal(submits(p.fixtureConfig, runId).length, 1);
});

test("a run another live process drives is skipped; this process's own runs and workers are safe", async () => {
	const p = await project({ stepDelayMs: 500 });
	const driver = launch(p, { stay: true });
	let runId;
	await eventually(async () => {
		const runs = await store.listRunRecords(p.cwd).catch(() => []);
		runId = runs[0]?.runId;
		return (
			runId !== undefined &&
			runs[0].status === "running" &&
			(await store.isWorkflowRunLeaseLive(p.cwd, runId))
		);
	}, "the driver process supervises its run");
	const { start, redrives } = install(p.env);
	await start(fakeCtx(p.cwd, { sessionId: "session-e" }));
	assert.deepEqual(redrives()[0], {
		redriven: [],
		skipped: [{ runId, reason: "live-supervisor" }],
		errors: [],
	});
	await driver;
	assert.equal((await store.readRunRecord(p.cwd, runId)).status, "completed");
	assert.equal(submits(p.fixtureConfig, runId).length, 2);

	// A run this very process watches is picked up again idempotently (one watcher, no relaunch).
	const local = await api.runWorkflowAction(p.ctx, {
		workflow: "wf.json",
		task: "driven here",
		executor: p.fixtureConfig.id,
	});
	const again = install(p.env);
	await again.start(fakeCtx(p.cwd, { sessionId: "session-g" }));
	assert.deepEqual(again.redrives()[0].redriven, [local.data.runId]);
	const done = await api.waitAction(p.ctx, {
		runId: local.data.runId,
		longWait: true,
		timeoutMs: 60_000,
	});
	assert.equal(done.data.status, "completed");
	assert.equal(submits(p.fixtureConfig, local.data.runId).length, 2);

	// Worker processes never re-drive.
	const worker = install({ ...p.env, AGENT_WORKFLOW_ROLE: "worker" });
	await worker.start(fakeCtx(p.cwd, { sessionId: "session-f" }));
	assert.deepEqual(worker.redrives(), []);
});
