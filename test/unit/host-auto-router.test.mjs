import { stateDir } from "../helpers/state-dir.mjs";
// Auto routing and launch capture in a fake Pi session. Show a consent dialog with
// classifier identity and task, then ranked choices and a separate final confirmation.
// The comparison loader is cancellable. Host launch capture records selection without
// runtime/fast fields. Fixture executor answers recommendations and no-fit cases.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import {
	autoProject,
	core,
	fakeLoaders,
	piAutoSession,
	runCount,
	runIds,
	settle,
	shadowExecutors,
	store,
	submits,
} from "../helpers/pi-auto-harness.mjs";

const ext = await import("../../dist/hosts/pi/extension.js");
const capture = await import("../../dist/hosts/launch-capture.js");
const { fakePi } = await import("../helpers/pi-host-fake.mjs");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];
const sessions = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp38b-auto-router-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.shutdown();
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

async function project(workflows, executorOptions = {}) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const env = await autoProject(cwd, join(root, `home${counter}`), workflows);
	const log = join(root, `effects-${counter}.jsonl`);
	unregister.push(...shadowExecutors(log, executorOptions));
	return { cwd, env, log };
}

function session(cwd, env, options) {
	const created = piAutoSession(cwd, env, options);
	sessions.push(created);
	return created;
}

/** A bare Pi command handler and a hand-made context. */
function bareHandler(env) {
	const pi = fakePi();
	ext.createAgentWorkflowPiExtension({ env, feedbackPollMs: 50 })(pi);
	sessions.push({
		async shutdown() {
			for (const handler of pi.handlers.get("session_shutdown") ?? [])
				await handler({ reason: "quit" }, undefined);
		},
	});
	return pi.commands.get("aw").handler;
}

function selectionFor(kind, recommendation) {
	return {
		candidates: [
			{
				candidateId: "a".repeat(64),
				kind: "direct-dynamic",
				label: "Dynamic workflow",
			},
			{ candidateId: "c".repeat(64), kind: "named-workflow", label: "review" },
		],
		recommendation,
		selected:
			kind === "direct-dynamic"
				? { candidateId: "a".repeat(64), kind, label: "Dynamic workflow" }
				: { candidateId: "c".repeat(64), kind, label: "review" },
		choseRecommendation:
			recommendation?.candidateId === "a".repeat(64) &&
			kind === "direct-dynamic",
		classifier: { executor: "pi", model: null },
		consent: "command",
		taskSha256: "b".repeat(64),
	};
}

test("auto v2 command capture preserves the supplied slash arguments exactly once", async () => {
	// The pure host launch capture.
	const env = { ...process.env, HOME: join(root, "capture-home") };
	const captured = capture.hostLaunchCapture(
		"pi",
		env,
		"dynamic",
		{ task: "review" },
		{ kind: "command", text: '/aw auto "review"' },
		selectionFor("direct-dynamic", {
			candidateId: "a".repeat(64),
			confidence: "high",
		}),
	);
	assert.equal(captured.schema, "agent-workflow-run-launch-v2");
	assert.equal(captured.requestKind, "direct-dynamic");
	assert.deepEqual(captured.entry, { kind: "command", action: "auto" });
	assert.deepEqual(captured.command, {
		state: "captured",
		text: '/aw auto "review"',
	});
	const manualFallback = capture.hostLaunchCapture(
		"pi",
		env,
		"run",
		{ task: "review" },
		{ kind: "command", text: '/aw auto "review"' },
		selectionFor("named-workflow", null),
	);
	assert.equal(manualFallback.selection.recommendation, null);
	assert.equal(manualFallback.requestKind, "named-workflow");
	// Capture validation refuses unknown selected kinds such as direct.
	const invalid = {
		...captured,
		command: {
			state: "captured",
			artifact: "launch-command.txt",
			encoding: "utf-8",
			bytes: 17,
			sha256: "0".repeat(64),
			fidelity: "agent-workflow-host-command-v1",
			sensitivity: "user-input",
			disclosure: "explicit-only",
		},
		task: { characters: 6, lines: 1 },
	};
	assert.equal(store.isWorkflowRunLaunchMetadata(invalid), true);
	assert.equal(
		store.isWorkflowRunLaunchMetadata({
			...invalid,
			selection: {
				...invalid.selection,
				selected: { ...invalid.selection.selected, kind: "direct" },
			},
		}),
		false,
	);
	// End to end: the slash arguments are recorded once, as typed.
	const { cwd, env: projectEnv } = await project([
		["review", "Use review for a bounded review."],
	]);
	const pi = session(cwd, projectEnv);
	await pi.command('  auto "review"');
	const [runId] = await runIds(cwd);
	assert.ok(runId, JSON.stringify(pi.ctx.notes));
	await settle(cwd, projectEnv, runId);
	const record = await store.readRunRecord(cwd, runId);
	assert.equal(record.launch.schema, "agent-workflow-run-launch-v2");
	assert.equal(record.launch.routingMode, "auto");
	const text = await readFile(
		join(
			stateDir(cwd),
			".agent-workflow",
			"workflows",
			runId,
			"launch-command.txt",
		),
		"utf8",
	);
	assert.equal(text, '/aw auto "review"');
});

