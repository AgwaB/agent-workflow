import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAgentMarkdown } from "../../dist/core/agents.js";
import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";
import { THINKING_LEVELS } from "../../dist/core/types.js";
import {
	clampSupportedThinkingLevel,
	getSupportedThinkingLevels,
} from "../../dist/core/workflow-runtime.js";
import { PI_EFFORT_LEVELS } from "../../dist/executors/pi/argv.js";
import {
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../dist/hosts/args.js";

function workflow(stage = {}) {
	return {
		schemaVersion: 1,
		name: "thinking-max-test",
		defaults: { agent: "scout", tools: ["read"], readOnly: true },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Inspect.", ...stage }],
		},
	};
}

test("max is Pi's highest thinking level; the workflow vocabulary adds Codex's ultra above it", () => {
	assert.deepEqual(THINKING_LEVELS, [
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
		THINKING_LEVELS.filter((level) => level !== "ultra"),
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
	assert.ok(getSupportedThinkingLevels(gen6).includes("max"));
	assert.equal(getSupportedThinkingLevels(xhighOnly).includes("max"), false);
	assert.equal(
		clampSupportedThinkingLevel(getSupportedThinkingLevels(xhighOnly), "max"),
		"xhigh",
	);
	assert.ok(getSupportedThinkingLevels(undefined).includes("max"));
});

test("specs, agent frontmatter, and launch arguments accept max", () => {
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(workflow({ thinking: "max" })),
	);
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(workflow({ thinking: "ultra" })),
	);
	assert.throws(() =>
		parseArtifactGraphWorkflowSpec(workflow({ thinking: "extreme" })),
	);
	const agent = parseAgentMarkdown(
		"---\ndescription: Deep\nthinking: max\n---\nBody",
		"deep.md",
		"project",
	);
	assert.equal(agent.thinking, "max");
	assert.equal(
		parseWorkflowRunArgs('run review "Fix the thing" --thinking max').thinking,
		"max",
	);
	assert.equal(
		parseWorkflowDynamicArgs(
			'dynamic --thinking max "Research adaptive workflows"',
		).thinking,
		"max",
	);
	assert.equal(
		parseWorkflowRunArgs('run review "Fix the thing" --thinking ultra')
			.thinking,
		"ultra",
	);
	assert.throws(
		() => parseWorkflowRunArgs('run review "Fix the thing" --thinking extreme'),
		/xhigh, max, ultra/,
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
