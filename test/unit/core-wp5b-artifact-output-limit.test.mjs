// New in agent-workflow (WP5b): the artifact MCP server is launched with the executor's measured
// MCP output limit. The run's recorded probe (run.capabilityNegotiation.probe, WP4d) carries
// mcpOutputLimitChars / mcpOutputNoticeChars; the task backend appends
// `--max-output-chars <limit − notice − max(256, 5 % of limit)>` to the workflow_artifact server,
// and launch provenance digests exactly that spec.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	artifactMcpServerSpec,
	artifactServerOutputLimitForRun,
	canonicalArtifactAccessJson,
} from "../../dist/core/artifact-access.js";
import { prepareDagTask } from "../../dist/core/artifact-graph-runtime.js";
import { probeWorkflowExecutor } from "../../dist/core/capability-negotiation.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { AGENT_WORKFLOW_HOME_ENV } from "../../dist/core/home-dir.js";
import { HOST_CONTEXT_ENV } from "../../dist/core/host-context.js";
import { createLaunchBootstrapProvenance } from "../../dist/core/launch-bootstrap-provenance.js";
import { resolveWorkflowResourcePolicy } from "../../dist/core/resource-inheritance.js";
import { createRunRecord } from "../../dist/core/store.js";
import { preparedMcpServers } from "../../dist/core/task-backend.js";
import {
	DEFAULT_MCP_OUTPUT_TOKENS,
	mcpOutputLimitChars,
} from "../../dist/executors/claude/config.js";
import { CODEX_MCP_OUTPUT_LIMIT_CHARS } from "../../dist/executors/codex/capabilities.js";
import {
	PI_MCP_OUTPUT_LIMIT_CHARS,
	PI_MCP_OUTPUT_NOTICE_CHARS,
} from "../../dist/executors/pi/executor.js";
import { artifactServerOutputLimit } from "../../dist/sdk/index.js";
import { createFakeExecutor } from "../../dist/sdk/testing/index.js";

/** Declared probe limits of the three stage-1 executors and the server limit they yield. */
const EXECUTORS = [
	{
		id: "pi",
		probe: {
			mcpOutputLimitChars: PI_MCP_OUTPUT_LIMIT_CHARS,
			mcpOutputNoticeChars: PI_MCP_OUTPUT_NOTICE_CHARS,
		},
		// 20480 − 1024 (notice) − 1024 (5 %)
		serverLimit: 18_432,
	},
	{
		id: "claude",
		probe: {
			mcpOutputLimitChars: mcpOutputLimitChars(DEFAULT_MCP_OUTPUT_TOKENS),
		},
		// 22500 − 0 − 1125 (5 %)
		serverLimit: 21_375,
	},
	{
		id: "codex",
		probe: { mcpOutputLimitChars: CODEX_MCP_OUTPUT_LIMIT_CHARS },
		// 32000 − 0 − 1600 (5 %)
		serverLimit: 30_400,
	},
];

function sha256Canonical(value) {
	return createHash("sha256")
		.update(canonicalArtifactAccessJson(value))
		.digest("hex");
}

test("declared limits of pi, claude and codex map to the documented server limits", () => {
	assert.equal(PI_MCP_OUTPUT_LIMIT_CHARS, 20_480);
	assert.equal(PI_MCP_OUTPUT_NOTICE_CHARS, 1_024);
	assert.equal(mcpOutputLimitChars(DEFAULT_MCP_OUTPUT_TOKENS), 22_500);
	assert.equal(CODEX_MCP_OUTPUT_LIMIT_CHARS, 32_000);
	for (const { id, probe, serverLimit } of EXECUTORS) {
		assert.equal(artifactServerOutputLimit(probe), serverLimit, id);
		assert.ok(
			serverLimit + (probe.mcpOutputNoticeChars ?? 0) + 256 <=
				probe.mcpOutputLimitChars,
			id,
		);
	}
	// Unknown limits keep the server default; tiny limits clamp to the server minimum.
	for (const probe of [
		undefined,
		null,
		{},
		{ mcpOutputLimitChars: null },
		{ mcpOutputLimitChars: 0 },
		{ mcpOutputLimitChars: 1.5 },
	])
		assert.equal(artifactServerOutputLimit(probe), null);
	assert.equal(artifactServerOutputLimit({ mcpOutputLimitChars: 600 }), 512);
	assert.equal(
		artifactServerOutputLimit({ mcpOutputLimitChars: 4096 }),
		4096 - 256,
	);
});

