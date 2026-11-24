// render-report: the novel-briefs failure `[object Object]` in a rendered report, plus table/list safety.
import assert from "node:assert/strict";
import { test } from "node:test";

const render = await import("../../src/core/helper-library/render-report.mjs");
const helper = render.default;

test("nested objects and arrays of objects render as JSON, never [object Object]", () => {
	const rows = [
		{
			id: "a",
			evidence: { file: "src/a.js", lines: [1, 2] },
			tags: ["x", "y"],
			owners: [{ name: "ann" }, { name: "bo" }],
		},
	];
	const table = render.renderTable(rows, ["id", "evidence", "tags", "owners"]);
	assert.doesNotMatch(table, /\[object Object\]/);
	assert.match(table, /`\{"file":"src\/a\.js","lines":\[1,2\]\}`/);
	assert.match(table, /\| x, y \|/);
	assert.match(table, /`\[\{"name":"ann"\},\{"name":"bo"\}\]`/);
});

test("select picks a field out of an object, or out of every element of an array", () => {
	const row = {
		evidence: { file: "src/a.js", line: 4 },
		owners: [{ name: "ann" }, { name: "bo" }],
	};
	assert.equal(render.renderCell(row.evidence, { select: "file" }), "src/a.js");
	assert.equal(render.renderCell(row.owners, { select: "name" }), "ann, bo");
	assert.equal(render.renderCell(row.owners, { select: "missing" }), "");
	const table = render.renderTable(
		[row],
		[{ field: "evidence", select: "file", title: "File" }],
	);
	assert.equal(table, "| File |\n| --- |\n| src/a.js |");
});

test("pipes, backslashes, newlines and markup in untrusted text cannot break a table row", () => {
	const nasty = "a | b\nc\r\nd \\ <script>alert(1)</script> `x` *y* [l](u)";
	const table = render.renderTable(
		[{ text: nasty, code: "x | y `z`" }],
		["text", { field: "code", code: true }],
	);
	const lines = table.split("\n");
	assert.equal(lines.length, 3, "one row, no extra lines");
	const unescapedPipes = lines[2].replace(/\\\|/g, "").split("|").length - 1;
	assert.equal(
		unescapedPipes,
		3,
		"only the three cell delimiters are real pipes",
	);
	assert.doesNotMatch(lines[2], /<script>/);
	assert.match(lines[2], /`` x \\\| y `z` ``/);
});

test("null, numbers, booleans, long text and empty tables", () => {
	assert.equal(render.renderCell(null), "");
	assert.equal(render.renderCell(undefined, { empty: "-" }), "-");
	assert.equal(render.renderCell(0), "0");
	assert.equal(render.renderCell(false), "false");
	assert.equal(render.renderCell("x".repeat(20), { max: 10 }), "xxxxxxxxx…");
	assert.equal(render.renderTable([], ["a"]), "None.");
	assert.equal(
		render.renderTable([], ["a"], { emptyText: "Nothing found." }),
		"Nothing found.",
	);
	assert.equal(render.renderList([]), "None.");
	assert.throws(
		() => render.renderTable([{ a: 1 }], [{ title: "no field" }]),
		/field path/,
	);
});

test("a table with no columns shows the first row's keys in sorted order; a primitive row shows as value", () => {
	assert.equal(
		render.renderTable([{ b: 2, a: 1 }]),
		"| a | b |\n| --- | --- |\n| 1 | 2 |",
	);
	assert.equal(render.renderTable([3], ["value"]), "| value |\n| --- |\n| 3 |");
});

test("lists: template placeholders, a field, ordered, and the JSON fallback", () => {
	const rows = [
		{ name: "a|b", detail: { x: 1 } },
		{ name: "c", detail: "multi\nline" },
	];
	assert.equal(
		render.renderList(rows, { template: "{name}: {detail}" }),
		'- a\\|b: `{"x":1}`\n- c: multi line',
	);
	assert.equal(
		render.renderList(rows, { field: "name", ordered: true }),
		"1. a\\|b\n2. c",
	);
	assert.equal(render.renderList([{ k: 1 }]), '- `{"k":1}`');
});

test("the helper renders sections with titles, counts, sorting, a limit and an empty text", async () => {
	const sources = {
		diff: {
			conflicts: [
				{ key: "GET /b", field: "handler", left: "x", right: { was: "y" } },
				{ key: "GET /a", field: "handler", left: "p", right: "q" },
				{ key: "GET /c", field: "handler", left: "r", right: "s" },
			],
			none: [],
		},
	};
	const args = {
		sources,
		context: {},
		options: {
			title: "Route audit",
			intro: "Compared | code with docs.",
			sections: [
				{
					title: "Conflicts",
					from: "diff",
					rows: "conflicts",
					sortBy: "key",
					limit: 2,
					columns: ["key", "left", "right"],
				},
				{
					title: "Items",
					from: "diff",
					rows: "conflicts",
					type: "list",
					template: "{key} -> {right}",
				},
				{ title: "Nothing", from: "diff", rows: "none", emptyText: "Clean." },
			],
		},
	};
	const out = await helper(args);
	assert.equal(out.status, "passed");
	assert.doesNotMatch(out.markdown, /\[object Object\]/);
	assert.match(
		out.markdown,
		/^# Route audit\n\nCompared \\\| code with docs\.\n\n## Conflicts \(3\)\n\n\| key \| left \| right \|/,
	);
	assert.match(
		out.markdown,
		/\| GET \/a \| p \| q \|\n\| GET \/b \| x \| `\{"was":"y"\}` \|\n\n_… and 1 more\._/,
	);
	assert.match(out.markdown, /- GET \/b -> `\{"was":"y"\}`/);
	assert.match(out.markdown, /## Nothing \(0\)\n\nClean\./);
	assert.equal(out.markdown.endsWith("\n"), true);
	assert.match(out.digest, /rendered 3 sections/);
	assert.equal(JSON.stringify(out), JSON.stringify(await helper(args)));
});

test("the helper throws for wiring faults: no sections, no from, a missing or non-array rows path", async () => {
	await assert.rejects(
		helper({ sources: {}, context: {}, options: {} }),
		/at least one section/,
	);
	await assert.rejects(
		helper({ sources: {}, context: {}, options: { sections: [{}] } }),
		/needs a from/,
	);
	await assert.rejects(
		helper({
			sources: {},
			context: {},
			options: { sections: [{ from: "x" }] },
		}),
		/not a completed source/,
	);
	await assert.rejects(
		helper({
			sources: { x: { items: 1 } },
			context: {},
			options: { sections: [{ from: "x" }] },
		}),
		/no array/,
	);
});
