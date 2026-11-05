// New in agent-workflow (WP4a): pins the port adaptations listed in
// core-port record (PI_WORKFLOW_* -> AGENT_WORKFLOW_* env names and the
// .pi/ -> .agent-workflow/ project path) so they cannot silently regress.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	DIRECT_DYNAMIC_RUNTIME_VERSION,
	ensureDirectDynamicRuntimeBundle,
} from "../../dist/core/dynamic-runtime-bundle.js";
import {
	CACHE_SHAPE_METRICS_ENV,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_DEPTH_ROUTER_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	enabledWorkflowExperimentalSpeedFlags,
	PER_ITEM_DISPATCH_ENV,
} from "../../dist/core/experimental-speed-flags.js";
import {
	AGENT_WORKFLOW_ROLE_ENV,
	assertWorkflowToolAllowedForRole,
	getWorkflowProcessRole,
	workflowWorkerEnvPrefix,
} from "../../dist/core/process-role.js";
import {
	assertPromptSchemaDiagnosticsAllowRun,
	STRICT_PROMPT_SCHEMA_ENV,
} from "../../dist/core/prompt-schema-diagnostics.js";

test("experimental speed flags read AGENT_WORKFLOW_* env names only", () => {
	assert.deepEqual(
		[
			EXPERIMENTAL_TOOL_DEDUP_ENV,
			EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
			EXPERIMENTAL_LAUNCH_RAMP_ENV,
			CACHE_SHAPE_METRICS_ENV,
			EXPERIMENTAL_DEPTH_ROUTER_ENV,
			EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
			PER_ITEM_DISPATCH_ENV,
		],
		[
			"AGENT_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP",
			"AGENT_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH",
			"AGENT_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP",
			"AGENT_WORKFLOW_CACHE_SHAPE_METRICS",
			"AGENT_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER",
			"AGENT_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR",
			"AGENT_WORKFLOW_PER_ITEM_DISPATCH",
		],
	);
	assert.deepEqual(
		enabledWorkflowExperimentalSpeedFlags({
			PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP: "1",
			AGENT_WORKFLOW_PER_ITEM_DISPATCH: "true",
		}),
		["AGENT_WORKFLOW_PER_ITEM_DISPATCH"],
	);
});

test("process role reads AGENT_WORKFLOW_ROLE and ignores the old Pi name", () => {
	assert.equal(AGENT_WORKFLOW_ROLE_ENV, "AGENT_WORKFLOW_ROLE");
	assert.equal(workflowWorkerEnvPrefix(), "AGENT_WORKFLOW_ROLE=worker");
	assert.equal(
		getWorkflowProcessRole({ AGENT_WORKFLOW_ROLE: "worker" }),
		"worker",
	);
	assert.equal(
		getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "worker" }),
		"supervisor",
	);
	assert.throws(
		() => assertWorkflowToolAllowedForRole({ AGENT_WORKFLOW_ROLE: "disabled" }),
		/AGENT_WORKFLOW_ROLE=disabled/,
	);
});

test("strict prompt-schema gate reads AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA", () => {
	assert.equal(STRICT_PROMPT_SCHEMA_ENV, "AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA");
	const diagnostics = [
		{ code: "x", message: "blocking", strictBlocking: true },
	];
	assert.doesNotThrow(() =>
		assertPromptSchemaDiagnosticsAllowRun(diagnostics, {
			PI_WORKFLOW_STRICT_PROMPT_SCHEMA: "1",
		}),
	);
	assert.throws(
		() =>
			assertPromptSchemaDiagnosticsAllowRun(diagnostics, {
				AGENT_WORKFLOW_STRICT_PROMPT_SCHEMA: "1",
			}),
		/Strict prompt\/schema validation rejected/,
	);
});

test("direct dynamic runtime bundle lives under .agent-workflow/workflow-runtime", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "core-runtime-bundle-"));
	try {
		const specPath = await ensureDirectDynamicRuntimeBundle(cwd);
		const bundleDir = join(
			cwd,
			".agent-workflow",
			"workflow-runtime",
			DIRECT_DYNAMIC_RUNTIME_VERSION,
		);
		assert.equal(specPath, join(bundleDir, "spec.json"));
		assert.ok(existsSync(join(bundleDir, "controller.mjs")));
		assert.equal(existsSync(join(cwd, ".pi")), false);
		// Second call accepts the immutable files already on disk.
		assert.equal(await ensureDirectDynamicRuntimeBundle(cwd), specPath);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
