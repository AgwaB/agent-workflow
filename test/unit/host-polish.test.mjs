import { stateDir } from "../helpers/state-dir.mjs";
// Host-aware next-step hints use CLI commands, Pi /aw commands, or MCP tool calls.
// The fixture executor makes no model or agent CLI calls.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const hints = await import("../../dist/hosts/hints.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

const SPEC = {
	schemaVersion: 1,
	name: "wp18b-polish",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp18b-")));
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
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read.\n",
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(SPEC)}\n`);
	return {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
	};
}

function fixture(config = {}) {
	counter += 1;
	const id = `wp18b-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				...config,
				id,
				effectLog: join(root, `${id}.jsonl`),
			}),
		),
	);
	return id;
}

/** A launched, then stopped (interrupted) run: its texts carry Open/Resume hints. */
async function interruptedRun() {
	const { cwd, env } = await project();
	const executor = fixture({ stepDelayMs: 1_500 });
	const ctx = { cwd, env, host: "cli" };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "slow",
		executor,
	});
	const runId = launched.data.runId;
	const stopped = await api.stopAction(ctx, { runId });
	assert.equal(stopped.data.status, "interrupted", stopped.text);
	return { cwd, env, runId };
}

test("hints: every host gets its own vocabulary, MCP hints name real tools", () => {
	assert.equal(
		hints.hostCommandHints("cli").status("r1"),
		"agent-workflow status r1",
	);
	assert.equal(
		hints.hostCommandHints(undefined).resume("r1"),
		"agent-workflow resume r1",
	);
	assert.equal(
		hints.hostCommandHints("pi").logs("r1", "t"),
		"/aw logs r1 --task t",
	);
	for (const host of ["claude-code", "codex", "generic"]) {
		const h = hints.hostCommandHints(host);
		assert.equal(h.status("r1"), 'workflow_status {"runId":"r1"}');
		assert.equal(h.wait("r1"), 'workflow_wait {"runId":"r1"}');
	}
	const toolNames = new Set(mcpTools.HOST_MCP_TOOLS.map((tool) => tool.name));
	const h = hints.MCP_COMMAND_HINTS;
	for (const text of [
		h.status("r"),
		h.wait("r"),
		h.resume("r"),
		h.logs("r", "t"),
		h.raw("r"),
		h.inspectFailures("r"),
		h.stop("r"),
	])
		assert.ok(toolNames.has(text.split(" ")[0]), text);
});

test("status/show/stop/resume/wait texts carry the calling host's hints, never /workflow", async () => {
	const { cwd, env, runId } = await interruptedRun();
	const expectations = {
		cli: [
			`Open: agent-workflow status ${runId}`,
			`Resume: agent-workflow resume ${runId}`,
		],
		pi: [`Open: /aw status ${runId}`, `Resume: /aw resume ${runId}`],
		codex: [
			`Open: workflow_status {"runId":"${runId}"}`,
			// WP28: resume is an MCP tool.
			`Resume: workflow_resume {"runId":"${runId}"}`,
		],
	};
	for (const [host, expected] of Object.entries(expectations)) {
		const ctx = { cwd, env, host };
		const texts = [
			(await api.statusAction(ctx, { runId })).text,
			(await api.showRunAction(ctx, { runId })).text,
			(await api.showRunAction(ctx, { runId, raw: true })).text,
			(await api.waitAction(ctx, { runId, timeoutMs: 1_000 })).text,
			(await api.statusAction(ctx)).text,
		];
		for (const text of texts)
			assert.doesNotMatch(text, /\/workflow\b/, `${host}: ${text}`);
		const status = texts[0];
		for (const line of expected)
			assert.ok(status.includes(line), `${host}: ${status}`);
		assert.ok(texts[4].includes(expected[0].slice("Open: ".length)), texts[4]);
		const details = texts[1];
		assert.match(details, /Logs: /);
	}
	const resumed = await api.resumeAction({ cwd, env, host: "pi" }, { runId });
	assert.doesNotMatch(resumed.text, /\/workflow\b/);
	assert.ok(resumed.text.includes(`Open: /aw status ${runId}`), resumed.text);
	const stopped = await api.stopAction({ cwd, env, host: "codex" }, { runId });
	assert.doesNotMatch(stopped.text, /\/workflow\b/);
	assert.ok(
		stopped.text.includes(`workflow_status {"runId":"${runId}"}`),
		stopped.text,
	);
});

