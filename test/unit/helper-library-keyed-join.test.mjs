// keyed-join: the novel-briefs N5 failure (a diff keyed by path alone lost the method mismatch).
import assert from "node:assert/strict";
import { test } from "node:test";

const {
	keyedJoin,
	normalizeValue,
	default: helper,
} = await import("../../src/core/helper-library/keyed-join.mjs");

const code = [
	{ method: "get", path: "/users/:id", handler: "show" },
	{ method: "POST", path: "/users", handler: "create" },
	{ method: "POST", path: "/orders/", handler: "place" },
	{ method: "GET", path: "/health", handler: "ping" },
	{ method: "DELETE", path: "/users/:id", handler: "remove" },
];
const docs = [
	{ method: "GET", path: "/users/{userId}", handler: "get" },
	{ method: "POST", path: "/users", handler: "create" },
	{ method: "PUT", path: "/orders", handler: "place" },
	{ method: "GET", path: "/reports" },
	{ method: "DELETE", path: "/users/<id>?x=1", handler: "remove " },
];
const options = {
	key: ["method", "path"],
	normalize: {
		method: ["trim", "upper"],
		path: ["trim", "strip-query", "path-params", "trailing-slash"],
	},
	compare: ["handler"],
	relatedBy: ["path"],
};

test("method + path is the key: placeholders and case are normalised, a method mismatch is not hidden", () => {
	const joined = keyedJoin(code, docs, options);
	assert.deepEqual(
		joined.both.map((entry) => entry.key),
		["DELETE /users/{}", "GET /users/{}", "POST /users"],
	);
	assert.deepEqual(
		joined.onlyLeft.map((entry) => entry.key),
		["GET /health", "POST /orders"],
	);
	assert.deepEqual(
		joined.onlyRight.map((entry) => entry.key),
		["GET /reports", "PUT /orders"],
	);
	assert.deepEqual(joined.related, [
		{
			by: "/orders",
			left: [{ key: "POST /orders", row: code[2] }],
			right: [{ key: "PUT /orders", row: docs[2] }],
		},
	]);
});

test("conflicts name the field and both values; trimmed equal values are not conflicts", () => {
	const joined = keyedJoin(code, docs, options);
	assert.deepEqual(joined.conflicts, [
		{ key: "GET /users/{}", field: "handler", left: "show", right: "get" },
	]);
});

test("a path-only key would have joined GET and DELETE of one path: the composite key keeps them apart", () => {
	const byPath = keyedJoin(code, docs, {
		key: ["path"],
		normalize: { path: options.normalize.path },
	});
	assert.ok(byPath.duplicates.length > 0, "path alone sees repeated keys");
	const composite = keyedJoin(code, docs, options);
	assert.equal(composite.duplicates.length, 0);
});

test("rows missing a key field are unkeyed, repeats are listed, objects never become keys", () => {
	const joined = keyedJoin(
		[
			{ method: "GET", path: "/a" },
			{ method: "GET", path: "/a" },
			{ method: "GET" },
			{ method: "GET", path: { x: 1 } },
			null,
		],
		[{ method: "GET", path: "/a" }],
		options,
	);
	assert.equal(joined.bothCount, 1);
	assert.deepEqual(joined.duplicates, [
		{ side: "left", key: "GET /a", count: 2 },
	]);
	assert.deepEqual(
		joined.unkeyed.left.map((entry) => entry.index),
		[2, 3, 4],
	);
});

test("rightKey joins differently named fields; compare pairs, compareNormalize and hooks work", () => {
	const joined = keyedJoin(
		[{ name: "Alpha", size: 3 }],
		[
			{ title: "alpha", n: 3 },
			{ title: "beta", n: 1 },
		],
		{
			key: ["name"],
			rightKey: ["title"],
			normalize: { name: ["lower", "shout"] },
			hooks: { shout: (text) => `${text}!` },
			compare: [{ left: "size", right: "n" }],
		},
	);
	assert.deepEqual(
		joined.both.map((entry) => entry.key),
		["alpha!"],
	);
	assert.deepEqual(joined.conflicts, []);
	assert.deepEqual(
		joined.onlyRight.map((entry) => entry.key),
		["beta!"],
	);
	const differing = keyedJoin(
		[{ k: "a", v: { x: 1, y: 2 } }],
		[{ k: "a", v: { y: 2, x: 1 } }],
		{ key: ["k"], compare: ["v"] },
	);
	assert.deepEqual(
		differing.conflicts,
		[],
		"object values compare by sorted-key JSON",
	);
});

test("path-params unifies :id, {id}, <id>, [id] and ${id}; unknown ops and bad options throw", () => {
	for (const style of [
		"/a/:id/b",
		"/a/{id}/b",
		"/a/<id>/b",
		"/a/[id]/b",
		"/a/${id}/b",
	])
		assert.equal(normalizeValue(style, ["path-params"]), "/a/{}/b");
	assert.equal(normalizeValue("  ", ["trim"]), undefined);
	assert.equal(normalizeValue("/", ["trailing-slash"]), "/");
	assert.equal(normalizeValue("/x//", ["trailing-slash"]), "/x");
	assert.throws(() => normalizeValue("a", ["nope"]), /unknown normalize op/);
	assert.throws(() => keyedJoin([], [], {}), /options\.key/);
	assert.throws(
		() => keyedJoin([], [], { key: ["a"], rightKey: [] }),
		/as long as key/,
	);
	assert.throws(
		() => keyedJoin([], [], { key: ["a"], relatedBy: ["b"] }),
		/not in key/,
	);
});

test("the helper reads two sources and returns a counted, deterministic control", async () => {
	const sources = { routes: { routes: code }, docs: { endpoints: docs } };
	const args = {
		sources,
		context: {},
		options: {
			...options,
			left: { from: "routes", rows: "routes" },
			right: { from: "docs", rows: "endpoints" },
		},
	};
	const out = await helper(args);
	assert.equal(out.status, "passed");
	assert.deepEqual(out.counts, {
		left: 5,
		right: 5,
		both: 3,
		onlyLeft: 2,
		onlyRight: 2,
		conflicts: 1,
		related: 1,
		duplicates: 0,
		unkeyed: 0,
	});
	assert.equal(out.both.length, 3);
	assert.equal(JSON.stringify(out), JSON.stringify(await helper(args)));
	const slim = await helper({
		...args,
		options: { ...args.options, includeBoth: false },
	});
	assert.equal(slim.both.length, 0);
	assert.equal(slim.counts.both, 3);
	await assert.rejects(
		helper({ sources: {}, context: {}, options: args.options }),
		/not a completed source/,
	);
	await assert.rejects(
		helper({
			sources,
			context: {},
			options: { ...options, left: {}, right: {} },
		}),
		/need a from/,
	);
});
