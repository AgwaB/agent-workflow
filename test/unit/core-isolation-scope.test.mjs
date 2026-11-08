// C2 (2026-11-08): the engine tells the adapter which part of the user's context a stage inherits.
import assert from "node:assert/strict";
import test from "node:test";

import { workflowTaskIsolation } from "../../dist/core/task-runner.js";
import {
	buildSubmitRequestFields,
	validateRuntimeRunInput,
} from "../../dist/runtime/orchestrate/request.js";

test("workflowTaskIsolation names the inherited parts", () => {
	assert.deepEqual(workflowTaskIsolation({}), { inherit: false });
	assert.deepEqual(workflowTaskIsolation({ inheritSkills: false }), {
		inherit: false,
	});
	assert.deepEqual(workflowTaskIsolation({ inheritSkills: true }), {
		inherit: true,
		scope: { contextFiles: false, skills: true },
	});
	assert.deepEqual(workflowTaskIsolation({ inheritProjectContext: true }), {
		inherit: true,
		scope: { contextFiles: true, skills: false },
	});
	assert.deepEqual(
		workflowTaskIsolation({ inheritProjectContext: true, inheritSkills: true }),
		{ inherit: true, scope: { contextFiles: true, skills: true } },
	);
});

const executor = {
	id: "x",
	version: "0.1.0",
	contractVersion: "0.1.0",
	module: "file:///x.js",
	config: null,
};
const input = (isolation) => ({ executor, task: "t", isolation });

test("runtime input accepts a scope only with inherit and at least one part; the request carries it", () => {
	assert.equal(validateRuntimeRunInput(input({ inherit: false })).ok, true);
	assert.equal(
		validateRuntimeRunInput(
			input({ inherit: true, scope: { contextFiles: false, skills: true } }),
		).ok,
		true,
	);
	for (const bad of [
		{ inherit: false, scope: { contextFiles: true, skills: false } },
		{ inherit: true, scope: { contextFiles: false, skills: false } },
		{ inherit: true, scope: { contextFiles: true } },
		{
			inherit: true,
			scope: { contextFiles: true, skills: false, extensions: true },
		},
		{ inherit: true, scope: "skills" },
	]) {
		const result = validateRuntimeRunInput(input(bad));
		assert.equal(result.ok, false, JSON.stringify(bad));
		assert.match(
			result.error ?? result.message ?? JSON.stringify(result),
			/isolation\.scope/,
		);
	}
	const fields = (isolation) =>
		buildSubmitRequestFields({
			input: { task: "t", isolation },
			runId: "r",
			attemptId: "a",
			cwd: "/tmp",
			startedAt: new Date(),
		}).isolation;
	assert.deepEqual(
		fields({ inherit: true, scope: { contextFiles: true, skills: false } }),
		{
			inherit: true,
			scope: { contextFiles: true, skills: false },
		},
	);
	assert.deepEqual(fields({ inherit: true }), { inherit: true });
	assert.deepEqual(fields(undefined), { inherit: false });
});
