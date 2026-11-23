// 2026-11-23: a model invents items only where the schema forces it to produce a non-empty list from input it may
// not have. Every model stage of the bundled workflows whose control schema has a top-level array with
// `minItems >= 1` is listed here with a verdict, so a new forced list is a conscious decision:
//   - "exit": the list is read from the target (a lens plan, the spec's requirements); the prompt carries the one-sentence
//     "do not invent items" exit and the schema declares the optional `inputIntegrity` block, which the
//     engine honours as a visible `input_integrity_blocked` stop (src/core/required-reads.ts).
//   - otherwise the reason it needs no exit: the list is generated from the runtime task itself, or the schema
//     already has an honest way out for the same situation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUNDLED_SPEC_FILES } from "../helpers/bundled-support-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_INVENT = "Do not invent items: if you find none";

const GENERATED_FROM_TASK = "generated from the runtime task (a research plan)";
const HONEST_EXIT_REVIEWER =
	"findings may be empty with noIssueNotes; sourceCoverage rows may be unreadable/metadata-only";
const PLAN_LISTS = [
	"researchAxes",
	"factSlots",
	"verificationPriorities",
	"researchScope",
	"researchQuestions",
	"researchScopeCoverage",
];

/** [spec file, stage id] -> { lists: top-level minItems>=1 arrays, verdict }. */
const FORCED_LISTS = new Map([
	...[
		"workflows/deep-research/spec.json",
		"workflows/deep-research/tiered-verification.spec.json",
	].map((file) => [
		`${file} plan`,
		{ lists: PLAN_LISTS, verdict: GENERATED_FROM_TASK },
	]),
	[
		"workflows/deep-review/spec.json triage",
		{ lists: ["reviewLenses"], verdict: "exit" },
	],
	[
		"workflows/deep-review/spec.json reviewers.each",
		{
			lists: ["evidenceChecked", "sourceCoverage"],
			verdict: HONEST_EXIT_REVIEWER,
		},
	],
	[
		"workflows/spec-review/spec.json extract-spec",
		{ lists: ["specSources", "requirements"], verdict: "exit" },
	],
]);

/** Every model stage (an object with a string prompt) with the control schema it is held to. */
function modelStages(spec) {
	const found = [];
	(function walk(node, path, parent) {
		if (Array.isArray(node)) {
			node.forEach((item, index) => {
				walk(item, `${path}[${index}]`, parent);
			});
			return;
		}
		if (node === null || typeof node !== "object") return;
		if (typeof node.prompt === "string") {
			const controlSchema =
				node.output?.controlSchema ?? parent?.output?.controlSchema;
			if (typeof controlSchema === "string")
				found.push({
					id: node.id ?? `${parent?.id}.each`,
					prompt: node.prompt,
					controlSchema,
				});
		}
		for (const [key, value] of Object.entries(node))
			walk(value, `${path}.${key}`, node);
	})(spec, "", undefined);
	return found;
}

test("bundled model stages: forced non-empty lists are exactly the recorded ones; the 'exit' ones carry the no-invent exit", async () => {
	const seen = new Map();
	const exits = [];
	for (const file of BUNDLED_SPEC_FILES) {
		const dir = dirname(join(root, file));
		const spec = JSON.parse(await readFile(join(root, file), "utf8"));
		for (const stage of modelStages(spec)) {
			const schema = JSON.parse(
				await readFile(join(dir, stage.controlSchema), "utf8"),
			);
			const lists = Object.entries(schema.properties ?? {})
				.filter(
					([, property]) =>
						property.type === "array" && (property.minItems ?? 0) >= 1,
				)
				.map(([name]) => name);
			if (lists.length === 0) continue;
			const key = `${file} ${stage.id}`;
			seen.set(key, lists);
			if (FORCED_LISTS.get(key)?.verdict === "exit")
				exits.push({ key, stage, schema });
		}
	}
	assert.deepEqual(
		[...seen.entries()].sort(([a], [b]) => a.localeCompare(b)),
		[...FORCED_LISTS.entries()]
			.map(([key, { lists }]) => [key, lists])
			.sort(([a], [b]) => a.localeCompare(b)),
		"a bundled model stage forces (or no longer forces) a non-empty list: decide whether it needs the no-invent exit and record it",
	);
	assert.ok(exits.length > 0);
	for (const { key, stage, schema } of exits) {
		assert.ok(
			stage.prompt.includes(NO_INVENT),
			`${key}: prompt lacks the exit`,
		);
		assert.match(
			stage.prompt,
			/inputIntegrity \{\\?"status\\?":\\?"blocked\\?"/u,
		);
		const integrity = schema.properties?.inputIntegrity;
		assert.deepEqual(
			integrity?.properties?.status?.enum,
			["complete", "blocked"],
			key,
		);
		assert.ok(
			!(schema.required ?? []).includes("inputIntegrity"),
			`${key}: inputIntegrity stays optional`,
		);
	}
});
