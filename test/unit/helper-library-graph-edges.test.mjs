// graph-edges: the novel-briefs N3 failure (no cycle detection: the queue <-> scheduler import cycle).
import assert from "node:assert/strict";
import { test } from "node:test";

const graphs = await import("../../src/core/helper-library/graph-edges.mjs");
const helper = graphs.default;

const modules = [
	{ name: "queue", imports: ["./scheduler.js", "./log.js"] },
	{ name: "scheduler", imports: ["./queue.js", "./log.js", "./clock.js"] },
	{ name: "clock", imports: [] },
	{ name: "log", imports: ["./clock.js"] },
	{ name: "api", imports: ["./queue.js", "./log.js"] },
];
const options = {
	fromField: "name",
	toField: "imports",
	normalize: ["trim", "strip-dot-slash", "strip-ext"],
};

test("the queue <-> scheduler cycle is found, once, from its smallest node", () => {
	const graph = graphs.buildGraph(modules, options);
	assert.deepEqual(graph.nodes, ["api", "clock", "log", "queue", "scheduler"]);
	assert.equal(graph.edges.length, 8);
	const { cycles, truncated } = graphs.findCycles(graph);
	assert.deepEqual(cycles, [["queue", "scheduler"]]);
	assert.equal(truncated, false);
	assert.deepEqual(graphs.stronglyConnected(graph), [["queue", "scheduler"]]);
});

test("longer cycles, self loops, a diamond with no cycle, and the length bound", () => {
	const ring = graphs.buildGraph([
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "c", to: "a" },
		{ from: "c", to: "d" },
		{ from: "d", to: "d" },
		{ from: "a", to: "c" },
	]);
	const all = graphs.findCycles(ring);
	assert.deepEqual(all.cycles, [["d"], ["a", "c"], ["a", "b", "c"]]);
	assert.deepEqual(graphs.findCycles(ring, { maxLength: 2 }).cycles, [
		["d"],
		["a", "c"],
	]);
	assert.deepEqual(graphs.stronglyConnected(ring), [["a", "b", "c"], ["d"]]);
	const quiet = graphs.buildGraph(
		[
			{ from: "d", to: "d" },
			{ from: "a", to: "b" },
		],
		{ ignoreSelfLoops: true },
	);
	assert.deepEqual(graphs.findCycles(quiet).cycles, []);
	const diamond = graphs.buildGraph([
		{ from: "a", to: ["b", "c"] },
		{ from: "b", to: "d" },
		{ from: "c", to: "d" },
	]);
	assert.deepEqual(graphs.findCycles(diamond).cycles, []);
	assert.deepEqual(graphs.stronglyConnected(diamond), []);
});

test("a dense graph is cut at maxCycles and says so", () => {
	const names = ["a", "b", "c", "d", "e", "f"];
	const rows = names.map((from) => ({
		from,
		to: names.filter((to) => to !== from),
	}));
	const full = graphs.findCycles(graphs.buildGraph(rows), {
		maxLength: 6,
		maxCycles: 100000,
	});
	assert.equal(full.truncated, false);
	assert.equal(
		full.cycles.length,
		409,
		"simple cycles of the complete digraph K6",
	);
	const cut = graphs.findCycles(graphs.buildGraph(rows), {
		maxLength: 6,
		maxCycles: 5,
	});
	assert.equal(cut.truncated, true);
	assert.equal(cut.cycles.length, 5);
});

test("hubs rank by in + out degree, ties by in then name, and honour top and minDegree", () => {
	const graph = graphs.buildGraph(modules, options);
	assert.deepEqual(graphs.hubs(graph, { top: 3 }), [
		{ node: "log", in: 3, out: 1, degree: 4 },
		{ node: "queue", in: 2, out: 2, degree: 4 },
		{ node: "scheduler", in: 1, out: 3, degree: 4 },
	]);
	assert.equal(graphs.hubs(graph, { top: 10, minDegree: 1 }).length, 5);
	assert.deepEqual(graphs.hubs(graph, { top: 0 }), []);
});

test("the helper returns counts, cycles with a printable path, sccs and hubs; deterministic", async () => {
	const args = {
		sources: { modules: { modules } },
		context: {},
		options: { ...options, from: "modules", rows: "modules" },
	};
	const out = await helper(args);
	assert.equal(out.status, "passed");
	assert.deepEqual(out.counts, {
		nodes: 5,
		edges: 8,
		cycles: 1,
		sccs: 1,
		selfLoops: 0,
	});
	assert.deepEqual(out.cycles, [
		{
			nodes: ["queue", "scheduler"],
			length: 2,
			path: "queue -> scheduler -> queue",
		},
	]);
	assert.equal(out.cyclesTruncated, false);
	assert.deepEqual(out.sccs, [{ nodes: ["queue", "scheduler"], size: 2 }]);
	assert.equal(out.hubs[0].node, "log");
	assert.equal(out.edges, undefined);
	assert.match(out.digest, /1 cycles/);
	assert.equal(JSON.stringify(out), JSON.stringify(await helper(args)));
	const withEdges = await helper({
		...args,
		options: { ...args.options, includeEdges: true },
	});
	assert.equal(withEdges.edges.length, 8);
});

test("foreach items are collected through sourceStatuses; unknown ops and sources throw", async () => {
	const context = {
		sourceStatuses: [
			{ source: "map", stageId: "map", itemIdentity: "a", status: "completed" },
			{
				source: "map.b",
				stageId: "map",
				itemIdentity: "b",
				status: "completed",
			},
		],
	};
	const out = await helper({
		sources: {
			map: { items: [{ from: "x", to: "y" }] },
			"map.b": { items: [{ from: "y", to: "x" }] },
		},
		context,
		options: { from: "map" },
	});
	assert.deepEqual(
		out.cycles.map((cycle) => cycle.nodes),
		[["x", "y"]],
	);
	assert.throws(
		() => graphs.buildGraph([], { normalize: ["nope"] }),
		/unknown normalize op/,
	);
	await assert.rejects(
		helper({ sources: {}, context: {}, options: { from: "none" } }),
		/not a completed source/,
	);
	await assert.rejects(
		helper({ sources: {}, context: {}, options: {} }),
		/options\.from/,
	);
});
