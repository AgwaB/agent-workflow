// WP1b comparison: recorded pi-workflow run record vs the agent-workflow replay, difference by
// difference, each classified (docs/replay.md "Classification").
//
//   recorded  <fixture>/run/ normalized with the WP1a policy (must equal the committed normalized/)
//   replayed  <ROOT>/.agent-workflow/workflows/<runId>/ normalized with the replay host roots, then
//             the `renames` literals of allowed-differences.json (agent-workflow → pi-workflow)
//
// Both trees then get the allowed-difference digest renaming (`keys` entries). Leaf differences are
// computed on the trees before that renaming; a leaf whose renamed values agree is `allowed` by the
// digest entry that renamed it. Every other leaf difference is matched against the `differences`
// patterns of allowed-differences.json (class `allowed`) and explained-differences.json (class
// `explained`, each citing a change-log entry); the rest is `unexplained`. Literal renames are
// reported as `allowed` rows with their hit counts. Patterns never classify a difference inside the
// exact-match set (`EXACT_MATCH`), which must not differ at all.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDigestBindings, proveDigestBindings } from "./digest-binding.mjs";
import {
	applyAllowedDifferences,
	applyLiteralRenames,
	createContext,
	loadAllowedDifferences,
	normalizeTreeEntries,
} from "./normalize.mjs";

export const EXPLAINED_FILE = new URL(
	"./explained-differences.json",
	import.meta.url,
);

export function loadExplainedDifferences() {
	const parsed = JSON.parse(readFileSync(EXPLAINED_FILE, "utf8"));
	for (const entry of parsed.entries ?? [])
		if (
			!entry.id ||
			!entry.reason ||
			!entry.citation ||
			!Array.isArray(entry.differences)
		)
			throw new Error(
				`explained-difference entry needs id, reason, citation and differences: ${JSON.stringify(entry)}`,
			);
		else if (
			entry.divergence === true &&
			!(Array.isArray(entry.fixtures) && Array.isArray(entry.variants))
		)
			throw new Error(
				`divergence entry ${entry.id} must be scoped to fixtures and variants`,
			);
	return parsed.entries ?? [];
}

// ---------------------------------------------------------------- exact-match set

/**
 * Content that must match exactly (WP1b task): task prompts (after literal renames), task
 * output/control/analysis/refs, output-contract verdicts, required-read verdicts, task statuses and
 * their order, retry/repair counts, final run status and run usage totals. `file` is a regex over
 * the normalized relative path, `path` over the index-free JSON path (`tasks[].status`).
 */
export const EXACT_MATCH = [
	{ id: "task-prompt", file: /^tasks\/[^/]+\/task\.md$/u },
	{
		id: "task-prompt-digest",
		file: /^run\.json$/u,
		path: /^tasks\[\]\.launchBootstrap\.records\[\]\.prompt\./u,
	},
	{
		id: "task-output",
		file: /^tasks\/[^/]+\/(?:output\.log|raw\.md|control\.json|analysis\.md|refs\.json)$/u,
	},
	{
		id: "output-contract-verdict",
		file: /^tasks\/[^/]+\/result\.json$/u,
		path: /^(?:status|controlDigest|protocol|outputValidation(?:\.|$)|rawIntegrity\.(?:bytes|sha256)$)/u,
	},
	{
		id: "required-read-verdict",
		file: /^(?:run\.json|tasks\/[^/]+\/result\.json)$/u,
		path: /(?:^|\.)(?:requiredRead[A-Za-z]*|missingRequiredReads|readFailures)(?:\.|\[|$)/u,
	},
	{
		id: "read-evidence",
		file: /^tasks\/[^/]+\/read-ledger\.jsonl$/u,
		path: /^\[\]\.(?!at$)/u,
	},
	{
		id: "task-status-order",
		file: /^run\.json$/u,
		path: /^(?:tasks\[\]\.(?:taskId|specId|stageId|status|statusDetail|kind)|taskSummary\.)/u,
	},
	{
		id: "retry-repair-counts",
		file: /^run\.json$/u,
		path: /^tasks\[\]\.(?:outputRetry|launchRetry|transientRetry|resumeEvents|(?:usage|timing)\.aggregate\.attempts$)/u,
	},
	{ id: "run-status", file: /^run\.json$/u, path: /^status$/u },
	{
		id: "run-usage-totals",
		file: /^run\.json$/u,
		path: /^usage\.(?:inputTokens|outputTokens|cacheReadInputTokens|costUsd|taskCount|tasksReporting)$/u,
	},
];

export function exactMatchRule(diff) {
	// WP12d-1 (review #11): rules are written over index-free paths, leaf diffs carry indexes
	// (`tasks[0].status`); match the generic path, as the difference patterns do.
	const path = diff.path === undefined ? undefined : genericPath(diff.path);
	return EXACT_MATCH.find(
		(rule) =>
			rule.file.test(diff.file) &&
			(rule.path === undefined || (path !== undefined && rule.path.test(path))),
	);
}

// ---------------------------------------------------------------- trees

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function renameDeep(value, renames, hits) {
	if (typeof value === "string") {
		const result = applyLiteralRenames(value, renames);
		for (const [from, count] of result.hits)
			hits.set(from, (hits.get(from) ?? 0) + count);
		return result.text;
	}
	if (Array.isArray(value))
		return value.map((entry) => renameDeep(entry, renames, hits));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort())
			out[renameDeep(key, renames, hits)] = renameDeep(
				value[key],
				renames,
				hits,
			);
		return out;
	}
	return value;
}

