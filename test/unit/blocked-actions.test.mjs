// test-tier: integration
import assert from "node:assert/strict";
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
import {
	summarizeBlockedActions,
	projectBlockedActions,
	runBlockedActions,
	blockedActionsLabel,
} from "../../dist/core/blocked-actions.js";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { runWorkflowSpec, waitForRun } from "../../dist/core/engine.js";
import { formatHumanRunStatus } from "../../dist/core/engine-format.js";
import {
	statusAction,
	inspectAction,
	showRunAction,
	waitAction,
} from "../../dist/hosts/runs.js";
import { notifyCheck } from "../../dist/hosts/notify-check.js";
import { wakeLaunchingHostSessions } from "../../dist/hosts/host-wake.js";
import { projectRun } from "../../dist/hosts/dashboard/projection.js";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const denied = (fields = {}) => ({
	type: "tool_call",
	name: "bash",
	kind: "execute",
	status: "denied",
	output: "Provider policy rejected the command",
	...fields,
});
const approval = (fields = {}) => ({
	type: "approval_request",
	requestId: "a",
	kind: "execute",
	detail: "execute",
	command: "touch blocked",
	...fields,
});
const decision = (fields = {}) => ({
	requestId: "a",
	decision: "deny",
	response: "accepted",
	reason: "readOnly denies mutation",
	...fields,
});

// Count events literally; repeated denied updates are not silently deduplicated into calls.
test("only normalized denied events count; samples stop at three, even for repeated ids", () => {
	const events = [
		denied({ status: "running" }),
		denied({ status: "failed" }),
		approval(),
		...Array.from({ length: 5 }, () => denied({ callId: "same" })),
	];
	const result = summarizeBlockedActions(events, [], {});
	assert.equal(result.count, 5);
	assert.equal(result.provider, 5);
	assert.equal(result.engine, 0);
	assert.equal(result.samples.length, 3);
	assert.equal(
		summarizeBlockedActions(
			[approval(), denied({ status: "failed" })],
			[decision()],
			{},
		),
		undefined,
	);
});

test("accepted engine deny matches command or id; unrelated allow is still provider", () => {
	for (const [request, event] of [
		[approval(), denied({ input: { command: "touch blocked" } })],
		[approval({ command: undefined }), denied({ callId: "a" })],
	]) {
		const result = summarizeBlockedActions([request, event], [decision()], {});
		assert.equal(result.engine, 1);
		assert.equal(result.provider, 0);
		assert.equal(result.samples[0].source, "engine");
		assert.equal(result.samples[0].reason, "readOnly denies mutation");
	}
	assert.equal(
		summarizeBlockedActions(
			[approval(), denied()],
			[decision({ decision: "allow" })],
			{},
		).provider,
		1,
	);
});

test("unlinked or late approval denies are not falsely attributed to engine", () => {
	const result = summarizeBlockedActions(
		[approval(), denied()],
		[decision()],
		{},
	);
	assert.deepEqual([result.count, result.provider, result.engine], [1, 0, 0]);
	assert.equal(result.samples[0].source, undefined);
	assert.match(blockedActionsLabel(result), /unknown source/);
	assert.equal(
		summarizeBlockedActions(
			[approval(), denied()],
			[decision({ response: "too_late" })],
			{},
		).provider,
		1,
	);
});

test("command comes from the same call's running input; redaction precedes 300-char sample bound", () => {
	const result = summarizeBlockedActions(
		[
			denied({
				status: "running",
				callId: "c",
				input: {
					command: `curl https://example.com/?token=hidden-secret ${["", "Users", "alice", "private"].join("/")}`,
				},
			}),
			denied({
				callId: "c",
				name: "bash\u001b\n",
				output: `API_KEY=credential-secret Bearer abcdefghijklmnop ${"long ".repeat(200)} HOST-SECRET-VALUE`,
			}),
		],
		[],
		{ PRIVATE_TOKEN: "HOST-SECRET-VALUE" },
	);
	const text = JSON.stringify(result);
	assert.doesNotMatch(
		text,
		/hidden-secret|credential-secret|abcdefghijklmnop|HOST-SECRET-VALUE|alice/,
	);
	const sample = result.samples[0];
	assert.ok(sample.command.includes("REDACTED"));
	assert.ok(
		sample.tool.length + sample.command.length + sample.reason.length <= 300,
	);
	assert.equal(sample.tool.includes("\n"), false);
});

