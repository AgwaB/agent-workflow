// agent-workflow 2026-11-09: recorded deep-research final audits failed on control JSON that ended "…}]}}" without the
// root's "}"; each cost a full xhigh retry. Only that brace is added, and only when the schema requires every root
// property it declares (so nothing can be missing). Review 2026-11-09 (gpt-6-astra, claude-fable-5-1): the first
// version also closed open lists and accepted a control truncated after a list element.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	closeMissingRootBrace,
	parseWorkflowOutput,
	removeStrayMarkupTags,
} from "../../dist/core/workflow-output-artifacts.js";

const output = (control, refs = "[]") =>
	`<control>${control}</control>\n<analysis>ok</analysis>\n<refs>${refs}</refs>`;
const schema = {
	type: "object",
	required: ["schema", "digest", "x"],
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		x: {
			type: "object",
			properties: { y: { type: "array" }, notes: { type: "array" } },
			additionalProperties: false,
		},
	},
	additionalProperties: false,
};
const missingRoot = '{"schema":"stage-control-v1","digest":"d","x":{"y":[1,2]}';
const invalidJson = /control must contain valid JSON/;

test("closeMissingRootBrace adds the root's brace only when it is the one container left open", () => {
	assert.equal(closeMissingRootBrace(`${missingRoot}  `), `${missingRoot}}`);
	assert.equal(
		closeMissingRootBrace('{"a":"}]{[","b":{"c":1}'),
		'{"a":"}]{[","b":{"c":1}}',
	);
	for (const [name, text] of [
		["balanced", '{"a":[1]}'],
		["list cut after an element", '{"a":{"notes":[{"n":1},{"n":2}'],
		["inner array left open", '{"a":{"notes":[{"n":1}}}'],
		["cut off inside a string", '{"a":{"b":"unfinished}'],
		["does not end with a closer", '{"a":{"b":1}, "c":'],
		["extra closer", '{"a":1}}'],
		["root closed early, text after", '{"a":1} {"b":2}'],
		["not an object", '[{"a":1}'],
	])
		assert.equal(closeMissingRootBrace(text), undefined, name);
});

test("a control missing only its root brace is repaired under a schema that requires every root property", () => {
	const repaired = parseWorkflowOutput(output(missingRoot), {
		controlJsonSchema: schema,
	});
	assert.equal(repaired.valid, true, JSON.stringify(repaired.issues));
	assert.deepEqual(repaired.control.x, { y: [1, 2] });
	assert.deepEqual(
		repaired.repairs.map((r) => [r.code, r.section]),
		[["json_missing_closers", "control"]],
	);
});

test("truncation is not completed: open lists, open inner objects, optional root properties, no schema", () => {
	const reject = (control, options, name) => {
		const parsed = parseWorkflowOutput(output(control), options);
		assert.equal(parsed.valid, false, name);
		assert.match(
			parsed.issues.map((i) => i.message).join("\n"),
			invalidJson,
			name,
		);
	};
	// the reviewers' counterexample: a list cut after its first element (would pass the schema if closed)
	reject(
		'{"schema":"stage-control-v1","digest":"d","x":{"notes":[{"n":1}',
		{ controlJsonSchema: schema },
		"list cut",
	);
	// the recorded mismatched case (an array's "]" missing mid-text) is no longer guessed
	reject(
		'{"schema":"stage-control-v1","digest":"d","x":{"notes":[{"n":1}}}',
		{ controlJsonSchema: schema },
		"mismatch",
	);
	// WP10 fixture shape: no schema, or a schema with an optional root property, stays invalid
	const wp10 = JSON.stringify({
		schema: "stage-control-v1",
		digest: "truncated",
		details: { ready: true },
	}).slice(0, -1);
	reject(wp10, {}, "no schema");
	const optionalRoot = {
		type: "object",
		required: ["schema", "digest"],
		properties: {
			schema: { type: "string" },
			digest: { type: "string" },
			details: { type: "object" },
		},
		additionalProperties: false,
	};
	reject(wp10, { controlJsonSchema: optionalRoot }, "optional root property");
	reject(
		wp10,
		{
			controlJsonSchema: {
				...optionalRoot,
				required: ["schema", "digest", "details"],
				additionalProperties: true,
			},
		},
		"open root",
	);
	// stray text and an extra quote stay invalid; refs are not repaired. (2026-11-10: a whole markup tag such as
	// "</synthesis>" between tokens is now removed — see the json_stray_markup tests below; other text is not.)
	reject(
		'{"schema":"stage-control-v1","digest":"d","x":{"y":[1]} synthesis done}',
		{ controlJsonSchema: schema },
		"stray text",
	);
	reject(
		'{"schema":"stage-control-v1","digest":"ends with quotes."""}',
		{ controlJsonSchema: schema },
		"extra quote",
	);
	const refs = parseWorkflowOutput(
		output(`${missingRoot}}`, '[{"path":"a.ts"}'),
		{ controlJsonSchema: schema },
	);
	assert.equal(refs.valid, false);
});

