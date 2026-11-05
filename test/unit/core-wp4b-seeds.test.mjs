// New in agent-workflow (WP4b): pins the six Pi-seed replacements, the
// legacy read-only discovery (F5), the R#5/D2 worktree rule and the artifact
// provenance digests described in core-port record.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverAgents, loadAgentByName } from "../../dist/core/agents.js";
import {
	ARTIFACT_ACCESS_CONFIG_FILE,
	artifactAccessConfigBytes,
	artifactMcpServerSpec,
	canonicalArtifactAccessJson,
} from "../../dist/core/artifact-access.js";
import { prepareDagTask } from "../../dist/core/artifact-graph-runtime.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	resolveWorkflowFastModeConfig,
	WORKFLOW_FAST_SERVICE_TIER,
} from "../../dist/core/fast-tier.js";
import {
	AGENT_WORKFLOW_HOME_ENV,
	agentWorkflowHome,
} from "../../dist/core/home-dir.js";
import {
	createHostContext,
	HOST_CONTEXT_ENV,
	resolveHostContext,
	withHostContext,
} from "../../dist/core/host-context.js";
import { createLaunchBootstrapProvenance } from "../../dist/core/launch-bootstrap-provenance.js";
import { resolveWorkflowResourcePolicy } from "../../dist/core/resource-inheritance.js";
import {
	createRunRecord,
	readRunRecord,
	workflowsRoot,
	writeRunRecord,
} from "../../dist/core/store.js";
import {
	registerWorkflowBackend,
	resolveWorkflowBackend,
} from "../../dist/core/task-launch.js";
import {
	applyWorkflowToolPolicy,
	prepareWorkflowTaskToolPolicy,
} from "../../dist/core/tool-policy.js";
import {
	listWorkflows,
	resolveWorkflowRef,
} from "../../dist/core/workflow-specs.js";

const ENV_KEYS = [
	AGENT_WORKFLOW_HOME_ENV,
	"PI_CODING_AGENT_DIR",
	HOST_CONTEXT_ENV,
];

async function scratch(t, prefix) {
	const root = await mkdtemp(join(tmpdir(), `agent-workflow-wp4b-${prefix}-`));
	const saved = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	);
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
	await mkdir(cwd, { recursive: true });
	return { root, cwd };
}

async function writeAgent(dir, name, fields = "tools: [read]\nreadOnly: true") {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\n${fields}\n---\n# ${name}\n`,
	);
}

function spec(stage, defaults = {}) {
	return {
		schemaVersion: 1,
		name: "wp4b-fixture",
		defaults: { agent: "scout", ...defaults },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Do it.", ...stage }],
		},
	};
}

function sha256Canonical(value) {
	return createHash("sha256")
		.update(canonicalArtifactAccessJson(value))
		.digest("hex");
}

test("home-dir: AGENT_WORKFLOW_HOME overrides ~/.agent-workflow; Pi dir is legacy only", () => {
	assert.equal(agentWorkflowHome({}), join(homedir(), ".agent-workflow"));
	assert.equal(
		agentWorkflowHome({ AGENT_WORKFLOW_HOME: "/x/home" }),
		"/x/home",
	);
	assert.equal(
		agentWorkflowHome({ PI_CODING_AGENT_DIR: "/x/pi" }),
		join(homedir(), ".agent-workflow"),
	);
});

test("host-context: explicit boundary, null freeze and env fallback", async (t) => {
	const { cwd } = await scratch(t, "host");
	const context = createHostContext({ cwd, projectTrusted: true });
	assert.deepEqual(Object.keys(context).sort(), [
		"cwd",
		"homeDir",
		"projectTrusted",
		"version",
	]);
	assert.equal(context.homeDir, process.env[AGENT_WORKFLOW_HOME_ENV]);
	assert.equal(resolveHostContext(), undefined);
	assert.deepEqual(
		withHostContext(context, () => resolveHostContext()),
		context,
	);
	process.env[HOST_CONTEXT_ENV] = JSON.stringify(context);
	assert.deepEqual(resolveHostContext(), context);
	assert.equal(
		withHostContext(null, () => resolveHostContext()),
		undefined,
	);
	process.env[HOST_CONTEXT_ENV] = JSON.stringify({
		...context,
		agentDir: "/x",
	});
	assert.throws(() => resolveHostContext(), /Invalid workflow host context/);
});