/** Replay entries with the literal renames applied; hits = Map<file, Map<literal, count>>. */
export function renameEntries(entries, renames) {
	const out = new Map();
	const hits = new Map();
	for (const [rel, entry] of entries) {
		const fileHits = new Map();
		const name = renameDeep(rel, renames, fileHits);
		let renamed;
		if (entry.kind === "text")
			renamed = {
				kind: "text",
				text: renameDeep(entry.text, renames, fileHits),
			};
		else if (entry.kind === "json")
			renamed = {
				kind: "json",
				value: renameDeep(entry.value, renames, fileHits),
			};
		else
			renamed = {
				kind: "jsonl",
				value: entry.value.map((line) => renameDeep(line, renames, fileHits)),
			};
		if (out.has(name))
			throw new Error(`renamed path collision: ${rel} → ${name}`);
		out.set(name, renamed);
		if (fileHits.size > 0) hits.set(name, fileHits);
	}
	return { entries: out, hits };
}

function bindDeep(value, bindings, hits) {
	if (typeof value === "string") {
		if (!/[0-9a-f]{64}/u.test(value)) return value;
		for (const hex of value.match(/\b[0-9a-f]{64}\b/gu) ?? [])
			if (bindings.has(hex)) hits.set(hex, (hits.get(hex) ?? 0) + 1);
		return applyDigestBindings(value, bindings);
	}
	if (Array.isArray(value))
		return value.map((entry) => bindDeep(entry, bindings, hits));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value))
			out[bindDeep(key, bindings, hits)] = bindDeep(value[key], bindings, hits);
		return out;
	}
	return value;
}

/** Replay entries with proven digest bindings applied; hits = Map<replayed hex, count>. */
export function bindEntries(entries, bindings, hits = new Map()) {
	if (bindings.size === 0) return entries;
	const out = new Map();
	for (const [rel, entry] of entries)
		out.set(
			bindDeep(rel, bindings, hits),
			entry.kind === "text"
				? { kind: "text", text: bindDeep(entry.text, bindings, hits) }
				: { kind: entry.kind, value: bindDeep(entry.value, bindings, hits) },
		);
	return out;
}

/**
 * Pair raw (pre digest renaming) entries with a file name in which digest placeholders lose their
 * first-appearance number (`<ALLOWED:id#3:16>` → `<ALLOWED:id#*:16>`): numbering shifts whenever a
 * digest appears or disappears earlier in the tree, and the equality structure is checked
 * separately (`placeholderPairs`).
 */
