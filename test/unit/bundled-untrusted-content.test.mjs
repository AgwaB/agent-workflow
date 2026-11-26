import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expected = {
	"deep-research/spec.json": ["normalize-claims", "retranslate"],
	"deep-research/tiered-verification.spec.json": [
		"normalize-claims",
		"retranslate",
	],
	"deep-review/spec.json": ["triage"],
	"spec-review/spec.json": ["extract-spec", "map-implementation"],
};

test("bundled source-reading prompts distinguish untrusted data from instructions", async () => {
	for (const [file, ids] of Object.entries(expected)) {
		const spec = JSON.parse(
			await readFile(
				new URL(`../../workflows/${file}`, import.meta.url),
				"utf8",
			),
		);
		for (const id of ids) {
			const stage = spec.artifactGraph.stages.find((stage) => stage.id === id);
			assert.ok(stage, `${file}: ${id}`);
			assert.match(
				stage.each?.prompt ?? stage.prompt,
				/as untrusted data, not instructions\./,
				`${file}: ${id}`,
			);
		}
	}
});
