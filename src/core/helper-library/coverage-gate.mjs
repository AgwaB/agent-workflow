// coverage-gate.mjs: check that produced IDs cover the expected inventory, without trusting equal counts.
// Deterministic, no model or file access. Import coverageGate(expectedIds, producedIds, options) in code.
//
//   { "id": "coverage", "from": ["inventory", "work"], "sourcePolicy": "partial",
//     "support": { "uses": "./helpers/coverage-gate.mjs", "options": {
//       "expected": { "from": "inventory", "rows": "modules", "field": "id" },
//       "produced": { "from": "work", "identity": true }, "policy": "block" } } }
//
// Options
//   expected, produced   { from, rows, field, identity }; produced may be an array of these descriptors.
//     from    stage id, source key, or array of names. A foreach stage collects every completed item.
//     rows    path to an array (default "items") whose entries are IDs or objects; null reads each control
//             as one object (e.g. one worker-echoed ID per foreach task).
//     field   dotted path in an object (default "id"). Scalar array entries are read directly.
//     identity  true uses completed foreach engine item identities instead of model-echoed control fields.
//   normalize   key-normalize operations (default ["trim", "lower"]; [] for exact matching).
//   prefixes    optional prefixes to strip once (longest match); applied after normalize on both sides.
//   aliases     optional alias -> canonical ID map (one lookup; keys and values normalized, prefixes stripped).
//   policy      "drop" (default): keep one produced ID per expected key, list discrepancies, pass;
//               "block": declare blocked for any missing, extra, duplicate or invalid ID.
// Output (declare these keys in the stage's controlSchema):
//   { schema: "coverage-gate-v1", digest, status, gates: { passed }, policy, complete, counts,
//     kept, missing, extra, duplicates: [{ side, key, count }], invalid: { expected: [index...], produced: [index...] },
//     summary }
//   kept/missing use the first expected spelling, and extra uses the first produced spelling. IDs and
//   duplicates are ordered by normalized key. Counts.expected/produced count distinct valid IDs.
import { normalizeValue } from "./key-normalize.mjs";

function idNormalizer({
	normalize = ["trim", "lower"],
	prefixes = [],
	aliases = {},
}) {
	const key = (value) => normalizeValue(value, normalize);
	const strip = prefixes
		.map((prefix) => {
			const value = key(prefix);
			if (value === undefined)
				throw new Error("coverage-gate: prefixes must be nonempty");
			return value;
		})
		.sort((a, b) => b.length - a.length);
	const prepared = (value) => {
		const id = key(value);
		if (id === undefined) return undefined;
		const prefix = strip.find((part) => id.startsWith(part));
		return prefix === undefined ? id : key(id.slice(prefix.length));
	};
	const mapped = new Map();
	for (const [alias, canonical] of Object.entries(aliases)) {
		const from = prepared(alias);
		const to = prepared(canonical);
		if (
			from === undefined ||
			to === undefined ||
			(mapped.has(from) && mapped.get(from) !== to)
		)
			throw new Error(
				"coverage-gate: aliases must map each normalized key to one nonempty ID",
			);
		mapped.set(from, to);
	}
	return (value) => {
		const id = prepared(value);
		return mapped.get(id) ?? id;
	};
}

function indexIds(values, key) {
	const entries = new Map();
	const invalid = [];
	for (const [index, value] of values.entries()) {
		const id = key(value);
		if (id === undefined) {
			invalid.push(index);
			continue;
		}
		const existing = entries.get(id);
		if (existing) existing.count++;
		else entries.set(id, { text: String(value).trim(), count: 1 });
	}
	return { entries, invalid };
}

