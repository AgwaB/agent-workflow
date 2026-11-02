// Invalid JSON escapes in workflow output sections (2026-11-02): an Antigravity reviewer lost its
// lens after three attempts whose <control> JSON quoted regexes with backslash-u{…} and a
// backslash before a backtick. Those are repaired deterministically; structural breaks are not.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	jsonErrorExcerpt,
	parseWorkflowOutput,
	repairInvalidJsonEscapes,
} from "../../dist/core/workflow-output-artifacts.js";

const output = (control, refs = "[]") =>
	`<control>${control}</control>\n<analysis>ok</analysis>\n<refs>${refs}</refs>`;

test("invalid escapes and raw control characters inside strings become literal; valid JSON is untouched", () => {
	const BS = "\\";
	const BT = "`";
	const cases = [
		// attempt 1 of the A/B: Bad Unicode escape
		[`{"q":"[${BS}u{1d400}-${BS}u{1d7ff}]"}`, `[${BS}u{1d400}-${BS}u{1d7ff}]`],
		// attempt 2: Bad escaped character (backslash before a backtick)
		[
			`{"q":"new RegExp(${BS}${BT}<x${BS}${BS}b${BS}${BT})"}`,
			`new RegExp(${BS}${BT}<x${BS}b${BS}${BT})`,
		],
		[`{"q":"${BS}d+${BS}(x${BS})"}`, `${BS}d+${BS}(x${BS})`],
		['{"q":"line one\nline two\ttab"}', "line one\nline two\ttab"],
	];
	for (const [text, value] of cases) {
		assert.throws(() => JSON.parse(text));
		const repaired = repairInvalidJsonEscapes(text);
		assert.ok(repaired.count > 0, text);
		assert.equal(JSON.parse(repaired.text).q, value, text);
	}
	const valid = String.raw`{"a":"\"quoted\" \\ \/ \b\f\n\r\t \u00e9","b":["x"]}`;
	assert.deepEqual(repairInvalidJsonEscapes(valid), { text: valid, count: 0 });
	// Backslashes outside strings are not touched (and stay invalid).
	assert.equal(repairInvalidJsonEscapes(String.raw`{"a":1}\x`).count, 0);
});

test("parseWorkflowOutput repairs invalid escapes and records the repair; structural breaks stay invalid", () => {
	const repaired = parseWorkflowOutput(
		output(
			String.raw`{"schema":"stage-control-v1","digest":"regex [\u{1d400}] and \d"}`,
		),
	);
	assert.equal(repaired.valid, true, JSON.stringify(repaired.issues));
	assert.equal(repaired.control.digest, "regex [\\u{1d400}] and \\d");
	assert.deepEqual(
		repaired.repairs.map((r) => [r.code, r.section]),
		[["json_invalid_escape", "control"]],
	);
	// refs too
	const refs = parseWorkflowOutput(
		output(
			'{"schema":"stage-control-v1","digest":"d"}',
			String.raw`[{"path":"a.ts","note":"\s"}]`,
		),
	);
	assert.equal(refs.valid, true, JSON.stringify(refs.issues));
	assert.equal(refs.refs[0].note, "\\s");
	// attempt 3 of the A/B: an extra quote ends a string early; no structure is guessed.
	const broken = parseWorkflowOutput(
		output('{"schema":"stage-control-v1","digest":"ends with quotes."""}'),
	);
	assert.equal(broken.valid, false);
	assert.match(
		broken.issues.map((i) => i.message).join("\n"),
		/control must contain valid JSON/,
	);
});

test("the retry gets the previous output around the JSON error position", () => {
	const control = `{"schema":"stage-control-v1","digest":"${"x".repeat(5000)} then a """ break"}`;
	const previous = output(control);
	let message;
	try {
		JSON.parse(control);
	} catch (error) {
		message = `Validation error: workflow output protocol was invalid.\nIssues:\n- control: control must contain valid JSON: ${error.message}`;
	}
	const excerpt = jsonErrorExcerpt(previous, message);
	assert.match(excerpt, /^Where the control JSON broke/);
	assert.match(excerpt, /then a "⟦HERE⟧""/);
	assert.match(excerpt, /two backslashes/);
	assert.equal(
		jsonErrorExcerpt(
			previous,
			"control must contain valid JSON: Unexpected end",
		),
		undefined,
	);
	assert.equal(jsonErrorExcerpt("no sections", message), undefined);
});
