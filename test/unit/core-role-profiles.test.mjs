// New in agent-workflow (WP31 item 1): role-level profiles. A role is how a model-backed stage is
// addressed (`agent:<name>` > its `profileRole` > `default`); a profile maps roles to
// {executor?, model?, effort?}. Precedence per field: run flag > per-workflow preference > workflow-
// declared profile > saved user profile > default (WP37 extended to roles). Validation names the
// bad role, field or executor.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";
import { collectWorkflowRoleSlots } from "../../dist/core/execution-profile.js";
import {
	modelListed,
	parseRoleAssignmentText,
	parseWorkflowRoleMap,
	probeModelList,
	resolveStageRoleAssignments,
	roleKeysForSlot,
} from "../../dist/core/role-profiles.js";

const SPEC = {
	schemaVersion: 1,
	name: "wp31-roles",
	defaults: { agent: "reader" },
	artifactGraph: {
		stages: [
			{ id: "plan", type: "single", profileRole: "planning", prompt: "p" },
			{
				id: "scan",
				type: "foreach",
				profileRole: "research-execution",
				from: "plan",
				each: { agent: "scout", prompt: "s" },
			},
			{
				id: "verify",
				type: "single",
				profileRole: "verification",
				agent: "checker",
				prompt: "v",
				from: "scan",
			},
			{ id: "plain", type: "single", prompt: "x", from: "verify" },
		],
	},
};

const slots = () => collectWorkflowRoleSlots(SPEC);
const primary = { id: "pi", source: "host-default" };

test("roles address stages by agent, then profileRole, then default", () => {
	const bySlot = Object.fromEntries(slots().map((slot) => [slot.id, slot]));
	assert.deepEqual(roleKeysForSlot(bySlot.plan), [
		"agent:reader",
		"planning",
		"default",
	]);
	assert.deepEqual(roleKeysForSlot(bySlot.scan), [
		"agent:scout",
		"research-execution",
		"default",
	]);
	assert.deepEqual(roleKeysForSlot(bySlot.verify), [
		"agent:checker",
		"verification",
		"default",
	]);
	assert.deepEqual(roleKeysForSlot(bySlot.plain), ["agent:reader", "default"]);
});

test("inside one layer the most specific role key wins; unlisted roles use default", () => {
	const resolved = resolveStageRoleAssignments({
		slots: slots(),
		primary,
		layers: [
			{
				tier: "user-profile",
				name: "mine",
				roles: {
					default: { executor: "claude", model: "sonnet" },
					verification: { executor: "codex", model: "gpt-5.6-luna" },
					"agent:checker": { effort: "high" },
				},
			},
		],
	});
	assert.equal(resolved.stages.plan.executor, "claude");
	assert.equal(resolved.stages.plan.role, "default");
	assert.equal(resolved.stages.plan.model, "sonnet");
	assert.equal(resolved.stages.verify.executor, "codex");
	assert.equal(resolved.stages.verify.role, "verification");
	assert.equal(resolved.stages.verify.model, "gpt-5.6-luna");
	assert.equal(resolved.stages.verify.effort, "high");
	assert.equal(resolved.mixed, true);
	assert.deepEqual(resolved.executors.sort(), ["claude", "codex", "pi"]);
	assert.deepEqual(resolved.overrides.verify, {
		model: "gpt-5.6-luna",
		effort: "high",
	});
});

test("precedence per field: run flag > preference > declared > saved > default", () => {
	const layers = [
		{
			tier: "workflow-preference",
			name: "wp31-roles",
			roles: { verification: { effort: "max" } },
		},
		{
			tier: "workflow-profile",
			name: "declared",
			executor: "claude",
			roles: { "research-execution": { executor: "codex", model: "decl" } },
			stageOverrides: { plan: { model: "authored-by-profile" } },
		},
		{
			tier: "user-profile",
			name: "mine",
			executor: "pi",
			roles: {
				planning: { executor: "claude", model: "saved-plan" },
				verification: { executor: "claude", effort: "low", model: "v" },
				default: { model: "saved-default" },
			},
		},
	];
	const resolved = resolveStageRoleAssignments({
		slots: slots(),
		primary,
		layers,
	});
	// Executor: the declared flat executor beats the saved role entry (higher layer has a value).
	assert.equal(resolved.stages.plan.executor, "claude");
	assert.equal(resolved.stages.plan.source, "workflow-profile");
	assert.equal(resolved.stages.scan.executor, "codex");
	assert.equal(resolved.stages.scan.role, "research-execution");
	// Model: the declared profile's stage override wins over every lower role entry.
	assert.equal(resolved.stages.plan.model, undefined);
	assert.equal(resolved.overrides.plan, undefined);
	assert.equal(resolved.stages.scan.model, "decl");
	// Effort: the preference wins; the model comes from the saved profile (executor matches).
	assert.equal(resolved.stages.verify.effort, "max");
	assert.equal(resolved.stages.verify.model, "v");
	// A saved entry for another executor does not lend its model.
	assert.equal(resolved.stages.plain.model, "saved-default");

	const flagged = resolveStageRoleAssignments({
		slots: slots(),
		primary,
		runFlagExecutor: "codex",
		layers,
	});
	for (const stage of Object.values(flagged.stages)) {
		assert.equal(stage.executor, "codex");
		assert.equal(stage.source, "run-flag");
	}
	// verification's saved model belongs to claude, so it is not applied on codex; the saved
	// `default` entry names no executor and applies.
	assert.equal(flagged.stages.verify.model, "saved-default");
	assert.equal(flagged.stages.verify.effort, "max");
	assert.equal(flagged.mixed, true, "every stage on codex, run default pi");
});