test("store records the launching host context, not Pi-native tools", async (t) => {
	const { cwd } = await scratch(t, "store-host");
	await writeAgent(join(cwd, ".agent-workflow", "agents"), "scout");
	const compiled = await compileWorkflow(
		spec({}, { readOnly: true, tools: ["read"] }),
		{ cwd },
	);
	const context = createHostContext({ cwd, projectTrusted: false });
	const { run } = await withHostContext(context, () =>
		createRunRecord(cwd, compiled, join(cwd, "spec.json")),
	);
	assert.deepEqual(run.hostContext, context);
	assert.equal(Object.hasOwn(run, "nativeHost"), false);
	assert.equal(Object.hasOwn(run, "inheritHostTools"), false);
	assert.equal(workflowsRoot(cwd), join(cwd, ".agent-workflow", "workflows"));
	assert.equal(
		existsSync(join(cwd, ".agent-workflow", "workflows", run.runId)),
		true,
	);
	assert.equal(existsSync(join(cwd, ".pi")), false);
});

test("tool-policy: host tools are an explicit flag; core never adds Pi-native tool names", () => {
	assert.deepEqual(applyWorkflowToolPolicy(["read"], undefined), {
		tools: ["read"],
	});
	assert.deepEqual(
		applyWorkflowToolPolicy(undefined, undefined, { inheritHostTools: true }),
		{
			tools: ["read", "bash", "edit", "write"],
			inheritHostTools: true,
		},
	);
	assert.deepEqual(
		applyWorkflowToolPolicy([], undefined, { inheritHostTools: true }),
		{
			tools: [],
			inheritHostTools: false,
		},
	);
	const task = {
		kind: "single",
		runtime: { approvalMode: "on-request", tools: ["read"] },
		safety: {
			readOnlyDeclared: true,
			capability: "read-only",
			sharedCwdSafe: true,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
	};
	assert.equal(prepareWorkflowTaskToolPolicy(task), task);
	const prepared = prepareWorkflowTaskToolPolicy(task, {
		inheritHostTools: true,
		// WP4e: R#5 (worktree despite spec "off") is safe-mode behavior.
		permissionMode: "safe",
	});
	assert.deepEqual(prepared.runtime.tools, ["read"]);
	assert.equal(prepared.runtime.inheritHostTools, true);
	assert.equal(prepared.safety.capability, "mutation-capable");
	assert.equal(prepared.safety.requiresWorktree, true);
	assert.equal(prepared.safety.permission.statusDetail, "pending_approval");
});

test("compile: inheritHostTools is a host option that makes the task mutation-capable", async (t) => {
	const { cwd } = await scratch(t, "inherit");
	await writeAgent(join(cwd, ".agent-workflow", "agents"), "scout");
	const plain = await compileWorkflow(
		spec({}, { readOnly: true, tools: ["read"] }),
		{ cwd },
	);
	assert.equal(
		Object.hasOwn(plain.tasks[0].runtime, "inheritHostTools"),
		false,
	);
	assert.equal(plain.tasks[0].safety.capability, "read-only");
	const inherited = await compileWorkflow(
		spec({}, { readOnly: false, tools: ["read"] }),
		{
			cwd,
			inheritHostTools: true,
		},
	);
	assert.equal(inherited.inheritHostTools, true);
	assert.deepEqual(inherited.tasks[0].runtime.tools, ["read"]);
	assert.equal(inherited.tasks[0].runtime.inheritHostTools, true);
	assert.equal(inherited.tasks[0].safety.capability, "mutation-capable");
	assert.equal(inherited.tasks[0].safety.requiresWorktree, true);
	// WP35: a declared readOnly stage never inherits the mutation-capable host tools.
	const readOnly = await compileWorkflow(
		spec({}, { readOnly: true, tools: ["read"] }),
		{ cwd, inheritHostTools: true },
	);
	assert.equal(readOnly.tasks[0].runtime.inheritHostTools, false);
	assert.equal(readOnly.tasks[0].safety.capability, "read-only");
});

test("R#5: readOnly task with worktreePolicy off runs without a worktree", async (t) => {
	const { cwd } = await scratch(t, "r5-readonly");
	await writeAgent(join(cwd, ".agent-workflow", "agents"), "scout");
	const compiled = await compileWorkflow(
		spec({ worktreePolicy: "off" }, { readOnly: true, tools: ["read"] }),
		{ cwd, permissionMode: "safe" },
	);
	const { safety } = compiled.tasks[0];
	assert.equal(safety.worktreePolicy, "off");
	assert.equal(safety.sharedCwdSafe, true);
	assert.equal(safety.requiresWorktree, false);
	assert.equal(Object.hasOwn(safety, "allowSharedCheckoutWrites"), false);
	assert.equal(
		compiled.warnings.some((w) => w.includes("worktreePolicy")),
		false,
	);
});

test("R#5: write-capable task with spec worktreePolicy off still requires a worktree and warns", async (t) => {
	const { cwd } = await scratch(t, "r5-write");
	await writeAgent(
		join(cwd, ".agent-workflow", "agents"),
		"scout",
		"tools: [read, edit, write]",
	);
	const compiled = await compileWorkflow(
		spec({ worktreePolicy: "off" }, { tools: ["read", "edit"] }),
		{ cwd, permissionMode: "safe" },
	);
	const { safety } = compiled.tasks[0];
	assert.equal(safety.worktreePolicy, "off");
	assert.equal(safety.sharedCwdSafe, false);
	assert.equal(safety.requiresWorktree, true);
	assert.equal(Object.hasOwn(compiled, "allowSharedCheckoutWrites"), false);
	assert.ok(
		compiled.warnings.some(
			(w) =>
				w.includes('stage "main" sets worktreePolicy: "off" but can write') &&
				w.includes("allowSharedCheckoutWrites"),
		),
		compiled.warnings.join("\n"),
	);
	// A spec cannot grant the waiver itself.
	const specGrant = await compileWorkflow(
		{
			...spec({ worktreePolicy: "off" }, { tools: ["read", "edit"] }),
			allowSharedCheckoutWrites: true,
		},
		{ cwd, permissionMode: "safe" },
	).then(
		(value) => value.tasks[0].safety.requiresWorktree,
		() => "rejected",
	);
	assert.notEqual(specGrant, false);
});

test("R#5: the executing user's allowSharedCheckoutWrites option waives it and is recorded in the run", async (t) => {
	const { cwd } = await scratch(t, "r5-option");
	await writeAgent(
		join(cwd, ".agent-workflow", "agents"),
		"scout",
		"tools: [read, edit, write]",
	);
	const compiled = await compileWorkflow(
		spec({ worktreePolicy: "off" }, { tools: ["read", "edit"] }),
		{ cwd, allowSharedCheckoutWrites: true, permissionMode: "safe" },
	);
	const { safety } = compiled.tasks[0];
	assert.equal(safety.requiresWorktree, false);
	assert.equal(safety.allowSharedCheckoutWrites, true);
	assert.equal(compiled.allowSharedCheckoutWrites, true);
	assert.equal(
		compiled.warnings.some((w) => w.includes("can write")),
		false,
	);
	const { run } = await createRunRecord(cwd, compiled, join(cwd, "spec.json"));
	assert.equal(run.allowSharedCheckoutWrites, true);
	await writeRunRecord(cwd, run);
	assert.equal(
		(await readRunRecord(cwd, run.runId)).allowSharedCheckoutWrites,
		true,
	);
	// The option never weakens an explicit "auto"/"on" policy.
	const auto = await compileWorkflow(spec({}, { tools: ["read", "edit"] }), {
		cwd,
		allowSharedCheckoutWrites: true,
		permissionMode: "safe",
	});
	assert.equal(auto.tasks[0].safety.requiresWorktree, true);
	assert.equal(
		Object.hasOwn(auto.tasks[0].safety, "allowSharedCheckoutWrites"),
		false,
	);
});

test("Pi's directories are not read (2026-10-30, replaces F5): only agent-workflow locations and bundled", async (t) => {
	const { root, cwd } = await scratch(t, "legacy");
	const specBody = JSON.stringify(
		spec({}, { readOnly: true, tools: ["read"] }),
	);
	const legacyProject = join(cwd, ".pi", "workflows");
	const legacyUser = join(root, "home", ".pi", "agent", "workflows");
	const newProject = join(cwd, ".agent-workflow", "workflows");
	await mkdir(legacyProject, { recursive: true });
	await mkdir(legacyUser, { recursive: true });
	await mkdir(newProject, { recursive: true });
	await writeFile(join(legacyProject, "pi-only.json"), specBody);
	await writeFile(join(legacyUser, "pi-user.json"), specBody);
	await writeFile(join(newProject, "both.json"), specBody);
	await writeFile(join(legacyProject, "both.json"), specBody);

	await assert.rejects(() => resolveWorkflowRef("pi-only", cwd));
	await assert.rejects(() => resolveWorkflowRef("pi-user", cwd));
	const both = await resolveWorkflowRef("both", cwd);
	assert.equal(both.specPath, join(newProject, "both.json"));
	const listed = (await listWorkflows(cwd)).map((record) => record.name);
	assert.ok(listed.includes("both"));
	assert.ok(!listed.includes("pi-only") && !listed.includes("pi-user"));
	// An explicit path still works (the user chose the file).
	const byPath = await resolveWorkflowRef(
		join(legacyProject, "pi-only.json"),
		cwd,
	);
	assert.equal(byPath.specPath, join(legacyProject, "pi-only.json"));

	await writeAgent(join(cwd, ".pi", "agents"), "legacy-agent");
	await writeAgent(
		join(root, "home", ".pi", "agent", "agents"),
		"legacy-user-agent",
	);
	await writeAgent(join(root, "home", ".agent-workflow", "agents"), "mine");
	assert.equal(await loadAgentByName("legacy-agent", cwd), undefined);
	assert.equal(await loadAgentByName("legacy-user-agent", cwd), undefined);
	assert.equal((await loadAgentByName("mine", cwd)).scope, "user");
	const registry = await discoverAgents(cwd);
	assert.equal(registry.byAlias.has("legacy-agent"), false);
	assert.equal(registry.byAlias.has("legacy-user-agent"), false);
	assert.equal(registry.byAlias.get("mine")?.scope, "user");
});

test("artifact access: canonical config, MCP server spec, and provenance digests", async (t) => {
	const { cwd } = await scratch(t, "artifact");
	await writeAgent(join(cwd, ".agent-workflow", "agents"), "scout");
	const compiled = await compileWorkflow(
		{
			schemaVersion: 1,
			name: "artifact-fixture",
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
	const taskDir = join(cwd, task.files.result, "..");
	assert.equal(
		existsSync(join(taskDir, "workflow-artifact-extension.ts")),
		false,
	);
	const configPath = join(taskDir, ARTIFACT_ACCESS_CONFIG_FILE);
	const config = JSON.parse(await readFile(configPath, "utf8"));
	assert.deepEqual(Object.keys(config).sort(), [
		"accessMode",
		"ledgerPath",
		"manifestPath",
		"runDir",
		"runId",
		"taskId",
		"version",
	]);
	assert.equal(
		await readFile(configPath, "utf8"),
		artifactAccessConfigBytes(config),
	);
	const server = artifactMcpServerSpec(config);
	assert.equal(server.name, "workflow_artifact");
	assert.equal(server.command, process.execPath);
	assert.match(
		server.args[0],
		/[/\\]dist[/\\]mcp[/\\]artifact-server[/\\]server\.js$/,
	);
	assert.deepEqual(server.args.slice(1), ["--config", configPath]);
	assert.deepEqual(prepared.runtime.tools, ["read", "workflow_artifact"]);
	assert.deepEqual(prepared.runtime.toolProviders.workflow_artifact, {
		classification: "read-only",
		mcpServer: { ...server, args: [...server.args] },
	});

	const launch = {
		captureToolCalls: false,
		resourcePolicy: resolveWorkflowResourcePolicy(prepared),
	};
	const record = await createLaunchBootstrapProvenance(
		cwd,
		run,
		task,
		prepared,
		"unit",
		launch,
	);
	assert.deepEqual(Object.keys(record.artifacts).sort(), [
		"configSha256",
		"manifestSha256",
		"serverSpecSha256",
	]);
	assert.equal(record.artifacts.configSha256, sha256Canonical(config));
	assert.equal(record.artifacts.serverSpecSha256, sha256Canonical(server));
	assert.deepEqual(record.effectivePolicy.tools, ["read", "workflow_artifact"]);
	assert.equal(
		Object.hasOwn(record.effectivePolicy, "inheritHostTools"),
		false,
	);

	await writeFile(
		configPath,
		(await readFile(configPath, "utf8")).replace(
			"workflow-task",
			"human-debug",
		),
	);
	await assert.rejects(
		createLaunchBootstrapProvenance(cwd, run, task, prepared, "unit", launch),
		/artifact access binding is invalid/,
	);
});

test("task-launch: backends are registered by WP4c, not hard-wired to pi-subagent", () => {
	const run = { backend: { type: "local-pi", mode: "headless" } };
	assert.throws(
		() => resolveWorkflowBackend(run),
		/Unsupported workflow backend: local-pi\/headless/,
	);
	const backend = { id: "unit" };
	const unregister = registerWorkflowBackend(run.backend, backend);
	assert.equal(resolveWorkflowBackend(run), backend);
	unregister();
	assert.throws(
		() => resolveWorkflowBackend(run),
		/Unsupported workflow backend/,
	);
});

test("fast-tier: pure config resolution for capability fastTier", () => {
	assert.equal(
		resolveWorkflowFastModeConfig({ fast: "off", model: "openai/gpt-5.5" }),
		undefined,
	);
	assert.deepEqual(
		resolveWorkflowFastModeConfig({
			fast: "on",
			model: "openai-codex/gpt-5.5",
			api: "openai-codex-responses",
		}),
		{
			provider: "openai-codex",
			model: "gpt-5.5",
			api: "openai-codex-responses",
			serviceTier: WORKFLOW_FAST_SERVICE_TIER,
		},
	);
	assert.throws(
		() =>
			resolveWorkflowFastModeConfig({ fast: "on", model: "anthropic/claude" }),
		/fast:on is not supported/,
	);
});
