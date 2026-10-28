// Ported (WP38b) from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-router.test.mjs (MIT,
// same author): the seven `/workflow auto` slash-capture and TUI tests, against WP32 `/aw auto`
// (host API `autoAction`) in a fake Pi session. The core router tests of that file are in
// core-workflow-router.test.mjs; "cancelling a dynamic foreground launch reclaims the created run"
// stays not applicable (`/aw dynamic` returns at start, no foreground loader).
//
// Changed mechanisms: pi-workflow's native TUI picker (`ctx.ui.custom`, searchable, "Choose how to
// run") is Pi's `ctx.ui.select` (the ranked workflows and "Cancel (start nothing)") followed by the
// separate final confirmation; its transmission dialog "Allow auto comparison transmission" is
// "Send this task to pi to compare workflows?" (the classifier executor/model and the task are
// shown); the comparison loader is the WP38b `withForegroundLoader` loader. pi-workflow's
// `workflowAutoSlashLaunchCapture` (v2 `pi-workflow-run-launch-v2`, `effectiveRuntime`) is the host
// launch capture `agent-workflow-run-launch-v2` (WP32/WP33; no runtime/fast fields). The classifier
// answer comes from the workflow executor fixture (`autoRecommend`, `autoStatus: "no-fit"`).
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
	slots.setSubagentLaunchControlsForTests({
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

const CONSENT = "Send this task to pi to compare workflows?";
const FINAL = "Confirm selected workflow launch";

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

/** A bare Pi command handler and a hand-made context (pi-workflow's headless/TUI fixtures). */
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
		consent: "prompt",
		taskSha256: "b".repeat(64),
		confirmed: true,
	};
}

test("auto v2 command capture preserves the supplied slash arguments exactly once", async () => {
	// The pure capture (pi-workflow's workflowAutoSlashLaunchCapture → hostLaunchCapture).
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
	// pi-workflow refused an unknown selected kind ("direct"); the v2 validation does here.
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
	assert.equal(record.launch.routingMode, "auto-confirmed");
	const text = await readFile(
		join(cwd, ".agent-workflow", "workflows", runId, "launch-command.txt"),
		"utf8",
	);
	assert.equal(text, '/aw auto "review"');
});

test("headless /workflow auto fails closed without structured transmission authorization", async () => {
	const { cwd, env, log } = await project([
		["review-headless", "Use review-headless for a bounded review."],
	]);
	const handler = bareHandler(env);
	// An RPC session whose UI has no confirmation dialog: nothing can authorize the request.
	const messages = [];
	await handler('  auto "SECRET ORIGINAL TASK"', {
		cwd,
		mode: "rpc",
		hasUI: true,
		ui: {
			notify(message, level) {
				messages.push({ message, level });
			},
		},
	});
	assert.equal(submits(log).classifier.length, 0);
	const text = messages.map(({ message }) => message).join("\n");
	assert.match(text, /Not sent: you did not agree to the comparison request/);
	assert.match(text, /no workflow has been started\./);
	assert.equal(text.includes("SECRET ORIGINAL TASK"), false);
	const optionMessages = [];
	await handler('auto --detach "SECRET ORIGINAL TASK"', {
		cwd,
		mode: "rpc",
		hasUI: true,
		ui: {
			notify(message, level) {
				optionMessages.push({ message, level });
			},
		},
	});
	assert.equal(
		optionMessages.some(({ message }) =>
			/Unknown or misplaced workflow option --detach/.test(message),
		),
		true,
	);
	assert.equal(submits(log).classifier.length, 0);
	assert.equal(await runCount(cwd), 0);
});

test("TUI cancellation keeps a Korean no-transmit task out of the classifier", async () => {
	const { cwd, env, log } = await project([]);
	const handler = bareHandler(env);
	const confirmations = [];
	const notices = [];
	await handler('auto "이 작업을 외부 모델로 보내지 마세요."', {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			confirm(title) {
				confirmations.push(title);
				return false;
			},
			custom() {
				throw new Error(
					"cancelled transmission must not open a classifier loader",
				);
			},
			notify(message, level) {
				notices.push({ message, level });
			},
		},
	});
	assert.deepEqual(confirmations, [CONSENT]);
	assert.equal(submits(log).classifier.length, 0);
	assert.ok(
		notices.some(({ message }) =>
			/Not sent: you did not agree .* No task was sent/.test(message),
		),
		JSON.stringify(notices),
	);
});

