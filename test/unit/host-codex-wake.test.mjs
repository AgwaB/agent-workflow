// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// 2026-11-05 (owner: wait in code, wake the host once; live checks internal host-wake-20261105): an
// interactive Codex session that launched a run gets the result queued into its thread when the
// run has settled (`codex queue`), so the agent ends its turn instead of calling workflow_wait.
// `codex exec` launches and non-detached runs still wait. The Codex CLI is faked here.
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const wake = await import("../../dist/hosts/host-wake.js");
const notify = await import("../../dist/hosts/notify-check.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const api = await import("../../dist/hosts/api.js");

const THREAD = "01a1a9fc-37e9-7613-b590-05c91fcc4e84";
let root;
let counter = 0;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-codex-wake-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(cwd, { recursive: true });
	await mkdir(join(stateDir(cwd), ".agent-workflow", "notify-check"), {
		recursive: true,
	});
	return cwd;
}

async function writeRun(cwd, runId, status, source = "mcp:codex") {
	const dir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
	await mkdir(dir, { recursive: true });
	const run = {
		runId,
		name: "deep-review",
		type: "workflow",
		status,
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		updatedAt: new Date().toISOString(),
		launch: { schema: "agent-workflow-run-launch-v1", source },
		tasks: [
			{
				taskId: "task-1",
				specId: "a.main",
				displayName: "a.main",
				status,
				statusDetail: status,
				runtime: {},
				files: {
					systemPrompt: "",
					taskPrompt: "",
					output: "",
					stderr: "",
					result: "",
				},
			},
		],
		taskSummary: {
			total: 1,
			completed: status === "completed" ? 1 : 0,
			failed: 0,
			interrupted: 0,
			pending: 0,
			running: status === "running" ? 1 : 0,
			blocked: 0,
			skipped: 0,
		},
	};
	await writeFile(join(dir, "run.json"), JSON.stringify(run));
	return run;
}

const turn = (trigger) => ({
	"x-codex-turn-metadata": {
		thread_id: THREAD,
		session_id: THREAD,
		turn_trigger: trigger,
	},
	threadId: THREAD,
});

test("codexTurnSession reads the thread and whether the turn is interactive", () => {
	assert.deepEqual(wake.codexTurnSession(turn("user")), {
		threadId: THREAD,
		interactive: true,
	});
	assert.deepEqual(wake.codexTurnSession(turn("exec")), {
		threadId: THREAD,
		interactive: false,
	});
	assert.equal(
		wake.codexTurnSession({ "x-codex-turn-metadata": { thread_id: "../x" } }),
		undefined,
	);
	assert.equal(wake.codexTurnSession(undefined), undefined);
});

test("wakeLaunchingHostSessions queues the line once into each linked Codex thread", async () => {
	const cwd = await project();
	const run = await writeRun(cwd, "workflow_cx", "completed");
	const calls = [];
	const runner = async (command, args) => {
		calls.push([command, ...args]);
		return { ok: true, output: "Queued message" };
	};
	// Not linked: nothing.
	await wake.wakeLaunchingHostSessions(cwd, run, { run: runner });
	assert.equal(calls.length, 0);
	await notify.recordRunHostSession(cwd, "workflow_cx", THREAD);
	// Turned off: nothing.
	await wake.wakeLaunchingHostSessions(cwd, run, {
		run: runner,
		env: { AGENT_WORKFLOW_HOST_WAKE: "0" },
	});
	assert.equal(calls.length, 0);
	const log = [];
	await wake.wakeLaunchingHostSessions(cwd, run, {
		run: runner,
		log: (line) => log.push(line),
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].slice(0, 4), [
		"codex",
		"queue",
		"--thread",
		THREAD,
	]);
	assert.equal(calls[0][4], "--message");
	assert.match(
		calls[0][5],
		/^agent-workflow: workflow "deep-review" \(run workflow_cx\) finished/,
	);
	assert.match(log.join("\n"), /codex queue .*: queued/);
	// The same settled state again (or after workflow_wait reported it): no second wake.
	await wake.wakeLaunchingHostSessions(cwd, run, {
		run: runner,
		log: (line) => log.push(line),
	});
	assert.equal(calls.length, 1);
	assert.match(log.at(-1), /already reported/);
	// A run another host launched is never queued into Codex.
	const other = await writeRun(
		cwd,
		"workflow_claude",
		"completed",
		"mcp:claude-code",
	);
	await notify.recordRunHostSession(cwd, "workflow_claude", THREAD);
	await wake.wakeLaunchingHostSessions(cwd, other, { run: runner });
	assert.equal(calls.length, 1);
});

test("the detached supervisor wakes the linked Codex session when the run settles", async () => {
	const cwd = await project();
	await writeRun(cwd, "workflow_sup", "completed");
	await notify.recordRunHostSession(cwd, "workflow_sup", THREAD);
	const lines = [];
	const result = await api.superviseAction(
		{ cwd, env: process.env, host: "cli" },
		{
			runId: "workflow_sup",
			onLog: (line) => lines.push(line),
			testHooks: {
				schedule: async () => undefined,
				sleep: async () => undefined,
			},
		},
	);
	assert.equal(result.data.result, "completed");
	// The unit runner's fail-fast `codex` shim is what got called.
	assert.match(
		lines.join("\n"),
		new RegExp(`host wake: codex queue ${THREAD}: failed`),
	);
});