test("no layer decides: stages stay on the run's executor and nothing is mixed", () => {
	const resolved = resolveStageRoleAssignments({
		slots: slots(),
		primary,
		layers: [
			{
				tier: "user-profile",
				name: "mine",
				roles: { default: { effort: "low" } },
			},
		],
	});
	assert.equal(resolved.mixed, false);
	assert.deepEqual(
		new Set(Object.values(resolved.executorBySlot)),
		new Set(["pi"]),
	);
	assert.equal(resolved.stages.plan.source, "host-default");
});

test("dynamic decision-loop slots follow their stage's executor (with a warning)", () => {
	const spec = {
		schemaVersion: 1,
		name: "dyn",
		artifactGraph: {
			stages: [
				{
					id: "d",
					type: "dynamic",
					profileRole: "planning",
					prompt: "d",
					dynamic: {
						uses: "x.mjs",
						decisionLoop: {
							verifier: { agent: "checker", profileRole: "verification" },
						},
					},
				},
			],
		},
	};
	const resolved = resolveStageRoleAssignments({
		slots: collectWorkflowRoleSlots(spec),
		primary,
		layers: [
			{
				tier: "user-profile",
				name: "mine",
				roles: {
					planning: { executor: "claude" },
					verification: { executor: "codex", model: "m" },
				},
			},
		],
	});
	assert.equal(resolved.stages.d.executor, "claude");
	assert.equal(resolved.stages["d.$verifier"].executor, "claude");
	assert.equal(resolved.stages["d.$verifier"].source, "parent-stage");
	assert.equal(resolved.stages["d.$verifier"].model, undefined);
	assert.match(resolved.warnings[0], /d\.\$verifier.*claude, not codex/);
});

test("validation names bad roles, fields and values", () => {
	assert.deepEqual(
		parseWorkflowRoleMap(
			{ default: { executor: "codex" }, "agent:scout": { model: "m" } },
			"roles",
		),
		{ default: { executor: "codex" }, "agent:scout": { model: "m" } },
	);
	assert.throws(
		() => parseWorkflowRoleMap({ reviewer: { executor: "codex" } }, "roles"),
		/unknown role "reviewer"; use default, planning, research-execution, synthesis, verification, final-judgment or agent:<name>/,
	);
	assert.throws(
		() => parseWorkflowRoleMap({ planning: { exec: "codex" } }, "roles"),
		/roles\.planning: unknown field "exec"/,
	);
	assert.throws(
		() => parseWorkflowRoleMap({ planning: { effort: "huge" } }, "roles"),
		/roles\.planning: effort must be one of/,
	);
	assert.throws(
		() => parseWorkflowRoleMap({ planning: {} }, "roles"),
		/sets none of executor, model, effort/,
	);
	assert.deepEqual(parseRoleAssignmentText("verification=claude:haiku:high"), [
		"verification",
		{ executor: "claude", model: "haiku", effort: "high" },
	]);
	assert.deepEqual(parseRoleAssignmentText("synthesis=:sonnet"), [
		"synthesis",
		{ model: "sonnet" },
	]);
	assert.deepEqual(parseRoleAssignmentText("default=codex::low"), [
		"default",
		{ executor: "codex", effort: "low" },
	]);
	assert.throws(
		() => parseRoleAssignmentText("verification"),
		/must be <role>=/,
	);
	assert.throws(() => parseRoleAssignmentText("x=claude"), /unknown role "x"/);
});

test("spec executionProfileRoles is validated against declared profiles", () => {
	const base = {
		schemaVersion: 1,
		name: "s",
		executionProfiles: { mixed: {} },
		artifactGraph: { stages: [{ id: "a", type: "single", prompt: "a" }] },
	};
	parseArtifactGraphWorkflowSpec({
		...base,
		executionProfileRoles: {
			mixed: { verification: { executor: "claude", model: "haiku" } },
		},
	});
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...base,
				executionProfileRoles: { other: { default: { executor: "codex" } } },
			}),
		/executionProfileRoles\.other.*unknown execution profile "other"/s,
	);
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...base,
				executionProfileRoles: { mixed: { boss: { executor: "codex" } } },
			}),
		/unknown role "boss"/,
	);
});

test("probe model lists: notes or a models array; null when the probe cannot tell", () => {
	assert.deepEqual(probeModelList({ notes: ["x", "models: a, b"] }), [
		"a",
		"b",
	]);
	assert.equal(probeModelList({ notes: ["models: not listable"] }), null);
	assert.equal(probeModelList({ notes: [] }), null);
	assert.deepEqual(probeModelList({ models: ["p/m"] }), ["p/m"]);
	assert.equal(modelListed("m", ["p/m"]), true);
	assert.equal(modelListed("p/m", ["m"]), true);
	assert.equal(modelListed("sonnet", ["default", "haiku"]), false);
});
