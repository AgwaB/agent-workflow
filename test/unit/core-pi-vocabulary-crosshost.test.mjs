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
	WorkflowCapabilityError,
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
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
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
		/is a google model; claude cannot run it \(use the pi executor/,
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
	assert.match(
		resolveExecutorModel("pi", "opus", piList).refused,
		/Pi names Claude models "anthropic\/claude-…", not the Claude Code alias "opus"/,
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