test("absent is none; allowlisted projections reject invalid counts and omit extra fields", () => {
	for (const value of [
		undefined,
		null,
		{},
		{ count: 0 },
		{ count: 1, provider: 2, engine: 0, samples: [] },
	])
		assert.equal(projectBlockedActions(value), undefined);
	assert.equal(runBlockedActions({ tasks: [{}, {}] }), undefined);
	const projected = projectBlockedActions({
		count: 2,
		provider: 1,
		engine: 1,
		samples: [{ tool: "bash", reason: "denied", arbitrary: "private" }],
		arbitrary: "private",
	});
	assert.doesNotMatch(JSON.stringify(projected), /arbitrary|private/);
	assert.equal(blockedActionsLabel(undefined), "");
	assert.equal(
		blockedActionsLabel(projected, true),
		"; 2 actions were blocked (1 provider policy, 1 engine policy)",
	);
});

let root;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-visible-blocks-")));
});
after(async () => {
	for (const undo of unregister) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});
let serial = 0;
async function completed(steps, permissionMode = "free") {
	const id = `visible-blocks-${++serial}`;
	const cwd = join(root, id);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const path = join(cwd, "wf.json");
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			name: "visible-blocks",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: { stages: [{ id: "a", type: "single", prompt: "Read" }] },
		}),
	);
	unregister.push(
		registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(cwd, "effects.jsonl"),
				beforeOutputSteps: steps,
			}),
		),
	);
	const started = await runWorkflowSpec(path, cwd, {
		task: "test",
		executor: id,
		permissionMode,
	});
	const run = await waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks));
	return {
		cwd,
		run,
		ctx: {
			cwd,
			env: {
				...process.env,
				AGENT_WORKFLOW_HOME: join(cwd, "home"),
				AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
			},
		},
	};
}

for (const source of ["provider", "engine"])
	test(`completed ${source}-blocked run: records, status, inspect, notice, wait and dashboard`, async () => {
		const event = denied({ input: { command: "touch blocked" } });
		const steps =
			source === "provider"
				? [event, event]
				: [{ approval: approval(), ifAllowed: [], ifDenied: [event, event] }];
		// Engine denial is safe-only; keep every blocked-action projection assertion.
		const { cwd, run, ctx } = await completed(
			steps,
			source === "engine" ? "safe" : "free",
		);
		const task = run.tasks.find((task) => task.blockedActions);
		assert.equal(task.blockedActions.count, 2);
		assert.equal(task.blockedActions[source], 2);
		const status = await statusAction(ctx, {
			runId: run.runId,
			snapshot: true,
		});
		assert.equal(status.data.run.blockedActions.count, 2);
		assert.equal(
			status.data.run.tasks.find((item) => item.taskId === task.taskId)
				.blockedActions.count,
			2,
		);
		assert.match(
			status.text,
			new RegExp(`2 actions blocked by ${source} policy`),
		);
		assert.match(status.text, /Blocked actions:/);
		const inspect = await inspectAction(ctx, { runId: run.runId });
		assert.equal(inspect.data.blockedActions.count, 2);
		assert.match(inspect.text, /touch blocked/);
		assert.match(
			inspect.text,
			new RegExp(
				`agent-workflow logs ${run.runId} --task ${task.taskId} --stream events`,
			),
		);
		const notice = await notifyCheck(cwd, { host: "claude-code" });
		assert.equal(notice.data.notifications[0].blockedActions.count, 2);
		assert.match(
			notice.text,
			new RegExp(`; 2 actions were blocked \\(${source} policy\\)`),
		);
		assert.equal(notice.text.split("\n").length, 1);
		const shown = await showRunAction(ctx, {
			runId: run.runId,
			snapshot: true,
		});
		const projection = projectRun(status.data.run, shown.data);
		assert.equal(projection.blockedActions.count, 2);
		assert.equal(
			projection.tasks.find((item) => item.taskId === task.taskId)
				.blockedActions.count,
			2,
		);
		assert.deepEqual(
			projection.needsYou,
			[],
			"no decision exists for a denied action",
		);
		const wait = await waitAction(ctx, { runId: run.runId, timeoutMs: 1000 });
		assert.equal(wait.data.blockedActions.count, 2);
		assert.match(
			wait.text.split("\n")[0],
			new RegExp(`; 2 actions were blocked \\(${source} policy\\)`),
		);
		assert.equal(wait.data.actionRequired, false);
	});

