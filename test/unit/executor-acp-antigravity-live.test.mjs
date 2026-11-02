// Live tier for the ACP adapter's antigravity preset. Skipped unless AGENT_WORKFLOW_LIVE=1. Each
// run costs model calls (one smoke + the kit's live checks that are not skipped: readOnly and
// isolation, so three prompts on gemini-3.8-flash), so run it deliberately and record the result in
// docs/executors/acp.md.
//
// Must run with the real environment (the agy_acp_server login recorded in the worker home):
// `AGENT_WORKFLOW_LIVE=1 node --test test/unit/executor-acp-antigravity-live.test.mjs` after
// `npm run build`. Under test/run-unit.mjs the home directory is isolated and the test skips.
// AGENT_WORKFLOW_AGY_ACP_SERVER overrides the server path.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createExecutor } from "../../dist/executors/acp/index.js";
import {
	createStubMcpServer,
	drain,
	runConformance,
} from "../../dist/sdk/conformance/index.js";
import {
	createAuthorityGate,
	decideApproval,
	defaultApprovalPolicy,
	validateEventSequence,
} from "../../dist/sdk/index.js";

const LIVE = process.env.AGENT_WORKFLOW_LIVE === "1";
const MODEL = process.env.AGENT_WORKFLOW_AGY_LIVE_MODEL ?? "gemini-3.8-flash";
const SERVER =
	process.env.AGENT_WORKFLOW_AGY_ACP_SERVER ??
	join(homedir(), ".local/share/agy-acp-server/1.4.5/agy_acp_server.par");

const config = (stateDir) => ({
	preset: "antigravity",
	command: SERVER,
	stateDir,
	agentHome: join(homedir(), ".agent-workflow/executors/acp/antigravity-home"),
	killGraceMs: 3_000,
	handshakeTimeoutMs: 120_000,
});

async function ready() {
	if (!LIVE)
		return "set AGENT_WORKFLOW_LIVE=1 to run live antigravity checks (costs model calls)";
	if (!existsSync(SERVER)) return `agy_acp_server not found at ${SERVER}`;
	const probe = await createExecutor(
		config(mkdtempSync("/tmp/aw-live-agy-probe-")),
	).probe();
	if (!probe.installed) return probe.notes.join("; ");
	if (probe.auth !== "ok")
		return `no login recorded in the worker home (${probe.notes.join("; ")})`;
	return false;
}
const skip = await ready();

test("antigravity live smoke: an MCP result reaches the tool_call output in full; no workspace file", {
	skip,
	timeout: 600_000,
}, async () => {
	const dir = mkdtempSync("/tmp/aw-live-agy-smoke-");
	const executor = createExecutor(config(join(dir, ".state")));
	const server = await createStubMcpServer({ dir, padChars: 200_000 });
	const nonce = `n${randomBytes(4).toString("hex")}`;
	const attemptKey = `live-agy-smoke-${Date.now()}`;
	const req = {
		attemptKey,
		authority: createAuthorityGate({ attemptKey }).authority,
		cwd: dir,
		prompt: `Call the "echo" tool of the MCP server "${server.spec.name}" once with text "${nonce}". Reply with only the first 9 characters of its result. Use no other tool.`,
		model: MODEL,
		effort: "low",
		tools: ["read"],
		readOnly: false,
		mcpServers: [server.spec],
		deadlineMs: Date.now() + 300_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy({ allowKinds: ["other"] }),
		permissionMode: "safe",
		artifactsDir: join(dir, "artifacts"),
	};
	const ref = await executor.submit(req);
	const { events, terminal } = await drain(executor, ref, {
		timeoutMs: 300_000,
		onApproval: async (event) => {
			const decision = decideApproval(req.approvalPolicy, event, req);
			await executor.respond(
				ref,
				event.requestId,
				decision === "allow" ? "allow" : "deny",
			);
		},
	});
	assert.deepEqual(validateEventSequence(events), []);
	assert.equal(terminal.type, "completed", JSON.stringify(terminal));
	assert.match(terminal.finalText, new RegExp(nonce));
	const closing = events.filter(
		(event) => event.type === "tool_call" && event.status === "completed",
	);
	assert.equal(closing.length, 1, JSON.stringify(closing.map((e) => e.name)));
	assert.equal(typeof closing[0].output, "string");
	assert.equal(closing[0].output.length, 200_000);
	assert.ok(closing[0].output.startsWith(nonce));
	assert.equal(existsSync(join(dir, "skills")), false);
	const usage = events.find((event) => event.type === "usage");
	assert.ok(usage !== undefined && usage.input > 0 && usage.cost === null);
});

test("antigravity live: conformance kit live tier", {
	skip,
	timeout: 1_800_000,
}, async () => {
	const stateDir = mkdtempSync("/tmp/aw-live-agy-kit-state-");
	const report = await runConformance(
		{
			name: "antigravity-live",
			scenarios: ["complete"],
			live: true,
			async open() {
				return {
					executor: createExecutor(config(stateDir)),
					effectCount: async () => 0,
				};
			},
			request(base) {
				return { ...base, model: MODEL, effort: "low" };
			},
		},
		{
			tiers: ["live"],
			only: ["live."],
			timeouts: {
				callMs: 120_000,
				streamMs: 300_000,
				liveStreamMs: 300_000,
				checkMs: 900_000,
			},
		},
	);
	const out = process.env.AGENT_WORKFLOW_AGY_LIVE_REPORT;
	if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
	console.log(
		JSON.stringify({
			summary: report.summary,
			results: report.results.map((r) => [
				r.id,
				r.status,
				r.violations,
				r.reason ?? null,
			]),
		}),
	);
	assert.deepEqual(
		report.results
			.filter((result) => result.status === "fail")
			.map((result) => [result.id, result.violations]),
		[],
	);
});
