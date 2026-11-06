import { stateDir } from "../helpers/state-dir.mjs";
// Host-tool inheritance is recorded separately from the effective tool list.
// Read-only stages and empty tool lists never inherit; the Pi executor expands host tools.
// Runtime prompts use executor-visible tool names; system-prompt.md keeps canonical text.
import { readFile } from "node:fs/promises";
import {
	assert,
	artifactGraphWorkflowSpec,
	compileWorkflow,
	join,
	launchSubagentTask,
	makeProject,
	setTaskRuntimeApiForTests,
	test,
	writeAgent,
} from "../helpers/unit-test-support.mjs";
import { createRunRecord } from "../helpers/unit-test-support.mjs";
import {
	prepareArtifactGraphRetryTask,
	prepareDagTask,
} from "../../dist/core/artifact-graph-runtime.js";
import { prepareSubagentTaskLaunch } from "../../dist/core/task-backend.js";
import { createLaunchBootstrapProvenance } from "../../dist/core/launch-bootstrap-provenance.js";
import {
	createHostContext,
	withHostContext,
} from "../../dist/core/host-context.js";
import { renderWorkerPromptToolNames } from "../../dist/core/artifact-tool-names.js";

for (const native of [false, true]) {
	for (const empty of [false, true]) {
		for (const noArtifacts of [false, true]) {
			for (const retry of [false, true]) {
				test(`sealed prompt parity: native=${native}, empty=${empty}, artifacts=${!noArtifacts}, retry=${retry}`, async () => {
					const cwd = makeProject();
					writeAgent(cwd, "unit-scout", "read");
					const spec = artifactGraphWorkflowSpec();
					spec.defaults.worktreePolicy = "off";
					// WP35: only a writable stage inherits the host's tools.
					if (native) spec.defaults.readOnly = false;
					spec.artifactGraph.stages[0].tools = empty ? [] : ["read"];
					if (noArtifacts)
						spec.artifactGraph.stages[0].inputPolicy = {
							artifactAccess: "none",
						};
					const hostContext = native
						? createHostContext({ cwd, projectTrusted: true })
						: null;
					const compiled = await compileWorkflow(spec, {
						cwd,
						// Inherited host tools make the stage mutation-capable. Free mode honors
						// spec worktreePolicy off; safe mode requires a worktree.
						...(native
							? { inheritHostTools: true, permissionMode: "free" }
							: {}),
					});
					const original = JSON.stringify(compiled);
					const { run } = await withHostContext(hostContext, () =>
						createRunRecord(cwd, compiled, join(cwd, "spec.json")),
					);
					const task = run.tasks[0];
					let preparedTask = await prepareDagTask(cwd, run, compiled, 0);
					if (retry) {
						task.outputRetry = {
							attempts: 1,
							message: "offline malformed-output fixture",
						};
						preparedTask = await prepareArtifactGraphRetryTask(
							cwd,
							task,
							preparedTask,
						);
						assert.match(
							preparedTask.compiledPrompt,
							/Workflow Output Retry Instructions/,
						);
					}
					const prepared = await prepareSubagentTaskLaunch(
						cwd,
						run,
						task,
						preparedTask,
					);
					// WP35: host tools are only lent to the pi executor; the run records its executor at
					// first launch (the default fixture "pi" here), so the pre-launch check names it.
					const provenance = await createLaunchBootstrapProvenance(
						cwd,
						{ ...run, executor: { ...(run.executor ?? {}), id: "pi" } },
						task,
						preparedTask,
						"agent-workflow/runtime",
						prepared,
					);
					const expected = [
						...(empty ? [] : ["read"]),
						...(noArtifacts ? [] : ["workflow_artifact"]),
					];
					assert.deepEqual(
						new Set(provenance.effectivePolicy.tools),
						new Set(expected),
					);
					assert.equal(
						provenance.effectivePolicy.inheritHostTools === true,
						native && !empty,
					);
					assert.equal(Object.hasOwn(prepared, "generatedExtensions"), false);
					let captured;
					setTaskRuntimeApiForTests({
						async runSubagent(options) {
							captured = options;
							return {
								runId: "run_prompt_fixture",
								attemptId: "attempt_prompt_fixture",
								status: "running",
							};
						},
						async getSubagentStatus() {
							return null;
						},
						async reconcileSubagentRun() {
							return {};
						},
						async interruptSubagent() {
							return {};
						},
					});
					try {
						const launched = await launchSubagentTask(
							cwd,
							run,
							task,
							preparedTask,
							undefined,
							undefined,
							prepared,
						);
						assert.equal(launched.kind, "launched", JSON.stringify(launched));
						const canonical = await readFile(
							join(stateDir(cwd), task.files.systemPrompt),
							"utf8",
						);
						const policyLine = canonical
							.split("\n")
							.find((line) =>
								/^(Only these (workflow )?tools|No (workflow )?tools)/.test(
									line,
								),
							);
						const tools = provenance.effectivePolicy.tools;
						// WP39b (O8): a task that inherits the host tools names them as available and
						// calls its own list "workflow tools".
						const hostTools = native && !empty;
						const kind = hostTools ? "workflow tools" : "tools";
						assert.equal(
							policyLine,
							tools.length
								? `Only these ${kind} are enabled for this workflow task: ${tools.join(", ")}.`
								: `No ${kind} are enabled for this workflow task.`,
						);
						assert.equal(
							/^Host tools inherited from the Pi session are also available: codemode, tool_search, mcp__\*/m.test(
								canonical,
							),
							hostTools,
						);
						assert.equal(
							captured.systemPrompt,
							renderWorkerPromptToolNames(canonical, captured.executor.id),
						);
						assert.equal(
							captured.executor.config?.inheritHostTools === true,
							native && !empty,
						);
						assert.equal(JSON.stringify(compiled), original);
					} finally {
						setTaskRuntimeApiForTests(undefined);
					}
				});
			}
		}
	}
}