test("headless Pi auto launches without transmission authorization dialogs; misplaced options still fail", async () => {
	const { cwd, env, log } = await project(
		[["review-headless", "Use review-headless for a bounded review."]],
		{ recommend: "review-headless" },
	);
	const pi = session(cwd, env, { ctx: { mode: "rpc" } });
	await pi.command('auto "SECRET ORIGINAL TASK"');
	assert.equal(submits(log).classifier.length, 1);
	assert.deepEqual(pi.confirms, []);
	assert.deepEqual(pi.ctx.selects, []);
	const [runId] = await runIds(cwd);
	assert.ok(runId);
	await settle(cwd, env, runId);
	const text = pi.ctx.notes.map(({ message }) => message).join("\n");
	assert.equal(text.includes("SECRET ORIGINAL TASK"), false);
	await pi.command('auto "SECRET ORIGINAL" --detach "TASK"');
	assert.ok(
		pi.ctx.notes.some(({ message }) =>
			/Misplaced workflow option --detach/.test(message),
		),
	);
	assert.equal(
		submits(log).classifier.length,
		1,
		"invalid options send no extra classifier request",
	);
});

test("Korean no-transmit tasks never reach the classifier or launch", async () => {
	const { cwd, env, log } = await project([]);
	const loaders = fakeLoaders();
	const pi = session(cwd, env, {
		ctx: { mode: "tui", custom: true },
		foregroundLoader: loaders.factory,
	});
	await pi.command('auto "이 작업을 외부 모델로 보내지 마세요."');
	assert.deepEqual(pi.confirms, []);
	assert.deepEqual(pi.ctx.selects, []);
	assert.equal(submits(log).classifier.length, 0);
	assert.equal(submits(log).workflow.length, 0);
	assert.equal(await runCount(cwd), 0);
	assert.match(
		pi.ctx.notes.map(({ message }) => message).join("\n"),
		/No workflow has been started/,
	);
});

test("TUI no-fit starts nothing and never offers a manual fallback", async () => {
	const { cwd, env, log } = await project(
		[["manual-fallback-review", "Use for bounded review."]],
		{ autoStatus: "no-fit" },
	);
	const loaders = fakeLoaders();
	const pi = session(cwd, env, {
		ctx: { mode: "tui", custom: true },
		foregroundLoader: loaders.factory,
	});
	await pi.command('auto "Use a safe local fallback."');
	assert.equal(loaders.created.length, 1);
	assert.equal(submits(log).classifier.length, 1);
	assert.deepEqual(pi.ctx.selects, []);
	assert.deepEqual(pi.confirms, []);
	const text = pi.ctx.notes.map(({ message }) => message).join("\n");
	assert.doesNotMatch(text, /Auto route:|candidateId|schemas=|verification=/);
	assert.equal(await runCount(cwd), 0);
	assert.match(text, /No workflow has been started/i);
});

for (const task of [
	"Do not send this to any external model.",
	"Do not write to disk; do not use the network.",
]) {
	test(`TUI offers only cancellation under a transmission restriction: ${task}`, async () => {
		const { cwd, env, log } = await project([
			["offline-review", "Use offline-review for bounded review."],
		]);
		const loaders = fakeLoaders();
		const pi = session(cwd, env, {
			ctx: { mode: "tui", custom: true },
			foregroundLoader: loaders.factory,
		});
		await pi.command(`auto ${JSON.stringify(task)}`);
		// The task restriction blocks transmission after consent; no workflow is
		// offered and no picker opens when nothing can start.
		assert.equal(submits(log).classifier.length, 0);
		assert.equal(pi.ctx.selects.length, 0);
		const text = pi.ctx.notes.map(({ message }) => message).join("\n");
		assert.match(text, /No workflow can be started for this request\./);
		assert.match(text, /No workflow has been started\./);
		assert.doesNotMatch(
			text,
			/Current conversation|current conversation|Dynamic workflow|manual|unranked/,
		);
		assert.equal(await runCount(cwd), 0);
	});
}