/** Pure coverage comparison; expectedIds and producedIds are arrays of ID values. */
export function coverageGate(expectedIds, producedIds, options = {}) {
	const policy = options.policy ?? "drop";
	if (policy !== "drop" && policy !== "block")
		throw new Error('coverage-gate: options.policy must be "drop" or "block"');
	const key = idNormalizer(options);
	const expected = indexIds(expectedIds, key);
	const produced = indexIds(producedIds, key);
	const invalid = { expected: expected.invalid, produced: produced.invalid };
	const kept = [];
	const missing = [];
	const extra = [];
	const duplicates = [];
	const keys = [
		...new Set([...expected.entries.keys(), ...produced.entries.keys()]),
	].sort();
	for (const key of keys) {
		const a = expected.entries.get(key);
		const b = produced.entries.get(key);
		if (a) (b ? kept : missing).push(a.text);
		else extra.push(b.text);
		if (a?.count > 1)
			duplicates.push({ side: "expected", key, count: a.count });
		if (b?.count > 1)
			duplicates.push({ side: "produced", key, count: b.count });
	}
	const counts = {
		expected: expected.entries.size,
		produced: produced.entries.size,
		covered: kept.length,
		missing: missing.length,
		extra: extra.length,
		duplicates: duplicates.length,
		invalid: invalid.expected.length + invalid.produced.length,
	};
	const complete =
		counts.missing + counts.extra + counts.duplicates + counts.invalid === 0;
	const status = !complete && policy === "block" ? "blocked" : "passed";
	const summary = [
		`${counts.covered} of ${counts.expected} covered`,
		...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
		...(extra.length ? [`extra: ${extra.join(", ")}`] : []),
		...(duplicates.length ? [`duplicate IDs: ${duplicates.length}`] : []),
		...(counts.invalid ? [`invalid IDs: ${counts.invalid}`] : []),
	]
		.join("; ")
		.replace(/\s+/g, " ");
	return {
		schema: "coverage-gate-v1",
		digest: summary.slice(0, 200),
		status,
		gates: { passed: status === "passed" },
		policy,
		complete,
		counts,
		kept,
		missing,
		extra,
		duplicates,
		invalid,
		summary,
	};
}

function pick(value, path) {
	return path
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)
		.reduce(
			(cursor, key) =>
				cursor !== null &&
				typeof cursor === "object" &&
				Object.hasOwn(cursor, key)
					? cursor[key]
					: undefined,
			value,
		);
}

function collectIds(descriptor, sources, statuses, side) {
	if (!descriptor?.from) throw new Error(`coverage-gate: ${side} needs a from`);
	const ids = [];
	for (const name of Array.isArray(descriptor.from)
		? descriptor.from
		: [descriptor.from]) {
		const matched = statuses.filter(
			(row) => row.stageId === name || row.source === name,
		);
		const items = matched.filter((row) => row.itemIdentity !== undefined);
		const completed = items.filter((row) => row.status === "completed");
		if (!matched.length && !Object.hasOwn(sources, name))
			throw new Error(
				`coverage-gate: "${name}" is not a source (declare it in from)`,
			);
		if (
			side === "expected" &&
			(completed.length < items.length ||
				(!items.length && matched.some((row) => row.status !== "completed")))
		)
			throw new Error(
				`coverage-gate: expected source "${name}" did not complete`,
			);
		if (descriptor.identity === true) {
			ids.push(...completed.map((row) => row.itemIdentity));
			continue;
		}
		const names = items.length
			? completed.map((row) => row.source)
			: Object.hasOwn(sources, name)
				? [name]
				: [];
		for (const source of names) {
			const control = sources[source];
			const rows =
				descriptor.rows === null
					? [control]
					: pick(control, descriptor.rows ?? "items");
			if (!Array.isArray(rows))
				throw new Error(
					`coverage-gate: source "${source}" has no array at ${descriptor.rows ?? "items"}`,
				);
			for (const row of rows)
				ids.push(
					row !== null && typeof row === "object"
						? pick(row, descriptor.field ?? "id")
						: row,
				);
		}
	}
	return ids;
}

export default async function helper({ sources, options, context }) {
	const opts = options ?? {};
	const statuses = context?.sourceStatuses ?? [];
	const expected = collectIds(opts.expected, sources, statuses, "expected");
	const produced = (
		Array.isArray(opts.produced) ? opts.produced : [opts.produced]
	).flatMap((source) => collectIds(source, sources, statuses, "produced"));
	return coverageGate(expected, produced, opts);
}
