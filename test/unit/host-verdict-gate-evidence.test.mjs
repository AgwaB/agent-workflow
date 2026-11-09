// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP19, stage-2 review #10): a generic support failure is not presented as a
// verdict gate. The reviewer's control record — the final support step declared `failed` with
// "required evidence missing", no domain verdict, no report artifact — is presented as a failure
// by wait/status, the host MCP server and the Pi completion message. A verdict alone without a
// report (or a report alone without a verdict) is not enough either. Fixture executor only.
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

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const feedback = await import("../../dist/hosts/pi/feedback.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-gate-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A support step that declares `failed` with the given control fields (and maybe a report). */
const helper = (
	control,
	writeReport,
) => `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async function render({ context }) {
	const dir = join(context.stateCwd, ".agent-workflow", "workflows", context.runId, "tasks", context.taskId);
	await mkdir(dir, { recursive: true });
	${writeReport ? 'await writeFile(join(dir, "final-report.md"), "# Report\\n", "utf8");' : ""}
	return ${JSON.stringify({ schema: "stage-control-v1", status: "failed", ...control })};
}
`;

async function supportFailedRun(control, writeReport = false) {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nYou read.\n",
	);
	await writeFile(join(cwd, "render.mjs"), helper(control, writeReport));
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wp19-gate",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "Collect facts." },
					{ id: "final", from: "a", support: { uses: "./render.mjs" } },
				],
			},
		}),
	);
	const id = `wp19-gate-${counter}`;
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({ id, effectLog: join(root, `${id}.jsonl`) }),
		),
	);
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") };
	const ctx = { cwd, env, host: "cli" };
	const launched = await api.runWorkflowAction(ctx, {
		workflow: "wf.json",
		task: "review",
		executor: id,
	});
	assert.ok(launched.data.runId, launched.text);
	let waited;
	do
		waited = await api.waitAction(ctx, {
			runId: launched.data.runId,
			timeoutMs: 10_000,
		});
	while (waited.data.stillRunning);
	return { cwd, env, ctx, runId: launched.data.runId, waited };
}

test("review #10: the control record (failed, required evidence missing, no verdict, no artifacts) is a failure", async () => {
	const { cwd, env, ctx, runId, waited } = await supportFailedRun({
		digest: "required evidence missing",
	});
	assert.equal(waited.data.status, "failed");
	assert.equal(waited.data.verdictGate, undefined, JSON.stringify(waited.data));
	assert.doesNotMatch(waited.text, /finished — verdict/);
	assert.match(waited.text, /Workflow terminal/);
	const status = await api.statusAction(ctx, { runId });
	assert.equal(status.data.run.verdictGate, undefined);
	assert.doesNotMatch(status.text, /finished — verdict/);
	const service = mcpTools.createHostMcpService({
		root: cwd,
		host: "codex",
		env,
	});
	const viaMcp = await service.call(
		"workflow_wait",
		{ runId },
		{
			protocolVersion: "2025-06-18",
			clientCapabilities: {},
			signal: new AbortController().signal,
			sendRequest: async () => ({}),
			sendNotification: async () => undefined,
		},
	);
	assert.doesNotMatch(
		viaMcp.content[0].text,
		/finished — verdict|verdictGate=true/,
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
	assert.doesNotMatch(message.content, /finished — verdict/);
	assert.equal(message.details.verdictGate, undefined);
});

test("review #10: a verdict without a report, or a report without a verdict, is not a verdict gate", async () => {
	const verdictOnly = await supportFailedRun({
		digest: "x",
		verdict: "PARTIAL_REVIEW",
	});
	assert.equal(verdictOnly.waited.data.verdictGate, undefined);
	const reportOnly = await supportFailedRun({ digest: "x" }, true);
	assert.equal(reportOnly.waited.data.verdictGate, undefined);
	// Both: the verdict gate (WP18b behavior kept).
	const both = await supportFailedRun(
		{ digest: "x", verdict: "PARTIAL_REVIEW", sidecarPath: "final-report.md" },
		true,
	);
	assert.equal(both.waited.data.verdictGate, true, both.waited.text);
});
