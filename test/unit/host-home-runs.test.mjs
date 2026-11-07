import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-04 (Claude desktop app: its MCP server starts in ~, and three runs were
// recorded in ~/.agent-workflow/workflows, the user-level workflow folder): a directory whose
// .agent-workflow is the user-level home is never a project. The CLI, the MCP server and the Pi host
// record such runs in <home>/home-runs and run workers there. Fakes only; no model or agent CLI.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const projectRoot = await import("../../dist/hosts/project-root.js");
const cli = await import("../../dist/hosts/cli/index.js");
const mcpTools = await import("../../dist/mcp/host-server/tools.js");
const ext = await import("../../dist/hosts/pi/extension.js");
const core = await import("../../dist/core/index.js");
const slots = await import("../../dist/core/launch-slots.js");

slots.setWorkerLaunchControlsForTests({
	releaseDelayMs: 0,
	retryJitterMs: 0,
});
const roots = [];
const unregister = [];
after(() => {
	for (const undo of unregister.splice(0)) undo();
	for (const dir of roots)
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
});

/** A fake ~ (with the user-level home in it) and a project beside it. */
function layout() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "aw-home-runs-")));
	roots.push(base);
	const home = join(base, "home");
	const userHome = join(home, ".agent-workflow");
	mkdirSync(userHome, { recursive: true });
	const project = join(home, "proj");
	mkdirSync(join(project, ".git"), { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: userHome };
	return {
		home,
		userHome,
		project,
		env,
		homeRuns: join(userHome, "home-runs"),
	};
}

/** Recording host API: every action records the ctx.cwd it got. */
function recordingApi(seen) {
	return new Proxy(
		{},
		{
			get(_, name) {
				if (typeof name !== "string") return undefined;
				if (name === "registerTestExecutorFromEnv")
					return async () => undefined;
				if (!name.endsWith("Action")) return undefined;
				return async (ctx) => {
					seen.push({ name, cwd: ctx.cwd });
					return {
						action: name,
						ok: true,
						outcome: "success",
						text: "ok",
						data: { runs: [] },
					};
				};
			},
		},
	);
}

test("runProject: the directory holding the user-level home maps to <home>/home-runs; others stay", () => {
	const { home, userHome, project, env, homeRuns } = layout();
	assert.equal(projectRoot.holdsUserHome(home, env), true);
	assert.equal(projectRoot.runProject(home, env), homeRuns);
	assert.ok(existsSync(homeRuns));
	assert.equal(projectRoot.runProject(project, env), project);
	assert.equal(projectRoot.runProject(homeRuns, env), homeRuns);
	// With another user-level home (AGENT_WORKFLOW_HOME elsewhere), ~ is an ordinary directory.
	assert.equal(
		projectRoot.runProject(home, {
			...env,
			AGENT_WORKFLOW_HOME: join(home, "other"),
		}),
		home,
	);
	void userHome;
});

test("CLI in ~: the run is recorded in home-runs (not in the user-level workflow folder), with a notice", async () => {
	const { home, userHome, env, homeRuns } = layout();
	const executor = "test-home-runs-cli";
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: executor,
				effectLog: join(home, "effects.jsonl"),
			}),
		),
	);
	const spec = join(home, "wf.json");
	writeFileSync(
		spec,
		JSON.stringify({
			schemaVersion: 1,
			name: "home-runs-check",
			// A bundled agent: user agents are read from process.env (~), not from this fake home.
			defaults: { agent: "scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(
		["run", spec, "task", "--executor", executor],
		{
			cwd: home,
			env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY: false,
		},
	);
	assert.equal(code, 0, out.join("") + err.join(""));
	assert.match(
		err.join(""),
		/holds the user-level agent-workflow home, so it is not a project; workers run in .*home-runs; run state is stored under .*projects/,
	);
	const recorded = readdirSync(
		join(stateDir(homeRuns), ".agent-workflow", "workflows"),
	).filter((name) => name.startsWith("workflow_"));
	assert.equal(recorded.length, 1);
	const userWorkflows = join(userHome, "workflows");
	assert.ok(
		!existsSync(userWorkflows) ||
			readdirSync(userWorkflows).every((name) => !name.startsWith("workflow_")),
	);
	// From a real project nothing changes.
	assert.equal(
		projectRoot.runProject(join(home, "proj"), env),
		join(home, "proj"),
	);
});

test("MCP server started in ~: every tool call works in home-runs; an explicit project below ~ is kept", async () => {
	const { home, project, env, homeRuns } = layout();
	const seen = [];
	const service = mcpTools.createHostMcpService({
		root: home,
		host: "generic",
		env,
		api: recordingApi(seen),
	});
	const call = {
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		signal: new AbortController().signal,
		sendRequest: async () => ({}),
		sendNotification: async () => undefined,
	};
	await service.call("workflow_status", {}, call);
	await service.call("workflow_status", { cwd: "proj" }, call);
	assert.deepEqual(
		seen.map((row) => row.cwd),
		[homeRuns, project],
	);
});

test("Pi session in ~: /aw handlers get home-runs as ctx.cwd; a project session is unchanged", async () => {
	const { home, project, env, homeRuns } = layout();
	const seen = [];
	const commands = new Map();
	ext.createAgentWorkflowPiExtension({ api: recordingApi(seen), env })({
		registerCommand: (name, options) => commands.set(name, options),
		registerTool() {},
		on: () => () => undefined,
		getThinkingLevel: () => "medium",
	});
	const ctx = (cwd) => ({
		cwd,
		hasUI: true,
		mode: "rpc",
		model: { provider: "test", id: "test" },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify() {},
			confirm: async () => true,
			select: async () => undefined,
		},
	});
	await commands.get("aw").handler("status", ctx(home));
	await commands.get("aw").handler("status", ctx(project));
	assert.deepEqual(
		seen.filter((row) => row.name === "statusAction").map((row) => row.cwd),
		[homeRuns, project],
	);
});