test("TUI keeps safe choices after no-fit without metadata noise or routing jargon", async () => {
	const { cwd, env, log } = await project(
		[
			[
				"manual-fallback-review",
				"Use manual-fallback-review for bounded review.",
			],
		],
		{ autoStatus: "no-fit" },
	);
	const loaders = fakeLoaders();
	const pi = session(cwd, env, {
		ctx: { mode: "tui", custom: true },
		foregroundLoader: loaders.factory,
		// Selecting a workflow still requires confirmation; rejecting it must not launch.
		confirm: (title) => title === CONSENT,
		select: (options) =>
			options.find((option) => option.includes("manual-fallback-review")),
	});
	await pi.command('auto "Use a safe local fallback."');
	assert.equal(
		loaders.created.length,
		1,
		"the comparison ran behind the loader",
	);
	assert.equal(submits(log).classifier.length, 1);
	const [picker] = pi.ctx.selects;
	assert.ok(picker, JSON.stringify(pi.ctx.notes));
	const pickerText = `${picker.title}\n${picker.options.join("\n")}`;
	assert.match(pickerText, /Choose the workflow to start/);
	assert.match(pickerText, /No recommendation \(no-fit/);
	assert.match(pickerText, /manual-fallback-review/);
	assert.equal(picker.options.at(-1), "Cancel (start nothing)");
	// Changed: pi-workflow also excluded "named-workflow"; the WP32 ranked list tags each candidate
	// with its kind and scope (`[named-workflow, project]`), as the CLI and MCP lists do.
	assert.doesNotMatch(
		pickerText,
		/Current conversation|current conversation|Manual local fallback|unranked|classifier|candidateId|schemas=|verification=/,
	);
	assert.doesNotMatch(
		pi.ctx.notes.map(({ message }) => message).join("\n"),
		/Auto route:|candidateId|schemas=|verification=/,
	);
	assert.deepEqual(
		pi.confirms.map(({ title }) => title),
		[CONSENT, FINAL],
	);
	// pi-workflow also checked that no chat draft was prepared; `/aw auto` never writes the editor.
	assert.equal(await runCount(cwd), 0);
	assert.ok(
		pi.ctx.notes.some(({ message }) =>
			/No workflow has been started/i.test(message),
		),
	);
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
		// The task's own restriction blocks the request after consent: nothing is sent and no
		// workflow is offered (pi-workflow showed a picker with only Cancel; agent-workflow shows
		// no picker when nothing can start).
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

test("TUI confirms an unranked named manual fallback with null v2 provenance", async () => {
	const workflows = [
		[
			"manual-provenance-review",
			"Use manual-provenance-review for bounded review.",
		],
	];
	for (let index = 0; index < 10; index += 1)
		workflows.push([
			`manual-provenance-extra-${index}`,
			`Use manual-provenance-extra-${index} for bounded review.`,
		]);
	const { cwd, env, log } = await project(workflows, { autoStatus: "no-fit" });
	const loaders = fakeLoaders();
	const pi = session(cwd, env, {
		ctx: { mode: "tui", custom: true },
		foregroundLoader: loaders.factory,
		select: (options) =>
			options.find((option) =>
				/^\d+\. manual-provenance-review — /.test(option),
			),
	});
	await pi.command('auto "Confirm the unranked named route."');
	assert.deepEqual(
		pi.confirms.map(({ title }) => title),
		[CONSENT, FINAL],
	);
	const [runId] = await runIds(cwd);
	assert.ok(
		runId,
		`confirmed named fallback launches only after selection: ${pi.ctx.notes.map(({ message }) => message).join(" | ")}`,
	);
	await settle(cwd, env, runId);
	assert.ok(submits(log).workflow.length > 0);
	const persisted = await store.readRunRecord(cwd, runId);
	assert.equal(persisted.name, "manual-provenance-review");
	assert.equal(persisted.launch?.selection.recommendation, null);
	assert.equal(persisted.launch?.selection.selected.kind, "named-workflow");
	assert.equal(persisted.launch?.selection.choseRecommendation, false);
});
