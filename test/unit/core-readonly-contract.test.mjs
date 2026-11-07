// Authored readOnly intent still drives compilation, scheduling and records. Executor enforcement
// and capability negotiation are safe-only (owner decision 2026-11-06).
// Engine runs use a fixture; adapter settings use pure builders. No model/agent-CLI calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const { workflowTaskApprovalPolicy } = await import(
	"../../dist/core/task-runner.js"
);
const { workflowTaskRequirementContext } = await import(
	"../../dist/core/capability-negotiation.js"
);
const { prepareWorkflowTaskToolPolicy } = await import(
	"../../dist/core/tool-policy.js"
);
const claude = await import("../../dist/executors/claude/index.js");
const codex = await import("../../dist/executors/codex/index.js");
const pi = await import("../../dist/executors/pi/index.js");
const sdk = await import("../../dist/sdk/index.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12d1-ro-")));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR ??= join(root, "run-index");
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

let counter = 0;
async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "writer.md"),
		[
			"---",
			"name: writer",
			"description: writer",
			"tools: read, grep, bash, edit",
			"---",
			"You do the task and report.",
			"",
		].join("\n"),
	);
	return cwd;
}

function spec(tools, extra = {}) {
	return {
		schemaVersion: 1,
		name: "wp12d1-read-only",
		defaults: { agent: "writer", worktreePolicy: "off" },
		artifactGraph: {
			stages: [
				{
					id: "a",
					type: "single",
					readOnly: true,
					tools,
					prompt: "Collect facts.",
					...extra,
				},
			],
		},
	};
}

function fixture() {
	counter += 1;
	const id = `wf-wp12d1-${counter}`;
	const effectLog = join(root, `${id}-effects.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(workflowFixtureDescriptor({ id, effectLog })),
	);
	return { id, effectLog };
}

/** The request the adapters would see, rebuilt from the fixture's submit log entry. */
function adapterRequest(submit) {
	const attemptKey = "wp12d1-ro";
	return {
		attemptKey,
		authority: sdk.createAuthorityGate({ attemptKey }).authority,
		cwd: "/tmp",
		prompt: "hi",
		tools: submit.tools,
		readOnly: submit.readOnly,
		permissionMode: submit.permissionMode,
		mcpServers: submit.mcpServers.map((name) => ({
			name,
			command: "node",
			args: [],
		})),
		deadlineMs: Date.now() + 1000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: sdk.defaultApprovalPolicy(),
	};
}

for (const mode of ["free", "safe"]) {
	test(`#1 ${mode}: declared readOnly + bash compiles to read-only tools and adapters enforce only in safe`, async () => {
		const cwd = await project();
		const compiled = await compileWorkflow(spec(["read", "bash"]), {
			cwd,
			task: "t",
			permissionMode: mode,
		});
		const [task] = compiled.tasks;
		assert.deepEqual(task.runtime.tools, ["read"]);
		assert.equal(task.safety.readOnlyDeclared, true);
		assert.equal(task.safety.capability, "read-only");
		assert.equal(task.safety.requiresWorktree, false);
		assert.ok(
			compiled.warnings.some(
				(w) =>
					/stage "a" declares readOnly: true/.test(w) &&
					/removed .*bash/.test(w),
			),
			JSON.stringify(compiled.warnings),
		);

		const { id, effectLog } = fixture();
		const path = join(cwd, "workflow.json");
		await writeFile(path, JSON.stringify(spec(["read", "bash"])));
		const started = await engine.runWorkflowSpec(path, cwd, {
			task: "t",
			executor: id,
			permissionMode: mode,
		});
		const stage = started.capabilityNegotiation.stages[0];
		assert.equal(
			stage.report.entries.some((entry) => entry.key === "readOnly"),
			mode === "safe",
			"readOnly is negotiated only in safe",
		);
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		assert.equal(run.status, "completed", JSON.stringify(run.tasks));
		const [submit] = readFixtureLog(effectLog).filter(
			(entry) => entry.type === "submit",
		);
		assert.equal(submit.permissionMode, mode);
		assert.equal(submit.readOnly, true);
		assert.ok(!submit.tools.includes("bash"));
		assert.ok(!submit.approvalAllowKinds.includes("execute"));

		const req = adapterRequest(submit);
		// Claude: no bypassPermissions; mutating tools disallowed.
		const invocation = claude.buildClaudeInvocation(
			req,
			claude.parseClaudeConfig({ stateDir: join(root, "claude-state") }),
			{ mcpConfigPath: join(root, "mcp.json") },
		);
		if (mode === "safe") {
			assert.equal(invocation.permissionMode, "default");
			assert.ok(!invocation.argv.includes("bypassPermissions"));
			assert.ok(invocation.argv.includes("--disallowedTools"));
		} else {
			assert.equal(invocation.permissionMode, "bypassPermissions");
			assert.ok(!invocation.argv.includes("--disallowedTools"));
			assert.match(stage.report.notes.join(), /readOnly is not enforced/);
		}
		// Codex: read-only sandbox, on-request approvals (never danger-full-access/never).
		const codexPlan = codex.planCodexTools(
			req.tools,
			req.readOnly,
			req.permissionMode,
		);
		if (mode === "safe") {
			assert.equal(codexPlan.sandbox, "read-only");
			assert.equal(codexPlan.approvalPolicy, "on-request");
		} else {
			assert.equal(codexPlan.sandbox, "danger-full-access");
			assert.equal(codexPlan.approvalPolicy, "never");
		}
		// Pi: the allowlist is the enforcement; no mutating tool reaches --tools.
		assert.deepEqual(pi.readOnlyTools(req.tools).dropped, []);
	});
}

test("#1 a declared-readOnly stage whose every tool mutates is refused at compile", async () => {
	const cwd = await project();
	await assert.rejects(
		compileWorkflow(spec(["bash", "edit"]), { cwd, task: "t" }),
		(error) =>
			error instanceof core.WorkflowValidationError &&
			/declares readOnly: true .*no read-only tool remains/s.test(
				JSON.stringify(error.issues ?? error.message),
			),
	);
});

test("#1 the authored contract survives a mutation-capable classification (inherited host tools, old records)", async () => {
	const cwd = await project();
	const compiled = await compileWorkflow(spec(["read"]), { cwd, task: "t" });
	// Inherited host tools reclassify the task mutation-capable; the authored readOnly still wins.
	const inherited = prepareWorkflowTaskToolPolicy(compiled.tasks[0], {
		inheritHostTools: true,
		permissionMode: "free",
	});
	assert.equal(inherited.safety.capability, "mutation-capable");
	assert.equal(inherited.safety.readOnlyDeclared, true);
	const policy = { interactive: false, allowUnverified: [], strict: [] };
	assert.equal(
		workflowTaskRequirementContext(inherited, {
			...policy,
			allowReadOnlyDowngrade: false,
			permissionMode: "free",
		}).readOnly,
		true,
	);
	// A record compiled before the fix: readOnly declared, bash kept.
	const legacy = {
		...compiled.tasks[0],
		runtime: { ...compiled.tasks[0].runtime, tools: ["read", "bash"] },
		safety: { ...compiled.tasks[0].safety, capability: "mutation-capable" },
	};
	assert.ok(!workflowTaskApprovalPolicy(legacy).allowKinds.includes("execute"));
	assert.ok(
		!workflowTaskApprovalPolicy(legacy, false, "safe").allowKinds.includes(
			"execute",
		),
	);
	assert.ok(
		workflowTaskApprovalPolicy(legacy, false, "free").allowKinds.includes(
			"execute",
		),
	);
});
