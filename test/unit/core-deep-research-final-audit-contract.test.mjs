// agent-workflow 2026-11-08: the final-audit prompt and its control schema must not contradict each other.
// Recorded runs: 6 of 10 final-audit output retries were `translations.factSlots[].gap` = "" (a filled slot has no
// gapReason to translate) rejected by minLength 1, each costing a full attempt; the prompt's example also omitted the
// required inputIntegrity. The renderer already ignores an empty translation, so an empty optional text is "none".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../../dist/core/json-schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
	"workflows/deep-research/spec.json",
	"workflows/deep-research/tiered-verification.spec.json",
];

async function finalAudit(specFile) {
	const spec = JSON.parse(await readFile(join(root, specFile), "utf8"));
	const stage = spec.artifactGraph.stages.find((s) => s.id === "final-audit");
	const schema = JSON.parse(
		await readFile(
			join(root, dirname(specFile), stage.output.controlSchema),
			"utf8",
		),
	);
	return { prompt: stage.prompt, schema };
}

function exampleControl(prompt) {
	const start = prompt.indexOf('{"schema":"deep-research-final-synthesis-v2"');
	assert.ok(start >= 0, "final-audit prompt carries an example control");
	let depth = 0;
	for (let i = start; i < prompt.length; i += 1) {
		if (prompt[i] === "{") depth += 1;
		else if (prompt[i] === "}" && --depth === 0)
			return JSON.parse(prompt.slice(start, i + 1));
	}
	throw new Error("unterminated example");
}

for (const specFile of SPECS) {
	test(`${specFile}: the final-audit example control satisfies its schema`, async () => {
		const { prompt, schema } = await finalAudit(specFile);
		const result = validateJsonSchema(exampleControl(prompt), schema);
		assert.deepEqual(result.issues, []);
	});

	test(`${specFile}: an empty optional translation text is accepted, an empty required one is not`, async () => {
		const { prompt, schema } = await finalAudit(specFile);
		const control = exampleControl(prompt);
		control.inputIntegrity ??= { status: "complete" };
		const translations = control.synthesis.translations;
		translations.factSlots[0].gap = "";
		translations.factSlots[0].whyItMatters = "";
		translations.claims[0].explanation = "";
		assert.deepEqual(validateJsonSchema(control, schema).issues, []);
		translations.factSlots[0].area = "";
		translations.claims[0].text = "";
		const paths = validateJsonSchema(control, schema).issues.map(
			(issue) => issue.path,
		);
		assert.deepEqual(paths.sort(), [
			"$.synthesis.translations.claims[0].text",
			"$.synthesis.translations.factSlots[0].area",
		]);
	});
}