// --- item 3: a scheduled retry is not a stall ---

const engine = await import("../../dist/core/engine.js");

function retryRun(nowMs, { otherRunning = false } = {}) {
	const nextEligibleAt = new Date(nowMs + 9 * 60_000).toISOString();
	return {
		runId: "workflow_retry_wait",
		status: "running",
		createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
		tasks: [
			{
				taskId: "task-1",
				specId: "a",
				status: "completed",
				statusDetail: "completed",
			},
			{
				taskId: "task-2",
				specId: "b",
				status: "pending",
				statusDetail: "retry_model_failure",
				launchRetry: {
					attempts: 1,
					maxAttempts: 3,
					reason: "model_rate_limit",
					message: "429 Too Many Requests",
					nextEligibleAt,
					retryAfterMs: 900_000,
				},
			},
			...(otherRunning
				? [
						{
							taskId: "task-3",
							specId: "c",
							status: "running",
							statusDetail: "running",
						},
					]
				: []),
		],
	};
}

function aliveSupervisor(nowMs) {
	return {
		schemaVersion: 1,
		ownerId: "1-a",
		pid: 1,
		updatedAt: new Date(nowMs - 5_000).toISOString(),
		lockFile: "x",
		lastTaskTransitionAt: new Date(nowMs - 14 * 60_000).toISOString(),
		taskStatusCounts: { pending: 1, running: 0, completed: 1, total: 2 },
	};
}

test("stall warning: a run whose only open task waits for a scheduled retry says so instead", () => {
	const nowMs = Date.now();
	const run = retryRun(nowMs);
	const at = run.tasks[1].launchRetry.nextEligibleAt;
	const wait = engine.scheduledRetryWait(run, nowMs);
	assert.deepEqual(wait, {
		at,
		retryAfterMs: 9 * 60_000,
		reason: "model_rate_limit",
		message: "429 Too Many Requests",
		taskIds: ["task-2"],
	});
	const text = engine.formatRunStallWarning(
		run,
		aliveSupervisor(nowMs),
		nowMs,
		hints.CLI_COMMAND_HINTS,
	);
	assert.doesNotMatch(text, /possible stall/);
	assert.match(
		text,
		new RegExp(
			`waiting for scheduled retry at ${at.slice(0, 16).replace("T", " ")}Z \\(model_rate_limit`,
		),
	);
	// Another task still running, or a retry time already passed: the warning stays.
	const busy = retryRun(nowMs, { otherRunning: true });
	assert.equal(engine.scheduledRetryWait(busy, nowMs), undefined);
	assert.match(
		engine.formatRunStallWarning(
			busy,
			aliveSupervisor(nowMs),
			nowMs,
			hints.CLI_COMMAND_HINTS,
		),
		/possible stall; inspect agent-workflow logs workflow_retry_wait/,
	);
	assert.equal(engine.scheduledRetryWait(run, nowMs + 10 * 60_000), undefined);
});

// --- item 4: wait reports the scheduled retry ---

