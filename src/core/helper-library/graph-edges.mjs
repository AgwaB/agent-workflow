// graph-edges.mjs: build a directed graph from rows (from -> to), report its cycles and strongly connected
// components, and rank hubs by degree. Deterministic, no file or network access, no model call.
//
//   { "id": "graph", "from": ["modules"], "support": { "uses": "./helpers/graph-edges.mjs",
//     "options": { "from": "modules", "rows": "modules", "fromField": "name", "toField": "imports",
//                  "normalize": ["trim", "strip-dot-slash", "strip-ext"], "maxCycleLength": 6, "top": 5 } } }
//
// Options
//   from            stage id or source key (or an array). A stage id with foreach items collects every
//                   completed item (through context.sourceStatuses). Required.
//   rows            row-array path inside each control (default "items"; "$." prefix optional).
//   fromField / toField   field paths of one row (defaults "from" / "to"). toField may hold one string or an
//                   array of strings (e.g. a module's imports); a row with an empty one still adds its node.
//   normalize       node-name ops, in order (default ["trim"]): trim, lower, strip-dot-slash ("./a" -> "a"),
//                   strip-ext ("a.js" -> "a"). In code pass functions: buildGraph(rows, { normalize: [fn] }).
//   ignoreSelfLoops true leaves a -> a out of the cycles (default false: a self loop is a cycle of length 1).
//   maxCycleLength  longest simple cycle listed (default 8, at most 50). maxCycles (default 100) and an
//                   internal step budget cap the enumeration: `cyclesTruncated: true` says the list is not
//                   complete (the SCCs always are).
//   top / minDegree hubs listed (default 5) and the smallest degree that counts as a hub (default 2).
//   includeEdges    true also returns the deduplicated edge list.
// Output (declare these keys in the stage's controlSchema)
//   { schema: "graph-edges-v1", digest, status: "passed", counts: { nodes, edges, cycles, sccs, selfLoops },
//     cycles: [{ nodes, length, path }]   each cycle once, starting at its smallest node, shortest first:
//                                        queue <-> scheduler is { nodes: ["queue","scheduler"], path: "queue -> scheduler -> queue" },
//     cyclesTruncated, sccs: [{ nodes, size }]   components with more than one node (or a self loop),
//     hubs: [{ node, in, out, degree }]  degree = in + out, highest first, ties by in then name,
//     edges?: [[from, to]] }
//   A cycle is a finding, not a failure: the stage passes. Sorted everywhere, so the same rows give the same bytes.

const clip = (value, max) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
const MAX_CYCLE_LENGTH = 50;
const STEP_BUDGET = 200000;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const NODE_OPS = {
	trim: (text) => text.trim(),
	lower: (text) => text.toLowerCase(),
	"strip-dot-slash": (text) => text.replace(/^(\.\/)+/, ""),
	"strip-ext": (text) => text.replace(/\.[A-Za-z0-9]+$/, ""),
};

function pick(value, path) {
	let cursor = value;
	for (const part of String(path)
		.replace(/^\$\.?/, "")
		.split(".")) {
		if (part === "") continue;
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = cursor[part];
	}
	return cursor;
}

/** Graph of the rows: sorted `nodes`, deduplicated sorted `edges` [from, to], adjacency `out`/`into` maps. */
export function buildGraph(rows, options) {
	const opts = options ?? {};
	const fromField = opts.fromField ?? "from";
	const toField = opts.toField ?? "to";
	const ops = (opts.normalize ?? ["trim"]).map((op) => {
		const fn = typeof op === "function" ? op : NODE_OPS[op];
		if (typeof fn !== "function")
			throw new Error(`graph-edges: unknown normalize op "${op}"`);
		return fn;
	});
	const name = (value) => {
		if (typeof value !== "string") return "";
		let out = value;
		for (const fn of ops) out = fn(out);
		return out;
	};
	const nodes = new Set();
	const edgeSet = new Set();
	const edges = [];
	for (const row of rows) {
		const from = name(pick(row, fromField));
		if (from === "") continue;
		nodes.add(from);
		const raw = pick(row, toField);
		for (const target of Array.isArray(raw) ? raw : [raw]) {
			const to = name(target);
			if (to === "") continue;
			nodes.add(to);
			if (opts.ignoreSelfLoops === true && to === from) continue;
			const id = JSON.stringify([from, to]);
			if (edgeSet.has(id)) continue;
			edgeSet.add(id);
			edges.push([from, to]);
		}
	}
	const sorted = [...nodes].sort(order);
	edges.sort((a, b) => order(a[0], b[0]) || order(a[1], b[1]));
	const out = new Map(sorted.map((node) => [node, []]));
	const into = new Map(sorted.map((node) => [node, []]));
	for (const [from, to] of edges) {
		out.get(from).push(to);
		into.get(to).push(from);
	}
	return { nodes: sorted, edges, out, into };
}

