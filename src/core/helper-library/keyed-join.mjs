// keyed-join.mjs: join or diff two row lists by a COMPOSITE key (for example method + path) and report what is
// only on the left, only on the right, on both sides, and which named fields disagree on the rows that are on
// both. Deterministic, no file or network access, no model call.
//
//   { "id": "diff", "from": ["routes", "docs"], "support": { "uses": "./helpers/keyed-join.mjs",
//     "options": { "left": { "from": "routes", "rows": "routes" }, "right": { "from": "docs", "rows": "endpoints" },
//                  "key": ["method", "path"],
//                  "normalize": { "method": ["trim", "upper"], "path": ["trim", "strip-query", "path-params", "trailing-slash"] },
//                  "compare": ["handler"], "relatedBy": ["path"] } } }
//
// Options
//   left, right   { from, rows }: stage id or source key (or an array) and the row-array path inside each
//                 control (default "items"). A stage id with foreach items collects every completed item.
//   key           the field paths (dotted) that together identify a row; a row missing one is "unkeyed".
//   rightKey      the right side's field paths when they are named differently (same length as `key`).
//   normalize     { <key field path>: [op...] } applied to the key values before comparing (default ["trim"]).
//                 ops: trim, lower, upper, collapse-space, strip-query, trailing-slash, leading-slash,
//                 path-params (":id", "{id}", "<id>", "[id]" all become "{}", so "/u/:id" equals "/u/{userId}").
//                 In code use keyedJoin(left, right, { hooks: { myOp: (text) => text } }) and name myOp.
//   compare       fields (strings, or { left, right } pairs) compared on rows found on both sides; a
//                 difference is a conflict. compareNormalize: { <field>: [op...] } (default trim + collapse-space).
//   relatedBy     a subset of `key` (e.g. ["path"]): rows only on one side that share that part with a row only
//                 on the other side are paired in `related`, so "same path, different method" is one finding.
//   includeBoth   false leaves `both` out (default true).
// Output (declare these keys in the stage's controlSchema)
//   { schema: "keyed-join-v1", digest, status: "passed", counts,
//     onlyLeft: [{ key, parts, row }], onlyRight: [{ key, parts, row }],
//     both: [{ key, parts, left, right }], conflicts: [{ key, field, left, right }],
//     related: [{ by, left: [{ key, row }], right: [{ key, row }] }],
//     duplicates: [{ side, key, count }], unkeyed: { left: [{ index, row }], right: [{ index, row }] } }
//   key is the normalised values joined by a space ("GET /users/{}"); parts has them by field path. When a key
//   occurs twice on one side the first row is joined and the repeat is listed in `duplicates`.
//   Everything is sorted by key, so the same rows always give the same bytes.

import { applyOps, normalizeValue } from "./key-normalize.mjs";
export { NORMALIZERS, normalizeValue } from "./key-normalize.mjs";

const clip = (value, max) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);

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

const canonical = (value) =>
	JSON.stringify(value, (_, inner) =>
		inner !== null && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: inner,
	);

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function indexSide(rows, paths, names, normalize, hooks, side) {
	const found = new Map();
	const unkeyed = [];
	const duplicates = new Map();
	for (const [index, row] of rows.entries()) {
		const parts = {};
		let complete = row !== null && typeof row === "object";
		for (const [position, path] of paths.entries()) {
			if (!complete) break;
			const value = normalizeValue(
				pick(row, path),
				normalize?.[names[position]],
				hooks,
				names[position],
			);
			if (value === undefined) complete = false;
			else parts[names[position]] = value;
		}
		if (!complete) {
			unkeyed.push({ index, row });
			continue;
		}
		const key = names.map((name) => parts[name]).join(" ");
		if (found.has(key)) {
			duplicates.set(key, (duplicates.get(key) ?? 1) + 1);
			continue;
		}
		found.set(key, { key, parts, row });
	}
	return {
		found,
		unkeyed,
		duplicates: [...duplicates].map(([key, count]) => ({ side, key, count })),
	};
}

