// test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { collectWorkflowRoleSlots } from "../../dist/core/execution-profile.js";
import { roleKeysForSlot } from "../../dist/core/role-profiles.js";
import { managementProject } from "../helpers/dashboard-management.mjs";
import { profileGraphFixtures } from "../helpers/dashboard-profile-graph.mjs";

test("workflow settings graph uses compiled Run topology and core role keys without running/probing", async (t) => {
	const p = await managementProject(t);
	const spec = await profileGraphFixtures(p.cwd);
	const before = await p.probeCount();
	const response = await p.http(`${p.base}/workflows/model-flow`);
	assert.equal(response.status, 200, JSON.stringify(response.data));
	const graph = response.data.graph;
	const compiled = await compileWorkflow(spec, {
		cwd: p.cwd,
		specPath: join(p.cwd, ".agent-workflow/workflows/model-flow.json"),
	});
	assert.deepEqual(
		graph.tasks,
		compiled.tasks.map((task) => ({
			specId: task.id,
			stageId: task.stageId,
			kind: task.kind,
			dependsOn: task.dependsOn || [],
		})),
	);
	assert.deepEqual(
		graph.slots,
		collectWorkflowRoleSlots(spec).map((slot) => ({
			...slot,
			roleKeys: roleKeysForSlot(slot),
		})),
	);
	assert.deepEqual(
		graph.slots.find((slot) => slot.id === "verify-a").roleKeys,
		["agent:reader", "verification", "default"],
	);
	assert.equal(
		graph.tasks.find((task) => task.stageId === "record").kind,
		"support",
	);
	assert.equal(
		graph.slots.some((slot) => slot.id === "record"),
		false,
	);
	assert.doesNotMatch(
		JSON.stringify(graph),
		/GRAPH-PROMPT-SENTINEL|agentPath|agentSystemPrompt|compiledPrompt|profile-code\.mjs/,
	);
	assert.equal(
		await p.probeCount(),
		before,
		"topology GET does not probe executors",
	);
	assert.equal(existsSync(p.effects), false, "no model/helper execution");
	assert.deepEqual((await p.http(`${p.base}/runs`)).data.runs, []);
	assert.equal(
		response.data.validation.data.valid,
		true,
		"original detail fields preserved",
	);
	assert.ok(Array.isArray(response.data.roles.data.roles));
});

test("startup graph keeps loop/dynamic controllers and declared slots, not fictional generated nodes", async (t) => {
	const p = await managementProject(t);
	await profileGraphFixtures(p.cwd);
	const response = await p.http(`${p.base}/workflows/expanding-flow`);
	assert.equal(response.status, 200, JSON.stringify(response.data));
	const graph = response.data.graph;
	assert.ok(
		graph.tasks.some(
			(task) => task.stageId === "iterate" && task.kind === "loop",
		),
	);
	assert.ok(
		graph.tasks.some(
			(task) => task.stageId === "adaptive" && task.kind === "dynamic",
		),
	);
	assert.ok(
		graph.slots.some(
			(slot) =>
				slot.id === "iterate.check" && slot.profileRole === "verification",
		),
	);
	assert.equal(
		graph.tasks.some((task) => /\$worker|round|generated/.test(task.stageId)),
		false,
	);
	assert.equal(existsSync(p.effects), false);
});

test("oversized settings graphs fail explicitly without truncation", async (t) => {
	const p = await managementProject(t);
	await writeFile(
		join(p.cwd, ".agent-workflow/workflows/large-flow.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "large-flow",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: Array.from({ length: 2001 }, (_, i) => ({
					id: `stage-${i}`,
					type: "single",
					prompt: "Check",
				})),
			},
		}),
	);
	const response = await p.http(`${p.base}/workflows/large-flow`);
	assert.equal(response.status, 200, JSON.stringify(response.data));
	assert.match(response.data.graph.error, /2000 tasks maximum/);
	assert.equal(response.data.graph.tasks, undefined, "no partial diagram");
	assert.equal(existsSync(p.effects), false);
});

test("invalid workflow graph fails explicitly and readonly GET remains available", async (t) => {
	const p = await managementProject(t, { readonly: true });
	await profileGraphFixtures(p.cwd);
	assert.equal((await p.http(`${p.base}/workflows/model-flow`)).status, 200);
	await writeFile(
		join(p.cwd, ".agent-workflow/workflows/broken-flow.json"),
		JSON.stringify({
			schemaVersion: 1,
			artifactGraph: { stages: [{ id: "broken", type: "not-a-stage" }] },
		}),
	);
	const invalid = await p.http(`${p.base}/workflows/broken-flow`);
	assert.notEqual(invalid.status, 200);
	assert.equal(
		invalid.data.graph,
		undefined,
		"never manufacture a graph after compilation failed",
	);
	assert.equal(existsSync(p.effects), false);
});
