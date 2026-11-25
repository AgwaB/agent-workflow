import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadWorkflowSpec, parseWorkflow } from "../../dist/core/schema.js";
import {
	loopWorkflowSpec,
	makeProject,
} from "../helpers/unit-test-support.mjs";

const check = {
	id: "check",
	support: { uses: "./check.mjs" },
	output: { controlSchema: "./check.json" },
};
const specWith = (child = check) =>
	loopWorkflowSpec({
		until: { stage: "check", path: "$.exitCode", equals: 0 },
		stages: [{ id: "write", type: "single", prompt: "Write." }, child],
	});

test("loop accepts a support child, but still rejects containers, foreach and dynamic", () => {
	assert.deepEqual(
		parseWorkflow(specWith()).artifactGraph.stages[0].stages[1],
		check,
	);
	for (const type of ["loop", "dag", "foreach", "dynamic"]) {
		assert.throws(
			() => parseWorkflow(specWith({ id: "check", type })),
			/loop child stages must/,
		);
	}
	assert.throws(
		() => parseWorkflow(specWith({ ...check, from: ["write"] })),
		/must not declare from\/after/,
	);
	assert.throws(
		() => parseWorkflow(specWith({ ...check, output: undefined })),
		/controlSchema/,
	);
});

test("a support child uses the same closed-schema until checks", async () => {
	const cwd = makeProject();
	try {
		const dir = join(cwd, "workflows", "support-loop");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "spec.json");
		writeFileSync(path, JSON.stringify(specWith()));
		writeFileSync(join(dir, "check.mjs"), "export default () => ({});");
		const schema = {
			type: "object",
			additionalProperties: false,
			properties: { schema: { type: "string" }, digest: { type: "string" } },
		};
		writeFileSync(join(dir, "check.json"), JSON.stringify(schema));
		await assert.rejects(
			loadWorkflowSpec(path, cwd),
			/until path.*exitCode.*only end exhausted/,
		);
		schema.properties.exitCode = { type: "integer" };
		writeFileSync(join(dir, "check.json"), JSON.stringify(schema));
		assert.ok(await loadWorkflowSpec(path, cwd));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
