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
import { executorModelId } from "../../dist/core/executor-model-id.js";
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

test("models: Pi provider prefixes are translated for the CLI that owns them, foreign ones refused or noted before launch", async () => {
	assert.deepEqual(executorModelId("codex", "openai-codex/gpt-6.1-sol"), {
		model: "gpt-6.1-sol",
	});
	assert.deepEqual(executorModelId("codex", "gpt-6.1-sol"), {
		model: "gpt-6.1-sol",
	});
	// A Codex custom provider (OpenRouter, a gateway) may legitimately use provider/… ids.
	assert.deepEqual(executorModelId("codex", "anthropic/claude-opus-5-5"), {
		model: "anthropic/claude-opus-5-5",
	});
	assert.deepEqual(executorModelId("claude", "anthropic/claude-opus-5-5"), {
		model: "claude-opus-5-5",
	});
	assert.match(
		executorModelId("claude", "google/gemini-3.5-flash").refused,
		/provider google, which Claude Code cannot run/,
	);
	// Bedrock ARNs are not provider prefixes.
	const arn = "arn:aws:bedrock:us-east-1:1:application-inference-profile/x";
	assert.deepEqual(executorModelId("claude", arn), { model: arn });
	assert.deepEqual(executorModelId("pi", "anthropic/claude-opus-5-5"), {
		model: "anthropic/claude-opus-5-5",
	});

	const cwd = await project();
	const openai = await compile(
		cwd,
		spec({ tools: ["read"] }, { model: "openai-codex/gpt-6.1-sol" }),
	);
	await assert.rejects(
		() => negotiate(openai, "claude"),
		(error) => {
			assert(error instanceof WorkflowCapabilityError);
			assert.match(
				error.message,
				/a\.main: executor claude: model "openai-codex\/gpt-6\.1-sol" belongs to provider openai-codex, which Claude Code cannot run; run it on the pi executor or assign this stage another executor/,
			);
			return true;
		},
	);
	await negotiate(openai, "codex"); // translated at submit
	const anthropic = await compile(
		cwd,
		spec({ tools: ["read"] }, { model: "anthropic/claude-opus-5-5" }),
	);
	await negotiate(anthropic, "claude");
	const onCodex = await negotiate(anthropic, "codex", {
		models: ["gpt-6.1-sol"],
	});
	assert.ok(
		onCodex.notices.some((notice) =>
			/model "anthropic\/claude-opus-5-5" for a\.main looks like a Pi provider id; executor codex does not list it/.test(
				notice,
			),
		),
		JSON.stringify(onCodex.notices),
	);
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
		/provider google, which Claude Code cannot run/,
	);
});
