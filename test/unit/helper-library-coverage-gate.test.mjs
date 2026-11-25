import assert from "node:assert/strict";
import { test } from "node:test";
import helper, {
	coverageGate,
} from "../../src/core/helper-library/coverage-gate.mjs";

const modules = [
	"auth",
	"cache",
	"config",
	"db",
	"logger",
	"queue",
	"router",
	"scheduler",
	"storage",
	"validator",
];
const expected = modules.map((name) => `M-${name}`);

test("a worker's lowercased prefix still covers the canonical ID; a truly missing module is reported", () => {
	const produced = expected.map((id) =>
		id === "M-logger" ? "  m-logger " : id,
	);
	const complete = coverageGate(expected, produced, { policy: "block" });
	assert.equal(complete.summary, "10 of 10 covered");
	assert.equal(complete.status, "passed");
	assert.deepEqual(complete.kept, expected);
	const partial = coverageGate(
		expected,
		produced.filter((id) => id !== "M-queue"),
		{ policy: "block" },
	);
	assert.equal(partial.summary, "9 of 10 covered; missing: M-queue");
	assert.deepEqual(partial.missing, ["M-queue"]);
	assert.equal(partial.status, "blocked");
	assert.deepEqual(partial.gates, { passed: false });
});

test("prefixes and aliases are applied consistently; duplicates never inflate coverage", () => {
	const result = coverageGate(
		["M-Queue", "worker:queue", "M-logger"],
		["old-queue", " QUEUE ", "worker:EXTRA", null],
		{
			prefixes: ["M-", "worker:"],
			aliases: { "OLD-QUEUE": "m-queue" },
		},
	);
	assert.equal(result.status, "passed");
	assert.equal(result.complete, false);
	assert.deepEqual(result.kept, ["M-Queue"]);
	assert.deepEqual(result.missing, ["M-logger"]);
	assert.deepEqual(result.extra, ["worker:EXTRA"]);
	assert.deepEqual(result.duplicates, [
		{ side: "expected", key: "queue", count: 2 },
		{ side: "produced", key: "queue", count: 2 },
	]);
	assert.deepEqual(result.invalid, { expected: [], produced: [3] });
	assert.deepEqual(result.counts, {
		expected: 2,
		produced: 2,
		covered: 1,
		missing: 1,
		extra: 1,
		duplicates: 2,
		invalid: 1,
	});
	assert.equal(coverageGate(["ID"], ["id"], { normalize: [] }).complete, false);
	assert.throws(
		() => coverageGate([], [], { policy: "warn" }),
		/options.policy/,
	);
	assert.throws(
		() => coverageGate([], [], { aliases: { X: "a", x: "b" } }),
		/one nonempty ID/,
	);
});

test("stage collects IDs from paths, produced controls and only completed foreach items", async () => {
	const sources = {
		inventory: { list: { modules: expected.map((id) => ({ entry: { id } })) } },
		"work.one": { result: { id: "m-auth" } },
		"work.two": { result: { id: "M-cache" } },
		"work.three": { result: { id: "not-completed" } },
		"other.one": { id: "ignore-the-echo" },
		reused: { ids: expected.slice(3) },
	};
	const options = {
		expected: { from: "inventory", rows: "$.list.modules", field: "entry.id" },
		produced: [
			{ from: "work", rows: null, field: "result.id" },
			{ from: "other", identity: true },
			{ from: "reused", rows: "ids" },
		],
		policy: "block",
	};
	const context = {
		sourceStatuses: [
			{
				source: "work.one",
				stageId: "work",
				itemIdentity: "M-auth",
				status: "completed",
			},
			{
				source: "work.two",
				stageId: "work",
				itemIdentity: "M-cache",
				status: "completed",
			},
			{
				source: "work.three",
				stageId: "work",
				itemIdentity: "M-db",
				status: "failed",
			},
			{
				source: "other.one",
				stageId: "other",
				itemIdentity: "m-config",
				status: "completed",
			},
		],
	};
	const result = await helper({ sources, options, context });
	assert.equal(result.status, "passed");
	assert.equal(result.summary, "10 of 10 covered");
	assert.deepEqual(await helper({ sources, options, context }), result);
	await assert.rejects(
		helper({
			sources,
			options: { ...options, produced: { from: "unknown" } },
			context,
		}),
		/not a source/,
	);
	await assert.rejects(
		helper({
			sources,
			options: { ...options, expected: { from: "inventory", rows: "typo" } },
			context,
		}),
		/no array at typo/,
	);
});

test("a known failed producer is counted as missing, not a wiring error", async () => {
	const args = {
		sources: { inventory: { items: [{ id: "M-logger" }] } },
		options: {
			expected: { from: "inventory" },
			produced: { from: "work", rows: null },
			policy: "block",
		},
		context: {
			sourceStatuses: [
				{
					source: "work.one",
					stageId: "work",
					itemIdentity: "M-logger",
					status: "failed",
				},
			],
		},
	};
	assert.equal(
		(await helper(args)).summary,
		"0 of 1 covered; missing: M-logger",
	);
});