test("wait: a run waiting on a retry backoff returns the retry time and reason (data, text, MCP next)", async () => {
	const { cwd, env, runId } = await interruptedRun();
	const runPath = join(
		stateDir(cwd),
		".agent-workflow",
		"workflows",
		runId,
		"run.json",
	);
	const record = JSON.parse(await readFile(runPath, "utf8"));
	const nextEligibleAt = new Date(Date.now() + 15 * 60_000).toISOString();
	record.status = "running";
	for (const task of record.tasks) {
		task.status = "pending";
		task.statusDetail = "retry_model_failure";
		task.launchRetry = {
			attempts: 1,
			maxAttempts: 3,
			reason: "model_rate_limit",
			message: "429 rate limited",
			nextEligibleAt,
			retryAfterMs: 900_000,
		};
	}
	record.taskSummary = {
		...record.taskSummary,
		pending: record.tasks.length,
		running: 0,
		interrupted: 0,
	};
	await writeFile(runPath, `${JSON.stringify(record, null, 2)}\n`);
	const ctx = { cwd, env, host: "codex" };
	const waited = await api.waitAction(ctx, { runId, timeoutMs: 1_000 });
	assert.equal(waited.data.stillRunning, true, waited.text);
	assert.equal(waited.data.nextRetry?.at, nextEligibleAt);
	assert.equal(waited.data.nextRetry?.reason, "model_rate_limit");
	assert.deepEqual(waited.data.nextRetry?.taskIds, [record.tasks[0].taskId]);
	assert.match(
		waited.text,
		/waiting for scheduled retry at .*model_rate_limit/,
	);
	const service = mcpTools.createHostMcpService({
		root: cwd,
		host: "codex",
		env,
	});
	const call = {
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		signal: new AbortController().signal,
		sendRequest: async () => ({}),
		sendNotification: async () => undefined,
	};
	const viaMcp = await service.call(
		"workflow_wait",
		{ runId, timeoutMs: 1_000 },
		call,
	);
	const text = viaMcp.content[0].text;
	assert.match(text, /waiting for scheduled retry at/);
	assert.match(text, /no completion push|does not notify/i);
	assert.match(text, new RegExp(runId));
	await api
		.stopAction({ cwd, env, host: "cli" }, { runId })
		.catch(() => undefined);
});

// --- items 5/6: domain verdict vs. run status ---

const feedback = await import("../../dist/hosts/pi/feedback.js");
const cli = await import("../../dist/hosts/cli/index.js");

/** A deep-review-like renderer: writes final-report.md and declares `status` + `verdict`. */
const RENDER_HELPER = `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async function render({ options, context }) {
	const dir = join(context.stateCwd, ".agent-workflow", "workflows", context.runId, "tasks", context.taskId);
	await mkdir(dir, { recursive: true });
	const markdown = "# Review\\n\\nVerdict: " + options.verdict + "\\n\\nOne finding kept.";
	await writeFile(join(dir, "final-report.md"), markdown + "\\n", "utf8");
	const passed = options.status === "passed";
	return {
		schema: "stage-control-v1",
		digest: "Rendered 1 finding.",
		status: options.status,
		verdict: options.verdict,
		completionSummaryMarkdown: passed ? "Verdict: " + options.verdict + " — one finding kept." : "",
		markdown,
		sidecarPath: "final-report.md",
	};
}
`;

async function verdictRun(status, verdict) {
	const { cwd, env } = await project();
	await writeFile(join(cwd, "render.mjs"), RENDER_HELPER);
	await writeFile(
		join(cwd, "verdict.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wp18b-verdict",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "Collect facts." },
					{
						id: "final",
						from: "a",
						support: { uses: "./render.mjs", options: { status, verdict } },
					},
				],
			},
		}),
	);
	const executor = fixture();
	const ctx = { cwd, env, host: "cli" };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "verdict.json",
		task: "review",
		executor,
	});
	assert.ok(launched.data.runId, launched.text);
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	return { cwd, env, runId: launched.data.runId, waited };
}