/** Pure join of two row arrays; see the header for the options. */
export function keyedJoin(leftRows, rightRows, options) {
	const opts = options ?? {};
	const names = Array.isArray(opts.key) ? opts.key.map(String) : [];
	if (names.length === 0)
		throw new Error("keyed-join: options.key lists the key field paths");
	const rightPaths = Array.isArray(opts.rightKey) ? opts.rightKey : names;
	if (rightPaths.length !== names.length)
		throw new Error("keyed-join: rightKey must be as long as key");
	const left = indexSide(
		leftRows,
		names,
		names,
		opts.normalize,
		opts.hooks,
		"left",
	);
	const right = indexSide(
		rightRows,
		rightPaths,
		names,
		opts.normalize,
		opts.hooks,
		"right",
	);
	const compare = (Array.isArray(opts.compare) ? opts.compare : []).map(
		(entry) =>
			typeof entry === "string"
				? { left: entry, right: entry }
				: {
						left: String(entry.left),
						right: String(entry.right ?? entry.left),
					},
	);
	const sameValue = (field, a, b) => {
		const ops = opts.compareNormalize?.[field.left] ?? [
			"trim",
			"collapse-space",
		];
		const tidy = (value) =>
			typeof value === "string"
				? applyOps(value, ops, opts.hooks, field.left)
				: value;
		return canonical(tidy(a)) === canonical(tidy(b));
	};
	const onlyLeft = [];
	const onlyRight = [];
	const both = [];
	const conflicts = [];
	for (const entry of left.found.values()) {
		const other = right.found.get(entry.key);
		if (other === undefined) {
			onlyLeft.push(entry);
			continue;
		}
		both.push({
			key: entry.key,
			parts: entry.parts,
			left: entry.row,
			right: other.row,
		});
		for (const field of compare) {
			const a = pick(entry.row, field.left);
			const b = pick(other.row, field.right);
			if (!sameValue(field, a, b))
				conflicts.push({
					key: entry.key,
					field: field.left,
					left: a ?? null,
					right: b ?? null,
				});
		}
	}
	for (const entry of right.found.values())
		if (!left.found.has(entry.key)) onlyRight.push(entry);
	onlyLeft.sort(byKey);
	onlyRight.sort(byKey);
	both.sort(byKey);
	conflicts.sort(
		(a, b) =>
			byKey(a, b) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0),
	);

	const related = [];
	const by = Array.isArray(opts.relatedBy) ? opts.relatedBy.map(String) : [];
	if (by.length > 0) {
		for (const name of by)
			if (!names.includes(name))
				throw new Error(`keyed-join: relatedBy "${name}" is not in key`);
		const sub = (entry) => by.map((name) => entry.parts[name]).join(" ");
		const groups = new Map();
		for (const [side, list] of [
			["left", onlyLeft],
			["right", onlyRight],
		])
			for (const entry of list) {
				const group = groups.get(sub(entry)) ?? {
					by: sub(entry),
					left: [],
					right: [],
				};
				group[side].push({ key: entry.key, row: entry.row });
				groups.set(sub(entry), group);
			}
		for (const group of [...groups.values()].sort((a, b) =>
			a.by < b.by ? -1 : a.by > b.by ? 1 : 0,
		))
			if (group.left.length > 0 && group.right.length > 0) related.push(group);
	}
	const duplicates = [...left.duplicates, ...right.duplicates].sort(
		(a, b) => byKey(a, b) || (a.side < b.side ? -1 : 1),
	);
	return {
		onlyLeft,
		onlyRight,
		both: opts.includeBoth === false ? [] : both,
		bothCount: both.length,
		conflicts,
		related,
		duplicates,
		unkeyed: { left: left.unkeyed, right: right.unkeyed },
	};
}

/** Rows of the named sources: stage ids collect their foreach items, source keys are read directly. */
function collectRows(side, sources, context) {
	const from = side?.from;
	if (from === undefined)
		throw new Error("keyed-join: left and right each need a from");
	const path = side.rows ?? "items";
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
				`keyed-join: "${name}" is not a completed source of this stage`,
			);
		for (const key of keys) {
			const list = pick(sources[key], path);
			if (!Array.isArray(list))
				throw new Error(`keyed-join: source "${key}" has no array at ${path}`);
			rows.push(...list);
		}
	}
	return rows;
}

export default async function helper({ sources, options, context }) {
	const opts = options ?? {};
	const left = collectRows(opts.left, sources, context);
	const right = collectRows(opts.right, sources, context);
	const joined = keyedJoin(left, right, opts);
	const { bothCount, ...rest } = joined;
	const counts = {
		left: left.length,
		right: right.length,
		both: bothCount,
		onlyLeft: joined.onlyLeft.length,
		onlyRight: joined.onlyRight.length,
		conflicts: joined.conflicts.length,
		related: joined.related.length,
		duplicates: joined.duplicates.length,
		unkeyed: joined.unkeyed.left.length + joined.unkeyed.right.length,
	};
	return {
		schema: "keyed-join-v1",
		digest: clip(
			`${counts.both} on both sides, ${counts.onlyLeft} only left, ${counts.onlyRight} only right, ${counts.conflicts} field conflicts`,
			200,
		),
		status: "passed",
		counts,
		...rest,
	};
}