function pairedEntries(raw, masked) {
	const rawNames = [...raw.keys()];
	const maskedList = [...masked.entries()];
	const out = new Map();
	rawNames.forEach((name, index) => {
		const [maskedName, maskedEntry] = maskedList[index];
		let key = maskedName.replace(/(<ALLOWED:[^#>]+)#\d+/gu, "$1#*");
		for (let ordinal = 2; out.has(key); ordinal += 1)
			key = `${maskedName.replace(/(<ALLOWED:[^#>]+)#\d+/gu, "$1#*")} (${ordinal})`;
		out.set(key, {
			name,
			maskedName,
			entry: raw.get(name),
			masked: maskedEntry,
		});
	});
	return out;
}

const PLACEHOLDER = /<ALLOWED:([^#:>]+)#(\d+)(?::16)?>/gu;
const template = (text) => text.replace(PLACEHOLDER, "<ALLOWED:$1#*>");

/** Placeholder pairs (id, recorded n, replayed n) at every common position of two masked values. */
function placeholderPairs(a, b, out, file, where = "") {
	if (typeof a === "string" && typeof b === "string") {
		if (!a.includes("<ALLOWED:") || template(a) !== template(b)) return;
		const left = [...a.matchAll(PLACEHOLDER)];
		const right = [...b.matchAll(PLACEHOLDER)];
		left.forEach((match, index) =>
			out.push({ id: match[1], a: match[2], b: right[index][2], file, where }),
		);
		return;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let index = 0; index < Math.min(a.length, b.length); index += 1)
			placeholderPairs(a[index], b[index], out, file, `${where}[${index}]`);
		return;
	}
	if (isObject(a) && isObject(b))
		for (const key of Object.keys(a))
			if (key in b)
				placeholderPairs(
					a[key],
					b[key],
					out,
					file,
					where === "" ? key : `${where}.${key}`,
				);
}

/** Masked values agree up to placeholder numbering (`<ALLOWED:id#n>`). */
function sameUpToNumbering(a, b) {
	if (a === undefined || b === undefined) return false;
	const left = JSON.stringify(a);
	const right = JSON.stringify(b);
	return left.includes("<ALLOWED:") && template(left) === template(right);
}

// ---------------------------------------------------------------- leaf diff

const MAX_VALUE_CHARS = 240;

export function preview(value) {
	if (value === undefined) return undefined;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > MAX_VALUE_CHARS
		? `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length} chars, sha256 ${sha256(text).slice(0, 12)})`
		: text;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Leaf differences between two JSON values. Paths: `a.b[3].c`; generic paths drop indexes. */
export function jsonLeafDiffs(a, b, path = "", out = []) {
	if (isObject(a) && isObject(b)) {
		for (const key of [
			...new Set([...Object.keys(a), ...Object.keys(b)]),
		].sort()) {
			const child = path === "" ? key : `${path}.${key}`;
			if (!(key in b)) out.push({ path: child, kind: "removed", a: a[key] });
			else if (!(key in a)) out.push({ path: child, kind: "added", b: b[key] });
			else jsonLeafDiffs(a[key], b[key], child, out);
		}
		return out;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
			const child = `${path}[${index}]`;
			if (index >= b.length)
				out.push({ path: child, kind: "removed", a: a[index] });
			else if (index >= a.length)
				out.push({ path: child, kind: "added", b: b[index] });
			else jsonLeafDiffs(a[index], b[index], child, out);
		}
		return out;
	}
	if (JSON.stringify(a) !== JSON.stringify(b))
		out.push({ path, kind: "changed", a, b });
	return out;
}

export const genericPath = (path) => path.replace(/\[\d+\]/gu, "[]");

function valueAt(value, path) {
	if (path === "") return value;
	let current = value;
	for (const part of path.match(/[^.[\]]+|\[\d+\]/gu) ?? []) {
		if (current === undefined || current === null) return undefined;
		current = part.startsWith("[")
			? current[Number(part.slice(1, -1))]
			: current[part];
	}
	return current;
}

/** Line hunks between two texts (LCS for moderate sizes, else one hunk from the first difference). */
export function textHunks(a, b) {
	if (a === b) return [];
	const left = a.split("\n");
	const right = b.split("\n");
	if (left.length * right.length > 4_000_000) {
		let start = 0;
		while (
			start < Math.min(left.length, right.length) &&
			left[start] === right[start]
		)
			start += 1;
		return [
			{
				line: start + 1,
				a: left.slice(start).join("\n"),
				b: right.slice(start).join("\n"),
			},
		];
	}
	const n = left.length;
	const m = right.length;
	const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i -= 1)
		for (let j = m - 1; j >= 0; j -= 1)
			table[i][j] =
				left[i] === right[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
	const hunks = [];
	let i = 0;
	let j = 0;
	let hunk;
	const flush = () => {
		if (hunk)
			hunks.push({
				line: hunk.line,
				a: hunk.a.join("\n"),
				b: hunk.b.join("\n"),
			});
		hunk = undefined;
	};
	while (i < n || j < m) {
		if (i < n && j < m && left[i] === right[j]) {
			flush();
			i += 1;
			j += 1;
		} else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
			hunk ??= { line: i + 1, a: [], b: [] };
			hunk.b.push(right[j]);
			j += 1;
		} else {
			hunk ??= { line: i + 1, a: [], b: [] };
			hunk.a.push(left[i]);
			i += 1;
		}
	}
	flush();
	return hunks;
}

function entryDiffs(file, a, b) {
	if (a.kind !== b.kind)
		return [
			{ file, kind: "changed", path: "", a: `<${a.kind}>`, b: `<${b.kind}>` },
		];
	if (a.kind === "text")
		return textHunks(a.text, b.text).map((hunk) => ({
			file,
			kind: "changed",
			line: hunk.line,
			a: hunk.a,
			b: hunk.b,
		}));
	if (a.kind === "jsonl") {
		// Rows compare by index; `[]` paths (the row index is dropped in generic paths).
		const out = [];
		jsonLeafDiffs(a.value, b.value).forEach((diff) =>
			out.push({ file, ...diff }),
		);
		return out;
	}
	return jsonLeafDiffs(a.value, b.value).map((diff) => ({ file, ...diff }));
}

// ---------------------------------------------------------------- classification

function testValue(pattern, value) {
	if (pattern === undefined) return true;
	const text =
		value === undefined
			? "<absent>"
			: typeof value === "string"
				? value
				: JSON.stringify(value);
	return new RegExp(pattern, "su").test(text);
}

export function patternMatches(pattern, diff, scope = {}) {
	if (
		pattern.fixtures !== undefined &&
		!pattern.fixtures.includes(scope.fixture)
	)
		return false;
	if (
		pattern.variants !== undefined &&
		!pattern.variants.includes(scope.variant)
	)
		return false;
	if (!new RegExp(pattern.file, "u").test(diff.file)) return false;
	if (pattern.path !== undefined) {
		if (diff.path === undefined) return false;
		if (!new RegExp(pattern.path, "u").test(genericPath(diff.path)))
			return false;
	} else if (diff.path !== undefined && diff.path !== "") return false;
	if (pattern.kind !== undefined && ![pattern.kind].flat().includes(diff.kind))
		return false;
	if (pattern.withinCostRounding === true && !withinCostRounding(diff))
		return false;
	if (
		pattern.legacyIdentical === true &&
		diff.legacyLocation?.identical !== true
	)
		return false;
	if (pattern.task !== undefined) {
		const task = /^tasks\/([^/]+)\//u.exec(diff.file)?.[1] ?? diff.taskId;
		if (task === undefined || !new RegExp(pattern.task, "u").test(task))
			return false;
	}
	return (
		testValue(pattern.recorded, diff.a) && testValue(pattern.replayed, diff.b)
	);
}

/** Numbers equal after the runtime's 12-decimal rounding of summed costs. */
function withinCostRounding(diff) {
	return (
		typeof diff.a === "number" &&
		typeof diff.b === "number" &&
		Math.round(diff.a * 1e12) === Math.round(diff.b * 1e12)
	);
}

/**
 * Classify one difference. Exact-match content is covered only by an explained entry marked
 * `divergence` (a documented point where the original spec cannot behave the same, scoped to a
 * fixture and variant); otherwise it is `unexplained` and names the rule it violates.
 */
/** Entry-level `fixtures` / `variants` scope (applies to every pattern of the entry). */
function entryInScope(entry, scope) {
	return (
		(entry.fixtures === undefined || entry.fixtures.includes(scope.fixture)) &&
		(entry.variants === undefined || entry.variants.includes(scope.variant))
	);
}

export function classify(diff, allowed, explained, scope = {}) {
	allowed = allowed.filter((entry) => entryInScope(entry, scope));
	explained = explained.filter((entry) => entryInScope(entry, scope));
	const exact = exactMatchRule(diff);
	const tolerated =
		exact?.id === "run-usage-totals" && withinCostRounding(diff);
	if (exact !== undefined && !tolerated) {
		for (const entry of explained)
			if (entry.divergence === true)
				for (const pattern of entry.differences)
					if (patternMatches(pattern, diff, scope))
						return {
							class: "explained",
							rule: entry.id,
							citation: entry.citation,
							exactMatchDivergence: exact.id,
						};
		return { class: "unexplained", exactMatch: exact.id };
	}
	for (const entry of allowed)
		for (const pattern of entry.differences ?? [])
			if (patternMatches(pattern, diff, scope))
				return { class: "allowed", rule: entry.id };
	for (const entry of explained)
		for (const pattern of entry.differences)
			if (patternMatches(pattern, diff, scope))
				return { class: "explained", rule: entry.id, citation: entry.citation };
	return { class: "unexplained" };
}

// ---------------------------------------------------------------- compare

/**
 * Compare a fixture's recorded run with a replayed run directory.
 * `extraReplayDirs`: [{label, dir}] trees the replay wrote outside its run directory (an original
 * helper writing to the hardcoded pi-workflow path); a recorded-only file found there is annotated.
 */
export function compareReplay({
	fixtureDir,
	runDir,
	roots,
	legacyRunDir,
	fixture,
	variant,
	recordedRoots,
	allowed = loadAllowedDifferences(undefined, { replay: true }),
	explained = loadExplainedDifferences(),
}) {
	const renames = allowed.flatMap((entry) => entry.renames ?? []);
	const renameOwner = new Map();
	for (const entry of allowed)
		for (const [from] of entry.renames ?? []) renameOwner.set(from, entry.id);

	const recordedRaw = normalizeTreeEntries(
		join(fixtureDir, "run"),
		createContext({}),
	);
	const ctx = createContext(roots);
	const renamed = renameEntries(normalizeTreeEntries(runDir, ctx), renames);
	const hits = renamed.hits;
	// Digest bindings (digest-binding.mjs): replayed digests over bytes that differ from the
	// recording by renamed literals only, each proven by recomputing both digests.
	const bindings = proveDigestBindings({
		recordedDir: join(fixtureDir, "run"),
		replayedDir: runDir,
		recordedRoots,
		replayRoots: roots,
		renames,
	});
	const bindingHits = new Map();
	const replayedRaw = bindEntries(renamed.entries, bindings, bindingHits);
	const recordedMasked = applyAllowedDifferences(recordedRaw, allowed);
	const replayedMasked = applyAllowedDifferences(replayedRaw, allowed);
	const recorded = pairedEntries(recordedRaw, recordedMasked);
	const replayed = pairedEntries(replayedRaw, replayedMasked);
	// Files an original helper wrote to the legacy state path: compared with the same renames and
	// digest bindings as the run directory.
	const legacy =
		legacyRunDir && existsSync(legacyRunDir)
			? bindEntries(
					renameEntries(normalizeTreeEntries(legacyRunDir, ctx), renames)
						.entries,
					bindings,
				)
			: new Map();

	const differences = [];
	const allowedByDigest = new Map();
	const pairs = [];
	const countAllowed = (id, file, path) => {
		const key = `${id}\0${file}\0${path ?? "text"}`;
		const row = allowedByDigest.get(key) ?? {
			class: "allowed",
			rule: id,
			file,
			...(path === undefined ? {} : { path }),
			kind: "digest-renamed",
			count: 0,
		};
		row.count += 1;
		allowedByDigest.set(key, row);
	};
	for (const file of [
		...new Set([...recorded.keys(), ...replayed.keys()]),
	].sort()) {
		const a = recorded.get(file);
		const b = replayed.get(file);
		if (b === undefined) {
			const legacyEntry = legacy.get(a.name);
			differences.push({
				file,
				kind: "only-recorded",
				...(legacyEntry === undefined
					? {}
					: {
							legacyLocation: {
								path: `<ROOT>/.pi/workflows/<WF_RUN_1>/${a.name}`,
								identical:
									JSON.stringify(legacyEntry) === JSON.stringify(a.entry),
							},
						}),
			});
			continue;
		}
		if (a === undefined) {
			differences.push({ file, kind: "only-replayed" });
			continue;
		}
		const maskedA = a.masked;
		const maskedB = b.masked;
		if (maskedA.kind === "text" && maskedB.kind === "text")
			placeholderPairs(maskedA.text, maskedB.text, pairs, file);
		else placeholderPairs(maskedA.value, maskedB.value, pairs, file);
		// File names carry placeholders too (barrier directory prefix).
		placeholderPairs(a.maskedName, b.maskedName, pairs, file, "<file name>");
		for (const diff of entryDiffs(file, a.entry, b.entry)) {
			if (diff.path !== undefined && maskedA.kind !== "text") {
				const va = valueAt(maskedA.value, diff.path);
				const vb = valueAt(maskedB.value, diff.path);
				if (sameUpToNumbering(va, vb)) {
					countAllowed(
						/<ALLOWED:([^#:>]+)/u.exec(JSON.stringify(va))[1],
						file,
						genericPath(diff.path),
					);
					continue;
				}
			}
			if (
				diff.path === undefined &&
				maskedA.kind === "text" &&
				sameUpToNumbering(maskedA.text, maskedB.text)
			) {
				countAllowed(/<ALLOWED:([^#:>]+)/u.exec(maskedA.text)[1], file);
				continue;
			}
			differences.push(diff);
		}
	}
	// Equality structure: within each digest entry, recorded and replayed placeholder numbers must
	// map one-to-one across the whole tree (two fields share a digest in the recording iff they do
	// in the replay).
	const forward = new Map();
	const backward = new Map();
	for (const pair of pairs) {
		const f = `${pair.id}#${pair.a}`;
		const r = `${pair.id}#${pair.b}`;
		const where = `${pair.file}:${pair.where}`;
		if (!forward.has(f)) forward.set(f, { to: r, where });
		if (!backward.has(r)) backward.set(r, { to: f, where });
		const conflict =
			forward.get(f).to !== r
				? { first: forward.get(f).where }
				: backward.get(r).to !== f
					? { first: backward.get(r).where }
					: undefined;
		if (conflict !== undefined)
			differences.push({
				file: pair.file,
				kind: "equality-structure",
				path: pair.where,
				a: `${f} (also at ${conflict.first})`,
				b: r,
			});
	}

	// run.json `tasks[N]` rows carry the task id (recorded side, else replayed) for `task` patterns.
	const runTasks = (entry) =>
		entry?.entry?.kind === "json" && Array.isArray(entry.entry.value?.tasks)
			? entry.entry.value.tasks
			: [];
	const recordedTasks = runTasks(recorded.get("run.json"));
	const replayedTasks = runTasks(replayed.get("run.json"));
	for (const diff of differences) {
		const index = /^tasks\[(\d+)\]/u.exec(diff.path ?? "")?.[1];
		if (diff.file !== "run.json" || index === undefined) continue;
		diff.taskId =
			recordedTasks[Number(index)]?.taskId ??
			replayedTasks[Number(index)]?.taskId;
	}
	const classified = differences.map((diff) => {
		const result = classify(diff, allowed, explained, { fixture, variant });
		return {
			...result,
			file: diff.file,
			kind: diff.kind,
			...(diff.path === undefined ? {} : { path: diff.path }),
			...(diff.line === undefined ? {} : { line: diff.line }),
			...(diff.taskId === undefined ? {} : { taskId: diff.taskId }),
			...(diff.a === undefined && diff.kind !== "removed"
				? {}
				: { recorded: preview(diff.a) }),
			...(diff.b === undefined && diff.kind !== "added"
				? {}
				: { replayed: preview(diff.b) }),
			...(diff.legacyLocation === undefined
				? {}
				: { legacyLocation: diff.legacyLocation }),
		};
	});
	const renameRows = [];
	for (const [file, fileHits] of [...hits].sort(([x], [y]) => (x < y ? -1 : 1)))
		for (const [literal, count] of fileHits)
			renameRows.push({
				class: "allowed",
				rule: renameOwner.get(literal),
				file,
				kind: "literal-renamed",
				literal,
				count,
			});
	const bindingOwner = allowed.find(
		(entry) => entry.digestBindings === true,
	)?.id;
	const bindingRows = [...bindings].map(([hex, binding]) => ({
		class: "allowed",
		rule: bindingOwner,
		file: binding.file,
		kind: "digest-bound",
		proof: binding.kind,
		recorded: binding.recorded,
		replayed: hex,
		count: bindingHits.get(hex) ?? 0,
	}));
	const all = [
		...renameRows,
		...bindingRows,
		...allowedByDigest.values(),
		...classified,
	];
	const counts = { allowed: 0, explained: 0, unexplained: 0 };
	for (const row of all) counts[row.class] += 1;
	return {
		counts,
		differences: all,
		exactMatchViolations: classified.filter((row) => row.exactMatch),
		exactMatchDivergences: classified.filter((row) => row.exactMatchDivergence),
	};
}