test("the recorded probe carries the limit and the task backend launches the server with it", async () => {
	const capabilities = createFakeExecutor().capabilities();
	const server = artifactMcpServerSpec({
		version: 1,
		runId: "run",
		taskId: "task",
		manifestPath: "/run/tasks/task/source-manifest.json",
		ledgerPath: "/run/tasks/task/read-ledger.jsonl",
		accessMode: "workflow-task",
		runDir: "/run",
	});
	const other = { name: "other", command: "/bin/other", args: ["x"] };
	const launch = {
		toolProviders: {
			workflow_artifact: { classification: "read-only", mcpServer: server },
			other: { classification: "read-only", mcpServer: other },
		},
		artifactBinding: { serverSpec: server },
	};
	for (const { id, probe, serverLimit } of EXECUTORS) {
		const { summary } = await probeWorkflowExecutor(
			{ id, version: "1.0.0", module: "unused", config: null },
			{
				prober: async () => ({
					capabilities,
					probe: { installed: true, cliVersion: "1", auth: "ok", ...probe },
				}),
			},
		);
		assert.equal(summary.mcpOutputLimitChars, probe.mcpOutputLimitChars, id);
		assert.equal(summary.mcpOutputNoticeChars, probe.mcpOutputNoticeChars, id);
		const run = { capabilityNegotiation: { probe: summary } };
		assert.equal(artifactServerOutputLimitForRun(run), serverLimit, id);
		const servers = preparedMcpServers(launch, {
			artifactOutputLimitChars: artifactServerOutputLimitForRun(run),
		});
		assert.deepEqual(
			servers.map((entry) => entry.name),
			["other", "workflow_artifact"],
		);
		assert.deepEqual(servers[0], other, "other servers are untouched");
		assert.deepEqual(servers[1], {
			...server,
			args: [...server.args, "--max-output-chars", String(serverLimit)],
		});
	}
	// No recorded limit (pre-WP5b run, executor without one): spec unchanged, server default.
	const { summary } = await probeWorkflowExecutor(
		{ id: "fake", version: "1.0.0", module: "unused", config: null },
		{
			prober: async () => ({
				capabilities,
				probe: { installed: true, cliVersion: "1", auth: "ok" },
			}),
		},
	);
	assert.equal("mcpOutputLimitChars" in summary, false);
	assert.equal("mcpOutputNoticeChars" in summary, false);
	for (const run of [{}, { capabilityNegotiation: { probe: summary } }]) {
		assert.equal(artifactServerOutputLimitForRun(run), null);
		assert.deepEqual(
			preparedMcpServers(launch, {
				artifactOutputLimitChars: artifactServerOutputLimitForRun(run),
			})[1],
			{ ...server, args: [...server.args] },
		);
	}
});

test("launch provenance digests the server spec with the limit actually launched", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "aw-wp5b-limit-"));
	const saved = {
		[AGENT_WORKFLOW_HOME_ENV]: process.env[AGENT_WORKFLOW_HOME_ENV],
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		[HOST_CONTEXT_ENV]: process.env[HOST_CONTEXT_ENV],
	};
	process.env[AGENT_WORKFLOW_HOME_ENV] = join(root, "home", ".agent-workflow");
	process.env.PI_CODING_AGENT_DIR = join(root, "home", ".pi", "agent");
	delete process.env[HOST_CONTEXT_ENV];
	t.after(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const cwd = join(root, "project");
	const agents = join(cwd, ".agent-workflow", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(agents, "scout.md"),
		"---\ndescription: scout\ntools: [read]\nreadOnly: true\n---\n# scout\n",
	);
	const compiled = await compileWorkflow(
		{
			schemaVersion: 1,
			name: "wp5b-limit",
			defaults: { agent: "scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "A" },
					{ id: "b", type: "single", prompt: "B", from: "a" },
				],
			},
		},
		{ cwd, task: "t" },
	);
	const { run } = await createRunRecord(cwd, compiled, join(cwd, "spec.json"));
	const task = run.tasks[1];
	const prepared = await prepareDagTask(cwd, run, compiled, 1);
	const server = prepared.runtime.toolProviders.workflow_artifact.mcpServer;
	const launch = {
		extensions: [],
		generatedExtensions: [],
		captureToolCalls: false,
		resourcePolicy: resolveWorkflowResourcePolicy(prepared),
	};
	const digest = async () =>
		(
			await createLaunchBootstrapProvenance(
				cwd,
				run,
				task,
				prepared,
				"unit",
				launch,
			)
		).artifacts.serverSpecSha256;
	const launched = () =>
		preparedMcpServers(
			{
				toolProviders: prepared.runtime.toolProviders,
				artifactBinding: { serverSpec: server },
			},
			{ artifactOutputLimitChars: artifactServerOutputLimitForRun(run) },
		).find((entry) => entry.name === "workflow_artifact");

	// No recorded limit: the digest is the plain spec, as before WP5b.
	const plain = await digest();
	assert.equal(plain, sha256Canonical(server));
	assert.equal(plain, sha256Canonical(launched()));

	for (const { id, probe, serverLimit } of EXECUTORS) {
		run.capabilityNegotiation = {
			probe: { installed: true, cliVersion: "1", auth: "ok", ...probe },
		};
		const spec = launched();
		assert.deepEqual(spec.args.slice(-2), [
			"--max-output-chars",
			String(serverLimit),
		]);
		const limited = await digest();
		assert.equal(limited, sha256Canonical(spec), id);
		assert.notEqual(limited, plain, id);
	}
});
