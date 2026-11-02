// Pi vocabulary reaching non-Pi executors (2026-10-30, Codex deep-research finding). A legacy
// `~/.pi/agent` agent or workflow shadows/joins the bundled ones on every host, and carries Pi's
// names: pi-workflow web tools (`workflow_web_*`) and provider-qualified models
// (`openai-codex/…`, `anthropic/…`). These tests pin the cross-host contract:
// - authority: either web-tool vocabulary authorises the other (compile);
// - tools an executor cannot map are refused BEFORE the run starts (was: run started, earlier
//   stages spent model calls, then every web stage failed at submit);
// - Pi provider prefixes the executor's own CLI owns are dropped, foreign ones refused before
//   launch (claude) or noted (codex: a custom provider may serve them).
// No model or agent-CLI calls: fake probers and argv builders only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import {
	negotiateWorkflowRun,
	resolveGeneratedTaskNames,
	WorkflowCapabilityError,
	workflowTaskCapabilityLaunch,
} from "../../dist/core/capability-negotiation.js";
import {
	resolveExecutorEffort,
	resolveExecutorModel,
} from "../../dist/core/executor-model-id.js";
import { workflowExecutorRegistration } from "../../dist/core/index.js";
import {
	buildClaudeInvocation,
	CLAUDE_TOOL_MAPPING,
	claudeCapabilities,
	parseClaudeConfig,
} from "../../dist/executors/claude/index.js";
import { codexCapabilities } from "../../dist/executors/codex/capabilities.js";
import { CODEX_TOOL_MAPPING } from "../../dist/executors/codex/tools.js";
import { PI_EXECUTOR_TOOL_MAPPING } from "../../dist/executors/pi/argv.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";

const roots = [];
after(async () => {
	for (const dir of roots)
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
});

/** A project whose `researcher` is written for pi-workflow (as `~/.pi/agent/agents` is today). */
async function project() {
	const cwd = await mkdtemp(join(tmpdir(), "aw-pi-vocab-"));
	roots.push(cwd);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "researcher.md"),
		"---\nname: researcher\ndescription: pi researcher\ntools: read, grep, find, ls, bash, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read\n---\nResearch.\n",
	);
	return cwd;
}
const spec = (defaults, stage = {}) => ({
	schemaVersion: 1,
	name: "vocab-probe",
	description: "probe",
	defaults: { agent: "researcher", readOnly: true, ...defaults },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Research.", ...stage }],
	},
});
const compile = (cwd, value) =>
	compileWorkflow(value, { cwd, task: "probe", permissionMode: "free" });
/** A fresh copy of compiled tasks (negotiation writes resolved names into the ones it accepts). */
const compileSync = (compiled) => structuredClone(compiled);

const CAPABILITIES = {
	codex: () => codexCapabilities(),
	claude: () => claudeCapabilities("append"),
};
const MAPPINGS = {
	codex: CODEX_TOOL_MAPPING,
	claude: CLAUDE_TOOL_MAPPING,
	pi: PI_EXECUTOR_TOOL_MAPPING,
};
function negotiate(compiled, id, { mapping = true, models = null } = {}) {
	const descriptor = workflowExecutorRegistration(id).descriptor;
	return negotiateWorkflowRun({
		descriptor,
		compiled,
		policy: {
			interactive: false,
			allowUnverified: [],
			strict: [],
			allowReadOnlyDowngrade: true,
			permissionMode: "free",
		},
		prober: async () => ({
			probe: {
				installed: true,
				cliVersion: "1.0.0",
				auth: "ok",
				notes: [],
				...(models === null ? {} : { models, modelListComplete: false }),
			},
			capabilities: (CAPABILITIES[id] ?? CAPABILITIES.claude)(),
			...(mapping ? { toolMapping: MAPPINGS[id] } : {}),
		}),
	});
}

