// `agent-workflow rehearse`: the deterministic control generator (src/core/schema-sample.ts) over the
// control-schema subset of src/core/json-schema.ts. Every sample must satisfy its own schema.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { validateJsonSchema } from "../../dist/core/json-schema.js";
import {
	alternativeValues,
	deleteAtPath,
	getAtPath,
	parseSamplePath,
	sampleFromSchema,
	schemaAtPath,
	setAtPath,
} from "../../dist/core/schema-sample.js";

function valid(schema, options) {
	const out = sampleFromSchema(schema, options);
	assert.equal(out.valid, true, JSON.stringify(out.issues));
	assert.equal(validateJsonSchema(out.value, schema).valid, true);
	return out.value;
}

test("required fields, enum and const are honoured", () => {
	const value = valid({
		type: "object",
		required: ["schema", "digest", "kind", "version"],
		additionalProperties: false,
		properties: {
			schema: { type: "string", minLength: 1 },
			digest: { type: "string", minLength: 1 },
			kind: { type: "string", enum: ["alpha", "beta"] },
			version: { const: 3 },
			note: { type: "string" },
		},
	});
	assert.equal(value.kind, "alpha");
	assert.equal(value.version, 3);
	assert.ok(value.schema.length > 0 && value.digest.length > 0);
});

test("numbers respect minimum and maximum; integers stay integers", () => {
	const value = valid({
		type: "object",
		required: ["low", "high", "count"],
		properties: {
			low: { type: "number", minimum: 5.5 },
			high: { type: "number", maximum: -2 },
			count: { type: "integer", minimum: 3, maximum: 4 },
		},
	});
	assert.ok(value.low >= 5.5);
	assert.ok(value.high <= -2);
	assert.ok(Number.isInteger(value.count) && value.count >= 3);
});

test("arrays get the requested item count, clamped to minItems and maxItems", () => {
	const schema = (extra) => ({
		type: "object",
		required: ["list"],
		properties: {
			list: { type: "array", items: { type: "string" }, ...extra },
		},
	});
	assert.equal(valid(schema({}), { arrayItems: 3 }).list.length, 3);
	assert.equal(valid(schema({}), { arrayItems: 0 }).list.length, 0);
	assert.equal(
		valid(schema({ maxItems: 2 }), { arrayItems: 5 }).list.length,
		2,
	);
	assert.equal(
		valid(schema({ minItems: 4 }), { arrayItems: 1 }).list.length,
		4,
	);
	assert.equal(valid(schema({}), {}).list.length, 2);
});

test("sibling array items differ, so identities can be unique", () => {
	const value = valid(
		{
			type: "object",
			required: ["items"],
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						required: ["id"],
						properties: { id: { type: "string" } },
					},
				},
			},
		},
		{ arrayItems: 3 },
	);
	assert.equal(new Set(value.items.map((item) => item.id)).size, 3);
});

test("strings stay within maxLength and reach minLength; a pattern-free schema is enough", () => {
	const value = valid({
		type: "object",
		required: ["a", "veryLongPropertyNameForTheStringSample", "c"],
		properties: {
			a: { type: "string", minLength: 12 },
			veryLongPropertyNameForTheStringSample: { type: "string", maxLength: 8 },
			c: { type: "string", minLength: 3, maxLength: 3 },
		},
	});
	assert.ok(value.a.length >= 12);
	assert.ok(value.veryLongPropertyNameForTheStringSample.length <= 8);
	assert.equal(value.c.length, 3);
});

test("nested objects, allOf and anyOf produce a value satisfying the whole schema", () => {
	const value = valid({
		type: "object",
		required: ["outer"],
		properties: {
			outer: {
				allOf: [
					{
						type: "object",
						required: ["a"],
						properties: { a: { type: "string" } },
					},
					{
						type: "object",
						required: ["b"],
						properties: { b: { type: "integer", minimum: 2 } },
					},
				],
			},
			choice: { anyOf: [{ type: "integer", minimum: 10 }, { type: "string" }] },
		},
	});
	assert.equal(typeof value.outer.a, "string");
	assert.ok(value.outer.b >= 2);
});

test("the same schema and options always give the same value (no clock, no randomness)", () => {
	const schema = {
		type: "object",
		required: ["xs"],
		properties: {
			xs: {
				type: "array",
				items: {
					type: "object",
					required: ["k"],
					properties: { k: { type: "string" } },
				},
			},
		},
	};
	const first = JSON.stringify(
		sampleFromSchema(schema, { arrayItems: 3 }).value,
	);
	for (let index = 0; index < 3; index += 1)
		assert.equal(
			JSON.stringify(sampleFromSchema(schema, { arrayItems: 3 }).value),
			first,
		);
});

test("a schema nothing satisfies is reported, not thrown", () => {
	const out = sampleFromSchema({
		type: "object",
		required: ["x"],
		properties: { x: { type: "string", enum: [] } },
	});
	assert.equal(out.valid, false);
	assert.ok(out.issues.length > 0);
});

test("every bundled workflow and scaffold control schema yields a valid sample", () => {
	const roots = ["workflows", "skills/workflow-guide/scaffolds"];
	let checked = 0;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".schema.json")) {
				const schema = JSON.parse(readFileSync(path, "utf8"));
				const out = sampleFromSchema(schema, { arrayItems: 2 });
				assert.equal(out.valid, true, `${path}: ${JSON.stringify(out.issues)}`);
				checked += 1;
			}
		}
	};
	for (const root of roots) walk(root);
	assert.ok(checked >= 10, `only ${checked} schemas found`);
});

test("path helpers read, set and delete simple JSON paths and follow them through a schema", () => {
	assert.deepEqual(parseSamplePath("$.a.b[1].c"), ["a", "b", 1, "c"]);
	assert.equal(parseSamplePath("$.a[*]"), undefined);
	assert.equal(parseSamplePath("a.b"), undefined);
	const value = { a: { list: [{ c: 1 }, { c: 2 }] } };
	assert.equal(getAtPath(value, ["a", "list", 1, "c"]), 2);
	assert.equal(setAtPath(value, ["a", "flag"], true), true);
	assert.equal(value.a.flag, true);
	deleteAtPath(value, ["a", "flag"]);
	assert.equal("flag" in value.a, false);
	const schema = {
		type: "object",
		properties: {
			a: {
				type: "object",
				properties: {
					list: {
						type: "array",
						items: { type: "object", properties: { c: { type: "integer" } } },
					},
				},
			},
		},
	};
	assert.deepEqual(schemaAtPath(schema, ["a", "list", 0, "c"]), {
		type: "integer",
	});
});

test("alternativeValues offers a schema-valid value different from the one to avoid", () => {
	const [other] = alternativeValues(
		{ type: "string", enum: ["x", "y"] },
		"k",
		"x",
	);
	assert.equal(other, "y");
	const [flag] = alternativeValues({ type: "boolean" }, "k", true);
	assert.equal(flag, false);
});