test("the deep-research final-audit schema: root brace repaired, a truncated note list is not", () => {
	const finalSchema = JSON.parse(
		readFileSync(
			new URL(
				"../../workflows/deep-research/schemas/deep-research-final-synthesis-v2-control.schema.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const note = (n) => ({
		note: n,
		whyItMatters: "w",
		evidenceStatus: "derived",
		suggestedParentDecision: "s",
	});
	const control = {
		schema: "deep-research-final-synthesis-v2",
		digest: "d",
		inputIntegrity: { status: "complete" },
		synthesis: {
			bottomLine: "b",
			comparisonRows: [],
			keyFindingIds: ["claim-001"],
			recommendations: [],
			actionPlan: [],
			caveatNotes: [],
			parentDecisionNotes: [note("n1"), note("n2")],
		},
	};
	const text = JSON.stringify(control);
	assert.equal(
		parseWorkflowOutput(output(text.slice(0, -1)), {
			controlJsonSchema: finalSchema,
		}).valid,
		true,
	);
	const cut = text.slice(0, text.indexOf(',{"note":"n2"'));
	assert.equal(
		parseWorkflowOutput(output(cut), { controlJsonSchema: finalSchema }).valid,
		false,
	);
});

// agent-workflow 2026-11-10: the sixth recorded final-audit failure ended "…}]}} </synthesis>}" — a markup tag between
// JSON tokens. A whole tag outside strings is removed (JSON has no "<" there); other stray text stays invalid.
test("removeStrayMarkupTags removes whole tags between tokens and nothing inside strings", () => {
	assert.deepEqual(removeStrayMarkupTags('{"a":{"b":1}} </synthesis>}'), {
		text: '{"a":{"b":1}} }',
		tags: ["</synthesis>"],
	});
	assert.deepEqual(removeStrayMarkupTags('{"a":"<b>x</b>","c":1}'), {
		text: '{"a":"<b>x</b>","c":1}',
		tags: [],
	});
	assert.deepEqual(removeStrayMarkupTags('{"a":1 < 2}'), {
		text: '{"a":1 < 2}',
		tags: [],
	});
});

test("a stray markup tag is removed under a schema that requires every root property, alone or with the root brace", () => {
	const strayOnly =
		'{"schema":"stage-control-v1","digest":"d","x":{"y":[1,2]} </synthesis>}';
	const strayAndRoot =
		'{"schema":"stage-control-v1","digest":"d","x":{"y":[1,2]}</x>';
	for (const [control, codes] of [
		[strayOnly, ["json_stray_markup"]],
		[strayAndRoot, ["json_stray_markup", "json_missing_closers"]],
	]) {
		const repaired = parseWorkflowOutput(output(control), {
			controlJsonSchema: schema,
		});
		assert.equal(repaired.valid, true, JSON.stringify(repaired.issues));
		assert.deepEqual(repaired.control.x, { y: [1, 2] });
		assert.deepEqual(
			repaired.repairs.map((r) => [r.code, r.section]),
			codes.map((code) => [code, "control"]),
		);
	}
	for (const [control, options, name] of [
		[
			'{"schema":"stage-control-v1","digest":"d","x":{"y":[1,2]} done}',
			{ controlJsonSchema: schema },
			"other stray text",
		],
		[strayOnly, {}, "no schema"],
		[
			strayOnly,
			{ controlJsonSchema: { ...schema, required: ["schema", "digest"] } },
			"an optional root property",
		],
	]) {
		const parsed = parseWorkflowOutput(output(control), options);
		assert.equal(parsed.valid, false, name);
		assert.match(
			parsed.issues.map((i) => i.message).join("\n"),
			invalidJson,
			name,
		);
	}
});
