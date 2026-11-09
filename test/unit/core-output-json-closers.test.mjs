// agent-workflow 2026-11-09: recorded deep-research final audits failed on control JSON that ended "…}]}}" without the
// root's "}" or closed an object where an array still needed "]"; each cost a full xhigh retry. Only closing
// brackets are added, only in <control>, only when the text ends with a closer and no string is left open.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	closeMissingJsonBrackets,
	parseWorkflowOutput,
} from "../../dist/core/workflow-output-artifacts.js";

const output = (control, refs = "[]") =>
	`<control>${control}</control>\n<analysis>ok</analysis>\n<refs>${refs}</refs>`;

test("closeMissingJsonBrackets adds only the missing closers", () => {
	// recorded shape: the root's "}" missing after "…}]}}"
	const root =
		'{"schema":"s","digest":"d","synthesis":{"translations":{"claims":[{"id":"c1","text":"t"}]}}';
	assert.deepEqual(closeMissingJsonBrackets(root), {
		text: `${root}}`,
		added: 1,
	});
	// recorded shape: an array's "]" missing before the object closes
	const array = '{"synthesis":{"notes":[{"note":"n"}}}';
	assert.deepEqual(closeMissingJsonBrackets(array), {
		text: '{"synthesis":{"notes":[{"note":"n"}]}}',
		added: 1,
	});
	// brackets inside strings do not count
	assert.equal(
		closeMissingJsonBrackets('{"a":"}]{[","b":{"c":1}').text,
		'{"a":"}]{[","b":{"c":1}}',
	);
	for (const [name, text] of [
		["balanced", '{"a":[1]}'],
		["cut off inside a string", '{"a":{"b":"unfinished}'],
		["does not end with a closer", '{"a":{"b":1}, "c":'],
		["extra closer", '{"a":1}}'],
	])
		assert.equal(closeMissingJsonBrackets(text), undefined, name);
});

const schema = {
	type: "object",
	required: ["schema", "digest", "x"],
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		x: {
			type: "object",
			required: ["y"],
			properties: { y: { type: "array" } },
			additionalProperties: false,
		},
	},
	additionalProperties: false,
};
const missingRoot = '{"schema":"stage-control-v1","digest":"d","x":{"y":[1,2]}';

test("a control missing only closers is repaired when the closed result passes the stage's control schema", () => {
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

test("without a control schema, or when the closed result fails it, a missing closer stays invalid", () => {
	// no schema: nothing confirms the guessed shape (the WP10 truncated-control rule)
	const bare = parseWorkflowOutput(output(missingRoot));
	assert.equal(bare.valid, false);
	assert.match(
		bare.issues.map((i) => i.message).join("\n"),
		/control must contain valid JSON/,
	);
	// closers that nest a root field under "x" fail additionalProperties: not accepted
	const misnested = parseWorkflowOutput(
		output('{"schema":"stage-control-v1","digest":"d","x":{"y":[1],"z":2}'),
		{
			controlJsonSchema: schema,
		},
	);
	assert.equal(misnested.valid, false);
	for (const control of [
		// recorded: stray text before the last brace — nothing is removed
		'{"schema":"stage-control-v1","digest":"d","x":{"y":[1]} </synthesis>}',
		// an extra quote (the 2026-11-02 case)
		'{"schema":"stage-control-v1","digest":"ends with quotes."""}',
	]) {
		const parsed = parseWorkflowOutput(output(control), {
			controlJsonSchema: schema,
		});
		assert.equal(parsed.valid, false, control);
		assert.match(
			parsed.issues.map((i) => i.message).join("\n"),
			/control must contain valid JSON/,
		);
	}
	// refs are not repaired
	const refs = parseWorkflowOutput(
		output(`${missingRoot}}`, '[{"path":"a.ts"}'),
		{ controlJsonSchema: schema },
	);
	assert.equal(refs.valid, false);
});
