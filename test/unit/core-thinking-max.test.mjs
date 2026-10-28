// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/thinking-max.test.mjs. MIT, same author. Changes: imports from dist/core; the run/dynamic parsers come from dist/hosts/args (moved from extension.ts in WP11a) and report usage errors as "Invalid effort level … Supported: …, xhigh, max" (was "… xhigh, max"); the Pi executor's `--thinking` levels include max as well (PI_EFFORT_LEVELS).
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

test("max is the highest workflow thinking level", () => {
	assert.deepEqual(THINKING_LEVELS, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	assert.deepEqual([...PI_EFFORT_LEVELS], [...THINKING_LEVELS]);
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
	assert.throws(() =>
		parseArtifactGraphWorkflowSpec(workflow({ thinking: "ultra" })),
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
	assert.throws(
		() => parseWorkflowRunArgs('run review "Fix the thing" --thinking ultra'),
		/xhigh, max/,
	);
});