test("Pi completion message: the domain verdict, with the run status on its own line", async () => {
	const { cwd, runId, waited } = await verdictRun("passed", "NEEDS_WORK");
	assert.equal(waited.data.status, "completed", waited.text);
	assert.equal(waited.data.verdict, "NEEDS_WORK");
	const run = JSON.parse(
		await readFile(
			join(stateDir(cwd), ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	for (const instruct of [false, true]) {
		const message = await feedback.completionMessage(cwd, run, { instruct });
		assert.match(message.content, /^Verdict: NEEDS_WORK$/m, message.content);
		assert.match(message.content, /^Run status: completed$/m, message.content);
		assert.doesNotMatch(message.content, /Verdict: completed/);
		assert.equal(message.details.verdict, "NEEDS_WORK");
	}
});

test("verdict gate: a run whose only failure is the final verdict is presented as finished with that verdict (all hosts)", async () => {
	const { cwd, env, runId, waited } = await verdictRun(
		"failed",
		"PARTIAL_REVIEW",
	);
	// Engine semantics are unchanged: the run is failed, the outcome stays failed (CLI exit 1).
	assert.equal(waited.data.status, "failed", waited.text);
	assert.equal(waited.outcome, "failed");
	assert.equal(waited.ok, false);
	assert.equal(waited.data.verdict, "PARTIAL_REVIEW");
	assert.equal(waited.data.verdictGate, true);
	assert.match(waited.data.preview ?? "", /Verdict: PARTIAL_REVIEW/);
	const report = waited.data.reportArtifacts.find(
		(a) => a.kind === "final-report",
	);
	assert.match(report?.path ?? "", /final-report\.md$/);
	assert.match(
		waited.text,
		/finished — verdict: PARTIAL_REVIEW \(report ready\)/,
	);
	assert.doesNotMatch(waited.text, /preview: unavailable/);
	assert.ok(waited.text.includes(report.path), waited.text);

	const status = await api.statusAction({ cwd, env, host: "cli" }, { runId });
	assert.match(
		status.text,
		/finished — verdict: PARTIAL_REVIEW \(report ready\)/,
	);
	assert.ok(status.text.includes(report.path), status.text);
	assert.equal(status.data.run.verdict, "PARTIAL_REVIEW");
	assert.equal(status.data.run.verdictGate, true);

	const service = mcpTools.createHostMcpService({
		root: cwd,
		host: "codex",
		env,
	});
	const call = {
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		signal: new AbortController().signal,
		sendRequest: async () => ({}),
		sendNotification: async () => undefined,
	};
	const viaMcp = await service.call("workflow_wait", { runId }, call);
	const mcpText = viaMcp.content[0].text;
	assert.match(mcpText, /verdict=PARTIAL_REVIEW/);
	assert.match(mcpText, /finished — verdict: PARTIAL_REVIEW \(report ready\)/);
	assert.ok(mcpText.includes(report.path));
	assert.equal(viaMcp.isError, false);

	const out = [];
	const io = {
		cwd,
		env,
		stdout: (t) => out.push(t),
		stderr: () => undefined,
		isTTY: false,
	};
	assert.equal(await cli.runAgentWorkflowCli(["wait", runId], io), 1);
	assert.match(
		out.join(""),
		/finished — verdict: PARTIAL_REVIEW \(report ready\)/,
	);

	const run = JSON.parse(
		await readFile(
			join(stateDir(cwd), ".agent-workflow", "workflows", runId, "run.json"),
			"utf8",
		),
	);
	const message = await feedback.completionMessage(cwd, run, {
		instruct: true,
	});
	assert.match(
		message.content,
		/finished — verdict: PARTIAL_REVIEW \(report ready\)/,
	);
	assert.match(message.content, /^Verdict: PARTIAL_REVIEW$/m);
	assert.ok(message.content.includes(report.path), message.content);
	assert.match(message.content, /Verdict: PARTIAL_REVIEW/);

	// A real failure (an interrupted model task) is not a verdict gate.
	const real = await interruptedRun();
	const realWait = await api.waitAction(
		{ cwd: real.cwd, env: real.env, host: "cli" },
		{ runId: real.runId, timeoutMs: 1_000 },
	);
	assert.equal(realWait.data.verdictGate, undefined);
	assert.doesNotMatch(realWait.text, /report ready/);
});

// --- item 8: host launch claim files are pruned ---

const guard = await import("../../dist/hosts/launch-guard.js");

test("launch claims: stale claim files are pruned on launch and by prune; fresh ones stay", async () => {
	const { cwd, env } = await project();
	const dir = guard.launchGuardDir(cwd);
	await mkdir(dir, { recursive: true });
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	const claim = (name, extra = {}) =>
		JSON.stringify({
			schema: "agent-workflow-host-launch-v1",
			fingerprint: name,
			claimedAt: old.toISOString(),
			pid: 999_999,
			...extra,
		});
	// WP19 round 6: only real claim files (`<sha256>.json`, matching fingerprint) and their
	// writers' temp files are pruned.
	const DONE = "1".repeat(64);
	const DEAD = "2".repeat(64);
	const FRESH = "4".repeat(64);
	const files = {
		[`${DONE}.json`]: claim(DONE, { runId: "workflow_gone_000000" }),
		[`${DEAD}.json`]: claim(DEAD),
		[`${"3".repeat(64)}.json.1.0123456789ab.tmp`]: "{}",
	};
	for (const [name, text] of Object.entries(files)) {
		await writeFile(join(dir, name), text);
		await utimes(join(dir, name), old, old);
	}
	await writeFile(
		join(dir, `${FRESH}.json`),
		claim(FRESH, { claimedAt: new Date().toISOString() }),
	);

	const dry = await api.pruneAction({ cwd, env }, {});
	assert.equal(dry.data.hostLaunchClaims.removed.length, 3);
	assert.match(
		dry.text,
		/Host launch claims: 3 stale file\(s\) would be removed/,
	);
	assert.equal((await readdir(dir)).length, 4);
	const done = await api.pruneAction({ cwd, env }, { yes: true });
	assert.match(done.text, /Host launch claims: 3 stale file\(s\) removed/);
	assert.deepEqual(await readdir(dir), [`${FRESH}.json`]);

	// A launch prunes stale claims of other fingerprints too.
	await writeFile(join(dir, `${DEAD}.json`), claim(DEAD));
	await utimes(join(dir, `${DEAD}.json`), old, old);
	const decision = await guard.claimLaunch(cwd, "f".repeat(64));
	assert.equal(decision.kind, "claimed");
	await decision.release();
	for (
		let i = 0;
		i < 50 && (await readdir(dir)).includes(`${DEAD}.json`);
		i += 1
	)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(await readdir(dir), [`${FRESH}.json`]);
});

// agent-workflow 2026-11-04 (a workflow authored with the workflow-guide skill): a final support
// renderer that returns only \`markdown\` (written to analysis.md, as documented) has a report too.
test("a final support stage's markdown is the run's report when it writes no final-report.md", async () => {
	const { cwd, env } = await project();
	await writeFile(
		join(cwd, "render-md.mjs"),
		`export default async function render() {
	return { schema: "stage-control-v1", digest: "rendered", verdict: "ORIENTATION_COMPLETE", completionSummaryMarkdown: "Done.", markdown: "# Orientation\\n\\nThree subsystems." };
}
`,
	);
	await writeFile(
		join(cwd, "md.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wp18b-markdown-report",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "Collect facts." },
					{ id: "final", from: "a", support: { uses: "./render-md.mjs" } },
				],
			},
		}),
	);
	const ctx = { cwd, env, host: "cli" };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "md.json",
		task: "orient",
		executor: fixture(),
	});
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	assert.equal(waited.data.status, "completed", waited.text);
	assert.equal(waited.data.reportArtifacts.length, 1);
	assert.match(
		waited.data.reportArtifacts[0].path,
		/tasks\/[^/]+\/analysis\.md$/u,
	);
	const shown = await api.showAction(ctx, {
		ref: launched.data.runId,
		includeReport: true,
	});
	assert.match(
		shown.data.report?.text ?? JSON.stringify(shown.data.report),
		/Three subsystems/u,
	);
});