test("a pi-workflow researcher authorises the CLI web tools; the stage keeps the CLI names", async () => {
	const cwd = await project();
	const compiled = await compile(
		cwd,
		spec({ tools: ["read", "web_search", "fetch_content"] }),
	);
	assert.deepEqual(compiled.tasks[0].runtime.tools, [
		"read",
		"web_search",
		"fetch_content",
	]);
	for (const id of ["codex", "claude"]) await negotiate(compiled, id);
});

for (const id of ["codex", "claude", "pi"])
	test(`${id}: tools without a mapping are refused before the run starts (named, with the pi-workflow hint)`, async () => {
		const cwd = await project();
		// No stage tools: the stage inherits the pi-workflow agent's list (minus bash: readOnly).
		const compiled = await compile(cwd, spec({}));
		assert.deepEqual(compiled.tasks[0].runtime.tools, [
			"read",
			"grep",
			"find",
			"ls",
			"workflow_web_search",
			"workflow_web_fetch_source",
			"workflow_web_source_read",
		]);
		await assert.rejects(
			() => negotiate(compiled, id),
			(error) => {
				assert(error instanceof WorkflowCapabilityError);
				assert.equal(error.code, "CAPABILITY_REFUSED");
				assert.match(error.message, /the run was not started/);
				assert.match(
					error.message,
					new RegExp(
						`a\\.main: executor ${id} has no mapping for workflow_web_search, workflow_web_fetch_source, workflow_web_source_read \\(pi-workflow's web tools; agent-workflow uses web_search and fetch_content\\)`,
					),
				);
				return true;
			},
		);
	});

test("an adapter that declares no tool mapping is not checked (third-party adapters, recorded probes)", async () => {
	const cwd = await project();
	const compiled = await compile(cwd, spec({}));
	await negotiate(compiled, "codex", { mapping: false });
});