test("Codex queue uses the same short blocked-action completion notice", async () => {
	const { cwd, run } = await completed([denied()]);
	// The queue follows launching-host session records; create them through the real writer.
	const { recordRunHostSession } = await import(
		"../../dist/hosts/notify-check.js"
	);
	await recordRunHostSession(
		cwd,
		run.runId,
		"12345678-1234-1234-1234-123456789abc",
	);
	const calls = [];
	await wakeLaunchingHostSessions(
		cwd,
		{ ...run, launch: { source: "mcp:codex" } },
		{
			run: async (command, args) => {
				calls.push({ command, args });
				return { ok: true, output: "" };
			},
		},
	);
	assert.equal(calls.length, 1);
	assert.match(
		calls[0].args.at(-1),
		/; 1 action was blocked \(provider policy\)/,
	);
});

test("zero-block run and old records add no fields or text on any projection", async () => {
	const { cwd, run, ctx } = await completed([denied({ status: "failed" })]);
	assert.ok(run.tasks.every((task) => !("blockedActions" in task)));
	const status = await statusAction(ctx, { runId: run.runId, snapshot: true });
	assert.equal("blockedActions" in status.data.run, false);
	assert.ok(status.data.run.tasks.every((task) => !("blockedActions" in task)));
	assert.equal(status.text, formatHumanRunStatus(run));
	const inspect = await inspectAction(ctx, { runId: run.runId });
	assert.doesNotMatch(inspect.text, /blocked action|stream events/i);
	assert.equal("blockedActions" in inspect.data, false);
	const shown = await showRunAction(ctx, { runId: run.runId, snapshot: true });
	assert.equal(
		"blockedActions" in projectRun(status.data.run, shown.data),
		false,
	);
	const notice = await notifyCheck(cwd);
	assert.doesNotMatch(notice.text, /actions? (?:was|were) blocked/);
	assert.equal("blockedActions" in notice.data.notifications[0], false);
});

test("MCP status, inspect and wait keep counts in text and structured content", async (t) => {
	const { cwd, run, ctx } = await completed([denied()]);
	const { inProcessHostServer } = await import(
		"../helpers/mcp-host-client.mjs"
	);
	const client = await inProcessHostServer({ root: cwd, env: ctx.env });
	t.after(() => client.close());
	await client.initialize("2025-06-18");
	const status = await client.call("workflow_status", { runId: run.runId });
	assert.equal(status.isError, false);
	assert.equal(status.structuredContent.data.run.blockedActions.count, 1);
	assert.match(status.content[0].text, /1 action blocked by provider policy/);
	const inspect = await client.call("workflow_inspect", { runId: run.runId });
	assert.equal(inspect.structuredContent.data.run.blockedActions.count, 1);
	assert.equal(
		inspect.structuredContent.data.run.tasks.find((task) => task.blockedActions)
			.blockedActions.count,
		1,
	);
	const wait = await client.call("workflow_wait", { runId: run.runId });
	assert.equal(wait.structuredContent.data.blockedActions.count, 1);
	assert.match(
		wait.content[0].text,
		/; 1 action was blocked \(provider policy\)/,
	);
	assert.match(
		wait.structuredContent.next,
		/; 1 action was blocked \(provider policy\)/,
	);
	const listing = await statusAction(ctx);
	assert.match(listing.text, /1 action blocked by provider policy/);
});

test("task result includes the summary; a later result without denials clears it", async () => {
	const { cwd, run } = await completed([denied()]);
	const task = run.tasks.find((task) => task.blockedActions);
	const { fromStatePath } = await import("../../dist/core/store.js");
	const initial = JSON.parse(
		await readFile(fromStatePath(cwd, task.files.result), "utf8"),
	);
	assert.equal(initial.blockedActions.count, 1);
	const { materializeTerminalWorkerResult } = await import(
		"../../dist/core/terminal-result.js"
	);
	// A newer failed attempt with no output still replaces the previous attempt's summary.
	await materializeTerminalWorkerResult(cwd, run, task, {
		runId: "replacement",
		attemptId: "attempt-2",
		executorId: "fixture",
		status: "failed",
		failureKind: "executor_permanent",
		logs: [],
		metadata: {},
		completedAt: new Date().toISOString(),
	});
	assert.equal("blockedActions" in task, false);
	assert.equal(runBlockedActions(run), undefined);
	const latest = JSON.parse(
		await readFile(fromStatePath(cwd, task.files.result), "utf8"),
	);
	assert.equal("blockedActions" in latest, false);
});