test("a Codex launch's next step: end the turn for an interactive, detached launch; else workflow_wait", async () => {
	const cwd = await project();
	await writeRun(cwd, "workflow_launched", "running");
	const fakeApi = (detached) =>
		new Proxy(
			{},
			{
				get(_, name) {
					if (name === "registerTestExecutorFromEnv")
						return async () => undefined;
					if (name === "runWorkflowAction")
						return async () => ({
							action: "run",
							ok: true,
							outcome: "running",
							text: "Workflow started: deep-review",
							data: {
								runId: "workflow_launched",
								status: "running",
								name: "deep-review",
								...(detached ? { detached: { pid: 1, logPath: "x" } } : {}),
							},
						});
					return undefined;
				},
			},
		);
	const text = async ({ meta, detached = true, env = {} }) =>
		(
			await mcpTools
				.createHostMcpService({
					root: cwd,
					host: "codex",
					env: { ...process.env, ...env },
					api: fakeApi(detached),
				})
				.call(
					"workflow_run",
					{ workflow: "deep-review", task: "t" },
					{
						protocolVersion: "2025-06-18",
						clientCapabilities: {},
						signal: new AbortController().signal,
						sendRequest: async () => ({}),
						sendNotification: async () => undefined,
						...(meta ? { meta } : {}),
					},
				)
		).content
			.map((part) => part.text)
			.join("\n");
	const WAIT =
		/Then call workflow_wait \{"runId":"workflow_launched"\} and repeat while stillRunning is true\./;
	const queued = await text({ meta: turn("user") });
	assert.match(
		queued,
		/puts the result into this Codex session when the run has finished \(a queued message\): end your turn now/,
	);
	assert.deepEqual(await notify.runHostSessions(cwd, "workflow_launched"), [
		THREAD,
	]);
	assert.match(await text({ meta: turn("exec") }), WAIT);
	assert.match(await text({ meta: turn("user"), detached: false }), WAIT);
	assert.match(
		await text({ meta: turn("user"), env: { AGENT_WORKFLOW_HOST_WAKE: "0" } }),
		WAIT,
	);
	assert.match(await text({}), WAIT);
});

for (const first of ["settled before binding", "queued before reread"]) {
	test(`a fast Codex launch reports exactly once: ${first}`, async (t) => {
		const cwd = await project();
		const runId = "workflow_fast";
		await writeRun(cwd, runId, "running");
		const reached = Promise.withResolvers();
		const release = Promise.withResolvers();
		const beforeBinding = first === "settled before binding";
		if (!beforeBinding) {
			// Let the supervisor see the link, but don't let MCP proceed to reread the run.
			const open = fs.open;
			const mock = t.mock.method(fs, "open", async (...args) => {
				const handle = await open(...args);
				if (String(args[0]).endsWith(`session-${THREAD}.${runId}.link`)) {
					reached.resolve();
					await release.promise;
				}
				return handle;
			});
			syncBuiltinESMExports();
			t.after(() => {
				mock.mock.restore();
				syncBuiltinESMExports();
			});
		}
		const service = mcpTools.createHostMcpService({
			root: cwd,
			host: "codex",
			env: process.env,
			api: {
				...api,
				async runWorkflowAction() {
					if (beforeBinding) {
						reached.resolve();
						await release.promise;
					}
					return {
						action: "run",
						ok: true,
						outcome: "running",
						text: "Workflow started",
						data: {
							runId,
							status: "running",
							detached: { pid: 1, logPath: "x" },
						},
					};
				},
			},
		});
		const context = {
			protocolVersion: "2025-06-18",
			clientCapabilities: {},
			meta: turn("user"),
		};
		const calling = service.call(
			"workflow_run",
			{ workflow: "deep-review", task: "t" },
			context,
		);
		const queued = [];
		const push = (run) =>
			wake.wakeLaunchingHostSessions(cwd, run, {
				run: async (_command, args) => {
					queued.push(args);
					return { ok: true, output: "Queued message" };
				},
			});
		let settled;
		try {
			await Promise.race([
				reached.promise,
				calling.then(() => assert.fail("launch bypassed the barrier")),
			]);
			assert.deepEqual(
				await notify.runHostSessions(cwd, runId),
				beforeBinding ? [] : [THREAD],
			);
			settled = await writeRun(cwd, runId, "completed");
			await push(settled);
			assert.equal(queued.length, beforeBinding ? 0 : 1);
		} finally {
			release.resolve();
		}
		const result = await calling;
		assert.deepEqual(await notify.runHostSessions(cwd, runId), [THREAD]);
		const text = result.content[0].text;
		if (beforeBinding) {
			assert.match(text, /Then call workflow_wait \{"runId":"workflow_fast"\}/);
			assert.doesNotMatch(text, /end your turn now/);
			// A late notifier cannot also queue this epoch, even before the directed wait.
			await push(settled);
			assert.equal(queued.length, 0);
			const waited = await service.call("workflow_wait", { runId }, context);
			assert.equal(waited.isError, false, waited.content[0].text);
			assert.equal(waited.structuredContent.data.status, "completed");
		} else {
			assert.doesNotMatch(text, /Then call workflow_wait|Wait for the result:/);
			assert.match(text, /queued message/);
			assert.equal(queued[0][2], THREAD);
			await push(settled);
			assert.equal(queued.length, 1);
		}
	});
}

test("a wake command that ignores SIGTERM cannot hold the supervisor: it is killed at the timeout", async () => {
	const t0 = Date.now();
	const result = await wake.runWakeCommand(
		"/bin/sh",
		["-c", "trap '' TERM; while :; do sleep 1; done"],
		500,
	);
	assert.equal(result.ok, false);
	assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0}ms`);
});