test("model names are the executor's: rewritten to its form, refused when it cannot run them, Pi ids resolved from its list", async () => {
	// codex
	assert.deepEqual(resolveExecutorModel("codex", "openai-codex/gpt-6.1-sol"), {
		value: "gpt-6.1-sol",
		changed: true,
	});
	assert.deepEqual(resolveExecutorModel("codex", "gpt-6.1-sol"), {
		value: "gpt-6.1-sol",
		changed: false,
	});
	assert.match(
		resolveExecutorModel("codex", "anthropic/claude-opus-5-5").refused,
		/is an Anthropic model; codex cannot run it \(use the claude executor for this stage/,
	);
	assert.match(resolveExecutorModel("codex", "opus").refused, /Anthropic/);
	assert.match(
		resolveExecutorModel("codex", "gpt-9", ["gpt-6.1-sol"], false).notice,
		/not in codex's model list/,
	);
	// claude
	assert.deepEqual(
		resolveExecutorModel("claude", "anthropic/claude-opus-5-5"),
		{
			value: "claude-opus-5-5",
			changed: true,
		},
	);
	assert.deepEqual(resolveExecutorModel("claude", "opus"), {
		value: "opus",
		changed: false,
	});
	assert.match(
		resolveExecutorModel("claude", "openai-codex/gpt-6.1-sol").refused,
		/is an OpenAI model; claude cannot run it \(use the codex executor/,
	);
	assert.match(
		resolveExecutorModel("claude", "google/gemini-3.5-flash").refused,
		/is a google model; claude cannot run it \(use the antigravity executor/,
	);
	// antigravity runs Google models only (agy_acp_server 1.4.5 offers Gemini): a Pi Google provider
	// id loses its prefix; OpenAI, Anthropic and other providers' names are refused before launch.
	for (const [model, value] of [
		["gemini-3.8-flash", "gemini-3.8-flash"],
		["google/gemini-3.8-flash", "gemini-3.8-flash"],
		["google-antigravity/gemini-4-argon", "gemini-4-argon"],
	])
		assert.equal(resolveExecutorModel("antigravity", model).value, value);
	for (const [model, vendor, other] of [
		["sonnet", "an Anthropic", "claude"],
		["anthropic/claude-opus-5-5", "an Anthropic", "claude"],
		["gpt-6.1-sol", "an OpenAI", "codex"],
		["openai-codex/gpt-6.1-sol", "an OpenAI", "codex"],
		["kimi/k3", "a kimi", "pi"],
	])
		assert.match(
			resolveExecutorModel("antigravity", model).refused,
			new RegExp(
				`is ${vendor} model; antigravity cannot run it \\(use the ${other} executor`,
			),
		);
	const arn = "arn:aws:bedrock:us-east-1:1:application-inference-profile/x";
	assert.deepEqual(resolveExecutorModel("claude", arn), {
		value: arn,
		changed: false,
	});
	// pi: bare ids are found in Pi's list (ChatGPT-login provider first for OpenAI models)
	const piList = [
		"openai/gpt-6.1-sol",
		"openai-codex/gpt-6.1-sol",
		"anthropic/claude-opus-5-5",
	];
	assert.deepEqual(resolveExecutorModel("pi", "gpt-6.1-sol", piList), {
		value: "openai-codex/gpt-6.1-sol",
		changed: true,
	});
	assert.deepEqual(resolveExecutorModel("pi", "claude-opus-5-5", piList), {
		value: "anthropic/claude-opus-5-5",
		changed: true,
	});
	// Pi resolves patterns ("opus", "sonnet") itself: noted, not refused.
	assert.match(
		resolveExecutorModel("pi", "opus", piList).notice,
		/not an exact Pi model id; Pi resolves it as a pattern/,
	);
	assert.match(
		resolveExecutorModel("pi", "gpt-6.1-sol", [
			"openrouter/gpt-6.1-sol",
			"azure/gpt-6.1-sol",
		]).refused,
		/offered by several Pi providers/,
	);
	assert.deepEqual(
		resolveExecutorModel("pi", "anthropic/claude-opus-5-5", piList),
		{ value: "anthropic/claude-opus-5-5", changed: false },
	);
	// effort
	assert.deepEqual(resolveExecutorEffort("codex", "minimal"), {
		value: "low",
		changed: true,
		notice: 'effort "minimal" is "low" on codex (it has no "minimal")',
	});
	assert.equal(resolveExecutorEffort("pi", "ultra").value, "max");
	// Per-model levels from the probe (Codex: luna has no "ultra"; Pi: a model without thinking).
	assert.deepEqual(
		resolveExecutorEffort("codex", "ultra", "gpt-6-luna", [
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]),
		{
			value: "max",
			changed: true,
			notice:
				'effort "ultra" is "max" for gpt-6-luna on codex (its levels: low, medium, high, xhigh, max)',
		},
	);
	assert.deepEqual(
		resolveExecutorEffort("codex", "high", "gpt-6-luna", ["low", "high"]),
		{ value: "high", changed: false },
	);
	assert.equal(
		resolveExecutorEffort("pi", "high", "x/no-thinking", ["off"]).value,
		"off",
	);
	assert.match(
		resolveExecutorEffort("claude", "turbo").refused,
		/effort "turbo" is not a claude level/,
	);

	// Before launch: the run's compiled tasks carry the executor's names; refusals stop the run.
	const cwd = await project();
	const openai = await compile(
		cwd,
		spec(
			{ tools: ["read"] },
			{ model: "openai-codex/gpt-6.1-sol", thinking: "minimal" },
		),
	);
	await negotiate(openai, "codex");
	assert.equal(openai.tasks[0].runtime.model, "gpt-6.1-sol");
	assert.equal(openai.tasks[0].runtime.thinking, "low");
	await assert.rejects(
		() => negotiate(compileSync(openai), "claude"),
		(error) => {
			assert(error instanceof WorkflowCapabilityError);
			assert.match(error.message, /the run was not started/);
			assert.match(
				error.message,
				/a\.main: executor claude: model "gpt-6\.1-sol" is an OpenAI model; claude cannot run it/,
			);
			return true;
		},
	);
	const anthropic = await compile(
		cwd,
		spec({ tools: ["read"] }, { model: "anthropic/claude-opus-5-5" }),
	);
	await assert.rejects(
		() => negotiate(anthropic, "codex"),
		/a\.main: executor codex: model "anthropic\/claude-opus-5-5" is an Anthropic model; codex cannot run it/,
	);
	assert.equal(anthropic.tasks[0].runtime.model, "anthropic/claude-opus-5-5");
	await negotiate(anthropic, "claude");
	assert.equal(anthropic.tasks[0].runtime.model, "claude-opus-5-5");
});

test("claude argv: anthropic/ is dropped, a foreign provider is refused before any effect", () => {
	const config = parseClaudeConfig({ stateDir: "/tmp/aw-pi-vocab-claude" });
	const req = (model) => ({
		attemptKey: "vocab-1",
		authority: createAuthorityGate({ attemptKey: "vocab-1" }).authority,
		cwd: "/tmp",
		prompt: "hi",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 1000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		model,
	});
	const { argv } = buildClaudeInvocation(
		req("anthropic/claude-opus-5-5"),
		config,
		{ mcpConfigPath: "/tmp/mcp.json" },
	);
	assert.equal(argv[argv.indexOf("--model") + 1], "claude-opus-5-5");
	assert.throws(
		() =>
			buildClaudeInvocation(req("google/gemini-3.5-flash"), config, {
				mcpConfigPath: "/tmp/mcp.json",
			}),
		/is a google model; claude cannot run it/,
	);
});

test("stages generated during a run (dynamic/auto) get the same tool, model and effort checks before submit", async () => {
	const cwd = await project();
	const compiled = await compile(cwd, spec({ tools: ["read", "web_search"] }));
	const negotiation = await negotiate(compiled, "codex", {
		models: ["gpt-6.1-sol", "gpt-6-luna"],
	});
	// The run records what its executor can name.
	assert.ok(negotiation.names.tools.includes("web_search"));
	assert.ok(!negotiation.names.tools.includes("workflow_web_search"));
	assert.deepEqual(negotiation.names.models, ["gpt-6.1-sol", "gpt-6-luna"]);
	const run = { capabilityNegotiation: negotiation };
	const generated = (patch) => {
		const task = structuredClone(compiled.tasks[0]);
		task.id = task.key = task.specId = "generated.w1";
		Object.assign(task.runtime, patch);
		return task;
	};
	// A pi-workflow tool name: refused before submit, with the reason.
	assert.throws(
		() =>
			workflowTaskCapabilityLaunch(
				run,
				generated({ tools: ["read", "workflow_web_search"] }),
			),
		(error) => {
			assert(error instanceof WorkflowCapabilityError);
			assert.match(
				error.message,
				/refused generated task generated\.w1 before launch:\n {2}✗ generated\.w1: executor codex has no mapping for workflow_web_search/,
			);
			return true;
		},
	);
	// A Claude model on codex: refused.
	assert.throws(
		() =>
			workflowTaskCapabilityLaunch(
				run,
				generated({ model: "anthropic/claude-opus-5-5" }),
			),
		/is an Anthropic model; codex cannot run it/,
	);
	// A Pi-qualified OpenAI id is rewritten for codex where the task is built (before its launch
	// is sealed); the launch-time check then only refuses, it never rewrites a sealed task.
	const ok = generated({
		model: "openai-codex/gpt-6.1-sol",
		thinking: "minimal",
	});
	const unconverted = structuredClone(ok);
	resolveGeneratedTaskNames(negotiation, ok, { apply: true });
	assert.equal(ok.runtime.model, "gpt-6.1-sol");
	assert.equal(ok.runtime.thinking, "low");
	workflowTaskCapabilityLaunch(run, ok);
	assert.ok(negotiation.stages.some((stage) => stage.label === "generated.w1"));
	workflowTaskCapabilityLaunch(run, unconverted);
	assert.equal(unconverted.runtime.model, "openai-codex/gpt-6.1-sol");
	// Refusals hold at both points.
	assert.throws(
		() =>
			resolveGeneratedTaskNames(
				negotiation,
				generated({ model: "anthropic/claude-opus-5-5" }),
				{ apply: true },
			),
		/is an Anthropic model; codex cannot run it/,
	);
});

test("model names: malformed ones are refused, case and stray spaces do not leak to the CLI, gemini is Google's", () => {
	for (const model of [
		"openai-codex/",
		"openai-codex//gpt-6.1-sol",
		"/gpt-6.1-sol",
		"  ",
	])
		assert.match(
			resolveExecutorModel("codex", model).refused ?? "",
			/is malformed \(write "model" or "provider\/model"\)/,
			model,
		);
	assert.deepEqual(resolveExecutorModel("codex", "OpenAI/gpt-6.1-sol"), {
		value: "gpt-6.1-sol",
		changed: true,
	});
	assert.deepEqual(resolveExecutorModel("codex", "gpt-6.1-sol "), {
		value: "gpt-6.1-sol",
		changed: true,
	});
	assert.deepEqual(
		resolveExecutorModel("claude", "ANTHROPIC/claude-opus-5-5"),
		{
			value: "claude-opus-5-5",
			changed: true,
		},
	);
	assert.match(
		resolveExecutorModel("codex", "gemini-3-pro").refused ?? "",
		/is a google model; codex cannot run it/,
	);
	assert.match(
		resolveExecutorModel("codex", "azure/gpt-6.1-sol").refused ?? "",
		/is an azure model/,
	);
	// Pi: a listed id in another case is the listed id; a nested provider id stays as is.
	const piList = ["openai-codex/gpt-6.1-sol", "openrouter/openai/gpt-5"];
	assert.deepEqual(
		resolveExecutorModel("pi", "OPENAI-CODEX/gpt-6.1-sol", piList),
		{ value: "openai-codex/gpt-6.1-sol", changed: true },
	);
	assert.deepEqual(
		resolveExecutorModel("pi", "openrouter/openai/gpt-5", piList),
		{
			value: "openrouter/openai/gpt-5",
			changed: false,
		},
	);
});

test("per-model effort: the nearest level the model has, the lower one on a tie", () => {
	const level = (effort, levels) =>
		resolveExecutorEffort("codex", effort, "m", levels).value;
	assert.equal(
		level("max", ["low", "ultra"]),
		"ultra",
		"one step up, not four down",
	);
	assert.equal(
		level("ultra", ["low", "medium", "high", "xhigh", "max"]),
		"max",
	);
	assert.equal(level("low", ["medium", "high"]), "medium");
	assert.equal(
		level("medium", ["low", "high"]),
		"low",
		"a tie goes to the cheaper level",
	);
	assert.equal(
		level("high", ["none", "auto"]),
		"high",
		"unknown level names are ignored",
	);
	assert.equal(level("high", []), "high");
});

test("a refusal's hint names launch options that exist (--executor, --profile mixed; --preset is only for profile set)", async () => {
	const { parseWorkflowRunArgs } = await import("../../dist/hosts/args.js");
	const refused = resolveExecutorModel(
		"codex",
		"anthropic/claude-opus-5-5",
	).refused;
	assert.match(
		refused,
		/--executor claude, or a role profile such as --profile mixed\)/,
	);
	assert.doesNotMatch(refused, /--preset/);
	const parsed = parseWorkflowRunArgs(
		"run wf.json task --executor claude --profile mixed",
	);
	assert.equal(parsed.executor, "claude");
	assert.equal(parsed.profile, "mixed");
	assert.throws(
		() => parseWorkflowRunArgs("run wf.json task --preset mixed"),
		/Unknown workflow option --preset/,
	);
});