/** Strongly connected components (Tarjan, iterative): only those with 2+ nodes or a self loop, sorted. */
export function stronglyConnected(graph) {
	const index = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const found = [];
	let counter = 0;
	for (const root of graph.nodes) {
		if (index.has(root)) continue;
		const work = [[root, 0]];
		index.set(root, counter);
		low.set(root, counter++);
		stack.push(root);
		onStack.add(root);
		while (work.length > 0) {
			const frame = work[work.length - 1];
			const [node, next] = frame;
			const targets = graph.out.get(node);
			if (next < targets.length) {
				frame[1]++;
				const to = targets[next];
				if (!index.has(to)) {
					index.set(to, counter);
					low.set(to, counter++);
					stack.push(to);
					onStack.add(to);
					work.push([to, 0]);
				} else if (onStack.has(to)) {
					low.set(node, Math.min(low.get(node), index.get(to)));
				}
				continue;
			}
			work.pop();
			if (work.length > 0) {
				const parent = work[work.length - 1][0];
				low.set(parent, Math.min(low.get(parent), low.get(node)));
			}
			if (low.get(node) === index.get(node)) {
				const component = [];
				for (;;) {
					const member = stack.pop();
					onStack.delete(member);
					component.push(member);
					if (member === node) break;
				}
				if (component.length > 1 || graph.out.get(node).includes(node))
					found.push(component.sort(order));
			}
		}
	}
	return found.sort((a, b) => order(a[0], b[0]));
}

/** Simple cycles up to `maxLength` nodes, each once from its smallest node, shortest first. */
export function findCycles(graph, options) {
	const opts = options ?? {};
	const maxLength = Math.min(
		Number.isInteger(opts.maxLength) && opts.maxLength > 0 ? opts.maxLength : 8,
		MAX_CYCLE_LENGTH,
	);
	const maxCycles =
		Number.isInteger(opts.maxCycles) && opts.maxCycles > 0
			? opts.maxCycles
			: 100;
	const component = new Map();
	for (const [position, members] of stronglyConnected(graph).entries())
		for (const member of members) component.set(member, position);
	const rank = new Map(graph.nodes.map((node, position) => [node, position]));
	const cycles = [];
	let steps = 0;
	let truncated = false;
	const walk = (start, path, seen) => {
		const node = path[path.length - 1];
		for (const to of graph.out.get(node)) {
			if (truncated) return;
			if (++steps > STEP_BUDGET) {
				truncated = true;
				return;
			}
			if (to === start) {
				if (cycles.length >= maxCycles) {
					truncated = true;
					return;
				}
				cycles.push([...path]);
			} else if (
				path.length < maxLength &&
				!seen.has(to) &&
				rank.get(to) > rank.get(start) &&
				component.get(to) === component.get(start)
			) {
				seen.add(to);
				path.push(to);
				walk(start, path, seen);
				path.pop();
				seen.delete(to);
			}
		}
	};
	for (const start of graph.nodes) {
		if (!component.has(start) || truncated) continue;
		walk(start, [start], new Set([start]));
	}
	cycles.sort(
		(a, b) => a.length - b.length || order(a.join("\0"), b.join("\0")),
	);
	return { cycles, truncated };
}

/** Nodes with the most edges (in + out), highest first. */
export function hubs(graph, options) {
	const opts = options ?? {};
	const top = Number.isInteger(opts.top) && opts.top >= 0 ? opts.top : 5;
	const minDegree = Number.isInteger(opts.minDegree) ? opts.minDegree : 2;
	return graph.nodes
		.map((node) => {
			const outgoing = graph.out.get(node).length;
			const incoming = graph.into.get(node).length;
			return { node, in: incoming, out: outgoing, degree: incoming + outgoing };
		})
		.filter((entry) => entry.degree >= minDegree)
		.sort((a, b) => b.degree - a.degree || b.in - a.in || order(a.node, b.node))
		.slice(0, top);
}

function collectRows(from, rowsPath, sources, context) {
	if (from === undefined)
		throw new Error("graph-edges: options.from names the source stage");
	const rows = [];
	const statuses = Array.isArray(context?.sourceStatuses)
		? context.sourceStatuses
		: [];
	for (const name of Array.isArray(from) ? from : [from]) {
		const items = statuses
			.filter(
				(row) =>
					row.stageId === name &&
					row.itemIdentity !== undefined &&
					sources[row.source] !== undefined,
			)
			.map((row) => row.source);
		const keys = items.length > 0 ? items : name in sources ? [name] : [];
		if (keys.length === 0)
			throw new Error(
				`graph-edges: "${name}" is not a completed source of this stage`,
			);
		for (const key of keys) {
			const list = pick(sources[key], rowsPath);
			if (!Array.isArray(list))
				throw new Error(
					`graph-edges: source "${key}" has no array at ${rowsPath}`,
				);
			rows.push(...list);
		}
	}
	return rows;
}

export default async function helper({ sources, options, context }) {
	const opts = options ?? {};
	const graph = buildGraph(
		collectRows(opts.from, opts.rows ?? "items", sources, context),
		opts,
	);
	const { cycles, truncated } = findCycles(graph, {
		maxLength: opts.maxCycleLength,
		maxCycles: opts.maxCycles,
	});
	const sccs = stronglyConnected(graph);
	const selfLoops = graph.edges.filter(([from, to]) => from === to).length;
	const counts = {
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		cycles: cycles.length,
		sccs: sccs.length,
		selfLoops,
	};
	return {
		schema: "graph-edges-v1",
		digest: clip(
			`${counts.nodes} nodes, ${counts.edges} edges, ${counts.cycles} cycles${truncated ? " (list truncated)" : ""}, ${counts.sccs} cyclic components`,
			200,
		),
		status: "passed",
		counts,
		cycles: cycles.map((nodes) => ({
			nodes,
			length: nodes.length,
			path: [...nodes, nodes[0]].join(" -> "),
		})),
		cyclesTruncated: truncated,
		sccs: sccs.map((nodes) => ({ nodes, size: nodes.length })),
		hubs: hubs(graph, { top: opts.top, minDegree: opts.minDegree }),
		...(opts.includeEdges === true ? { edges: graph.edges } : {}),
	};
}
