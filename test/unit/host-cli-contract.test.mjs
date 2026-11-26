import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../dist/core/json-schema.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";

async function run(cwd, ...argv) {
	let stdout = "";
	let stderr = "";
	const code = await runAgentWorkflowCli(argv, {
		cwd,
		env: process.env,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stdout, stderr };
}

const example = (text) =>
	JSON.parse(text.match(/<control>(\{.*\})<\/control>/)[1]);

test("contract prints a schema-valid prompt paragraph by name or path without resolving agents", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-contract-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "workflows", "example");
	await mkdir(root, { recursive: true });
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["schema", "digest", "status", "items"],
		properties: {
			schema: { const: "example-v1" },
			digest: { type: "string", maxLength: 36 },
			status: { enum: ["pass", "fail"] },
			items: {
				type: "array",
				maxItems: 3,
				items: { type: "string", maxLength: 12 },
			},
		},
	};
	const open = { type: "object", properties: { note: { type: "string" } } };
	await writeFile(join(root, "closed.json"), JSON.stringify(schema));
	await writeFile(join(root, "open.json"), JSON.stringify(open));
	await writeFile(
		join(root, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "example",
			defaults: { agent: "not-installed" },
			artifactGraph: {
				stages: [
					{
						id: "review",
						type: "dag",
						stages: [
							{
								id: "summary",
								type: "single",
								prompt: "Draft it.",
								output: { controlSchema: "./closed.json" },
							},
						],
					},
					{
						id: "draft",
						type: "single",
						prompt: "Draft it.",
						after: [],
						output: { controlSchema: "./open.json" },
					},
				],
			},
		}),
	);
	const printed = await run(cwd, "contract", "example", "review.summary");
	assert.equal(printed.code, 0, printed.stderr);
	assert.match(
		printed.stdout,
		/Emit no top-level keys other than schema, digest, status, items\./,
	);
	assert.match(printed.stdout, /status must be exactly one of: pass, fail\./);
	assert.match(printed.stdout, /Array caps: items<=3;.*overflow in <analysis>/);
	assert.match(
		printed.stdout,
		/String limits in characters: digest<=36, items\[\]<=12/,
	);
	assert.equal(validateJsonSchema(example(printed.stdout), schema).valid, true);
	const json = await run(
		cwd,
		"contract",
		"./workflows/example/spec.json",
		"draft",
		"--json",
	);
	assert.equal(json.code, 0, json.stderr);
	const { data } = JSON.parse(json.stdout);
	assert.equal(data.stage, "draft");
	assert.doesNotMatch(data.contract, /Emit no top-level keys other/);
	assert.equal(example(data.contract).schema, "stage-control-v1");
	assert.equal(validateJsonSchema(example(data.contract), open).valid, true);
	for (const [args, message] of [
		[[], /Usage:.*contract/],
		[["example", "summary"], /Unknown stage.*dotted id/],
		[["example", "review"], /no output\.controlSchema/],
	]) {
		const bad = await run(cwd, "contract", ...args);
		assert.equal(bad.code, 2, bad.stderr);
		assert.match(bad.stderr, message);
		assert.equal(bad.stdout, "");
	}
});
