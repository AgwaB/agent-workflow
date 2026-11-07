import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAgentMarkdown } from "../../dist/core/agents.js";
import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";
import { EFFORT_LEVELS } from "../../dist/core/types.js";
import {
	clampSupportedEffortLevel,
	getSupportedEffortLevels,
} from "../../dist/core/workflow-runtime.js";
import { PI_EFFORT_LEVELS } from "../../dist/executors/pi/argv.js";
import {
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../dist/hosts/args.js";

function workflow(stage = {}) {
	return {
		schemaVersion: 1,
		name: "effort-max-test",
		defaults: { agent: "scout", tools: ["read"], readOnly: true },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Inspect.", ...stage }],
		},
	};
}

test("max is Pi's highest effort level; the workflow vocabulary adds Codex's ultra above it", () => {
	assert.deepEqual(EFFORT_LEVELS, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		// 2026-10-30: Codex's top level; mapped to max for Pi/Claude and models without it.
		"ultra",
	]);
	assert.deepEqual(
		[...PI_EFFORT_LEVELS],
		EFFORT_LEVELS.filter((level) => level !== "ultra"),
	);
});

test("max is offered only when the model maps it, mirroring pi-ai", () => {
	const gen6 = {
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	};
	const xhighOnly = { reasoning: true, thinkingLevelMap: { xhigh: "max" } };
	assert.ok(getSupportedEffortLevels(gen6).includes("max"));
	assert.equal(getSupportedEffortLevels(xhighOnly).includes("max"), false);
	assert.equal(
		clampSupportedEffortLevel(getSupportedEffortLevels(xhighOnly), "max"),
		"xhigh",
	);
	assert.ok(getSupportedEffortLevels(undefined).includes("max"));
});

test("specs, agent frontmatter, and launch arguments accept max", () => {
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(workflow({ effort: "max" })),
	);
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(workflow({ effort: "ultra" })),
	);
	assert.throws(() =>
		parseArtifactGraphWorkflowSpec(workflow({ effort: "extreme" })),
	);
	const agent = parseAgentMarkdown(
		"---\ndescription: Deep\neffort: max\n---\nBody",
		"deep.md",
		"project",
	);
	assert.equal(agent.effort, "max");
	assert.equal(
		parseWorkflowRunArgs('run review "Fix the thing" --effort max').effort,
		"max",
	);
	assert.equal(
		parseWorkflowDynamicArgs(
			'dynamic --effort max "Research adaptive workflows"',
		).effort,
		"max",
	);
	assert.equal(
		parseWorkflowRunArgs('run review "Fix the thing" --effort ultra').effort,
		"ultra",
	);
	assert.throws(
		() => parseWorkflowRunArgs('run review "Fix the thing" --effort extreme'),
		/xhigh, max, ultra/,
	);
});

test("the old thinking name is rejected with a pointer to effort", async () => {
	const { normalizeDynamicAgentRequest } = await import(
		"../../dist/core/dynamic-generated-task-runtime.js"
	);
	const unknownField = (spec, path) =>
		assert.throws(
			() => parseArtifactGraphWorkflowSpec(spec),
			(error) =>
				error.issues?.some(
					(issue) =>
						issue.path === path &&
						issue.message === 'unknown field; use "effort"',
				),
			path,
		);
	unknownField(
		workflow({ thinking: "high" }),
		"$.artifactGraph.stages[0].thinking",
	);
	unknownField(
		{ ...workflow(), defaults: { ...workflow().defaults, thinking: "high" } },
		"$.defaults.thinking",
	);
	unknownField(
		{
			...workflow(),
			executionProfiles: { quick: { main: { thinking: "low" } } },
		},
		"$.executionProfiles.quick.main.thinking",
	);
	assert.throws(
		() =>
			parseAgentMarkdown(
				"---\ndescription: Deep\nthinking: max\n---\nBody",
				"deep.md",
				"project",
			),
		/unknown field; use "effort"/,
	);
	for (const option of ["--thinking", "--reasoning"])
		assert.throws(
			() => parseWorkflowRunArgs(`run review "Fix the thing" ${option} max`),
			new RegExp(`Unknown workflow option ${option}`),
			option,
		);
	assert.throws(
		() =>
			normalizeDynamicAgentRequest({
				id: "worker",
				prompt: "Inspect.",
				thinking: "high",
			}),
		/ctx\.agent\(\) thinking is not supported; use "effort"/,
	);
});

test("an unknown option after known ones is named, not the first known one; a misplaced one says so", () => {
	for (const args of [
		"run review --executor codex --bogus",
		'run review "Fix it" --effort high --bogus',
		"run --bogus review task",
	])
		assert.throws(
			() => parseWorkflowRunArgs(args),
			/^HostUsageError: Unknown workflow option --bogus;|Unknown workflow option --bogus;/,
			args,
		);
	assert.throws(
		() => parseWorkflowRunArgs("run review task --executor codex more words"),
		/Misplaced workflow option --executor: put options before the workflow or after the task/,
	);
	assert.throws(
		() => parseWorkflowDynamicArgs("dynamic --executor codex research --bogus"),
		/Unknown workflow option --bogus;/,
	);
});
