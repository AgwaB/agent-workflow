import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";
import {
	applyExecutionProfileStageOverrides,
	collectWorkflowProfileStageSlots,
} from "../../dist/core/execution-profile.js";

function output() {
	return { analysis: { required: true }, refs: { required: true } };
}

function roleSpec(name = "role-profile") {
	return {
		schemaVersion: 1,
		name,
		defaults: { agent: "scout", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				stage("plan", "planning"),
				stage("research", "research-execution"),
				stage("synthesize", "synthesis"),
				stage("verify", "verification"),
				stage("judge", "final-judgment"),
			],
		},
	};
}

function stage(id, profileRole) {
	return {
		id,
		type: "single",
		profileRole,
		prompt: id,
		output: output(),
	};
}

test("profileRole validates independently from agent-context role", () => {
	const parsed = parseArtifactGraphWorkflowSpec({
		...roleSpec(),
		artifactGraph: {
			stages: [
				{
					...stage("plan", "planning"),
					role: "existing-agent-context-role",
				},
			],
		},
	});
	assert.equal(
		parsed.artifactGraph.stages[0].role,
		"existing-agent-context-role",
	);
	assert.equal(parsed.artifactGraph.stages[0].profileRole, "planning");

	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...roleSpec(),
				artifactGraph: {
					stages: [{ ...stage("bad", "stage-name-guess") }],
				},
			}),
		/profileRole.*must be one of/,
	);
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...roleSpec(),
				artifactGraph: {
					stages: [
						{
							id: "container",
							type: "dag",
							profileRole: "planning",
							stages: [stage("child", "research-execution")],
						},
					],
				},
			}),
		/only valid on model-backed/,
	);
	const dynamic = parseArtifactGraphWorkflowSpec({
		...roleSpec(),
		executionProfiles: {
			dynamic: {
				adaptive: { model: "worker/model", thinking: "medium" },
				"adaptive.$planner": { model: "planner/model", thinking: "high" },
			},
		},
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "research-execution",
					dynamic: {
						uses: "./helpers/controller.mjs",
						decisionLoop: {
							planner: { profileRole: "planning" },
						},
					},
				},
			],
		},
	});
	assert.equal(
		dynamic.artifactGraph.stages[0].profileRole,
		"research-execution",
	);
	assert.equal(
		dynamic.artifactGraph.stages[0].dynamic.decisionLoop.planner.profileRole,
		"planning",
	);
	assert.equal(
		dynamic.executionProfiles.dynamic.adaptive.model,
		"worker/model",
	);
	assert.equal(
		dynamic.executionProfiles.dynamic["adaptive.$planner"].model,
		"planner/model",
	);
});

test("canonical profile slots cover nested dag, loop exhaustion, foreach runtime, and dynamic decision profiles", () => {
	const spec = {
		schemaVersion: 1,
		name: "nested-profile-addresses",
		artifactGraph: {
			stages: [
				{
					id: "outer",
					type: "dag",
					stages: [stage("child", "research-execution")],
				},
				{
					id: "repeat",
					type: "loop",
					stages: [stage("step", "verification")],
					onExhausted: stage("fallback", "final-judgment"),
				},
				{
					id: "items",
					type: "foreach",
					profileRole: "research-execution",
					each: { prompt: "item" },
				},
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "research-execution",
					dynamic: {
						decisionLoop: {
							planner: { profileRole: "planning" },
							workerDefaults: { profileRole: "research-execution" },
							verifier: { profileRole: "verification" },
							synthesis: { profileRole: "synthesis" },
						},
					},
				},
			],
		},
	};
	assert.deepEqual(
		collectWorkflowProfileStageSlots(spec).map(({ id }) => id),
		[
			"outer.child",
			"repeat.step",
			"repeat.$onExhausted",
			"items",
			"adaptive",
			"adaptive.$planner",
			"adaptive.$workerDefaults",
			"adaptive.$verifier",
			"adaptive.$synthesis",
		],
	);
	const mapping = Object.fromEntries(
		collectWorkflowProfileStageSlots(spec).map(({ id }, index) => [
			id,
			{ model: `model/${index}`, thinking: "high" },
		]),
	);
	const applied = applyExecutionProfileStageOverrides(spec, mapping, {
		foreachRuntimeTarget: "each",
	});
	assert.equal(applied.artifactGraph.stages[0].stages[0].model, "model/0");
	assert.equal(applied.artifactGraph.stages[1].stages[0].model, "model/1");
	assert.equal(applied.artifactGraph.stages[1].onExhausted.model, "model/2");
	assert.equal(applied.artifactGraph.stages[2].each.model, "model/3");
	assert.equal(applied.artifactGraph.stages[3].model, "model/4");
	assert.equal(
		applied.artifactGraph.stages[3].dynamic.decisionLoop.planner.model,
		"model/5",
	);
	assert.equal(
		applied.artifactGraph.stages[3].dynamic.decisionLoop.synthesis.model,
		"model/8",
	);
	assert.equal(spec.artifactGraph.stages[2].each.model, undefined);
});
