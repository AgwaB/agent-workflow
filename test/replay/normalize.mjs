#!/usr/bin/env node
// Replay normalization policy (see POLICY.md). Pure Node, no dependencies.
//
// CLI:
//   normalize.mjs <recordOrRunDir> <outDir> [--root P] [--pkg P] [--home P]
//                 [--tmp P] [--allowed FILE | --no-allowed]
//   normalize.mjs --compare <dirA> <dirB>
//
// Library:
//   createContext, portablePaths, restorePaths, normalizeText, normalizeJson,
//   normalizeTree, applyAllowedDifferences, compareTrees, replayKey,
//   loadAllowedDifferences
//
// The same module is used by pi-workflow's replay API (test/replay/) and by
// agent-workflow (test/replay/). Keep the two copies byte-identical.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_VERSION = "agent-workflow-replay-normalization-v1";
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWED_FILE = join(HERE, "allowed-differences.json");

// ---------------------------------------------------------------- context

function pathVariants(path) {
	if (!path) return [];
	const out = new Set([resolve(path)]);
	try {
		out.add(realpathSync(path));
	} catch {
		/* path may not exist on this host (portable fixtures) */
	}
	for (const value of [...out]) {
		if (value.startsWith("/private/")) out.add(value.slice("/private".length));
		else if (/^\/(var|tmp|etc)\//.test(`${value}/`))
			out.add(`/private${value}`);
	}
	return [...out].filter((value) => value.length > 1);
}

/**
 * roots: { ROOT, PKG, HOME, TMP } absolute paths (any may be omitted).
 * ROOT = project cwd of the run, PKG = workflow engine package checkout,
 * HOME = user home, TMP = OS temp dir. Longest path wins on overlap.
 */
export function createContext(roots = {}, options = {}) {
	const pairs = [];
	for (const token of ["ROOT", "PKG", "HOME", "TMP"]) {
		for (const variant of pathVariants(roots[token]))
			pairs.push([variant, `<${token}>`]);
	}
	pairs.sort((left, right) => right[0].length - left[0].length);
	const seen = new Set();
	const rootPairs = pairs.filter(([path]) =>
		seen.has(path) ? false : seen.add(path),
	);
	const hosts = [
		...new Set(
			[...(options.hostnames ?? [hostname()])].filter(
				(h) => h && h.length >= 3,
			),
		),
	];
	return { roots: { ...roots }, rootPairs, hosts };
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reversible step: absolute host roots -> <ROOT>/<PKG>/<HOME>/<TMP>. */
export function portablePaths(text, ctx) {
	let out = text;
	for (const [path, token] of ctx.rootPairs) {
		out = out.replace(
			new RegExp(
				`${escapeRegExp(path)}(?=$|[/\\\\"'\\s:;,)\\]}>]|\\.(?![A-Za-z0-9]))`,
				"g",
			),
			token,
		);
	}
	return out;
}

/** Inverse of portablePaths for a replay host: tokens -> this host's roots. */
export function restorePaths(text, roots) {
	let out = text;
	for (const token of ["ROOT", "PKG", "HOME", "TMP"]) {
		if (roots[token]) out = out.split(`<${token}>`).join(resolve(roots[token]));
	}
	return out;
}

// ---------------------------------------------------------------- text rules

const ISO_TS =
	/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/g;
const ID_RULES = [
	["WF_RUN", /\bworkflow_[0-9a-z]{6,12}_[0-9a-f]{6}\b/g],
	["SA_RUN", /\brun_[0-9a-z]{6,12}_[0-9a-f]{6}\b/g],
	["SA_ATTEMPT", /\battempt_[0-9a-z]{6,12}_[0-9a-f]{6}\b/g],
];
const PROC_BIRTH = /\b(?:darwin|linux|win32|freebsd):\d+:\d+\b/g;
const BARRIER_DIR = /(\.launch-barrier-[0-9a-f]{16})-[0-9a-f]{16}\b/g;

function idPlaceholder(ctx, kind, value) {
	ctx.ids ??= new Map();
	const key = `${kind}\0${value}`;
	if (!ctx.ids.has(key)) {
		ctx.idCounts ??= new Map();
		const next = (ctx.idCounts.get(kind) ?? 0) + 1;
		ctx.idCounts.set(kind, next);
		ctx.ids.set(key, `<${kind}_${next}>`);
	}
	return ctx.ids.get(key);
}

export function normalizeText(text, ctx) {
	let out = portablePaths(text, ctx);
	for (const [kind, pattern] of ID_RULES)
		out = out.replace(pattern, (match) => idPlaceholder(ctx, kind, match));
	out = out.replace(ISO_TS, "<TS>");
	out = out.replace(PROC_BIRTH, "<PROC_BIRTH>");
	out = out.replace(BARRIER_DIR, "$1-<RAND16>");
	for (const host of ctx.hosts) out = out.split(host).join("<HOST>");
	return out;
}

// ---------------------------------------------------------------- JSON rules

const PID_KEYS = new Set([
	"pid",
	"workerPid",
	"processGroupId",
	"workerProcessGroupId",
	"ppid",
	"ownerPid",
	"parentPid",
]);
const FS_KEYS = new Map([
	["device", "<FS_DEV>"],
	["dev", "<FS_DEV>"],
	["inode", "<FS_INO>"],
	["ino", "<FS_INO>"],
	["uid", "<UID>"],
	["gid", "<GID>"],
]);
const EPOCH_KEYS = new Set(["mtimeMs", "ctimeMs", "atimeMs", "birthtimeMs"]);
/** `*Ms` keys that are configuration, not measurements; compared verbatim. */
export const CONFIG_MS_KEYS = new Set([
	"timeoutMs",
	"pollIntervalMs",
	"maxRuntimeMs",
	"launchSlotReleaseDelayMs",
	"retryAfterMs",
	"releaseDelayMs",
	"retryJitterMs",
	"intervalMs",
	"maxWaitMs",
]);

function numberPlaceholder(key, value) {
	if (key === undefined) return value;
	if (PID_KEYS.has(key) || /[a-z]Pid$/.test(key)) return "<PID>";
	if (FS_KEYS.has(key)) return FS_KEYS.get(key);
	if (
		EPOCH_KEYS.has(key) ||
		(value >= 1e12 &&
			value < 1e13 &&
			/(At|Time|Timestamp|Epoch)(Ms)?$/.test(key))
	)
		return "<EPOCH_MS>";
	if (/Ms$/.test(key) && !CONFIG_MS_KEYS.has(key)) return "<DURATION_MS>";
	return value;
}

export function normalizeJson(value, ctx, key) {
	if (value === null) return null;
	if (typeof value === "string") {
		if (key === "ownerId" && /^\d+-[0-9a-f]+$/.test(value)) return "<OWNER_ID>";
		return normalizeText(value, ctx);
	}
	if (typeof value === "number") return numberPlaceholder(key, value);
	if (Array.isArray(value))
		return value.map((entry) => normalizeJson(entry, ctx, undefined));
	if (typeof value === "object") {
		const out = {};
		for (const childKey of Object.keys(value).sort())
			out[normalizeText(childKey, ctx)] = normalizeJson(
				value[childKey],
				ctx,
				childKey,
			);
		return sortKeysDeep(out);
	}
	return value;
}

function sortKeysDeep(value) {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort())
			out[key] = sortKeysDeep(value[key]);
		return out;
	}
	return value;
}

// ---------------------------------------------------------------- files

function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() || entry.isSymbolicLink()) out.push(full);
		}
	};
	walk(root);
	// Order by id-insensitive relative path so placeholder numbering is stable.
	const generic = (path) =>
		ID_RULES.reduce(
			(acc, [kind, pattern]) => acc.replace(pattern, `<${kind}>`),
			relative(root, path).split(sep).join("/"),
		);
	return out.sort((left, right) => {
		const a = generic(left);
		const b = generic(right);
		return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
	});
}

function parseJsonLines(text) {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line) => JSON.parse(line));
}

/** Normalizes one file's text. Returns { kind, value | text }. */
export function normalizeFileText(name, text, ctx) {
	if (/\.jsonl$/.test(name)) {
		try {
			return {
				kind: "jsonl",
				value: parseJsonLines(text).map((entry) => normalizeJson(entry, ctx)),
			};
		} catch {
			/* fall through to text */
		}
	}
	if (/\.(json|txn)$/.test(name) || /^\s*[[{]/.test(text)) {
		try {
			return { kind: "json", value: normalizeJson(JSON.parse(text), ctx) };
		} catch {
			/* fall through to text */
		}
	}
	return { kind: "text", text: normalizeText(text, ctx) };
}

function serialize(entry) {
	if (entry.kind === "jsonl")
		return (
			entry.value.map((line) => JSON.stringify(line)).join("\n") +
			(entry.value.length ? "\n" : "")
		);
	if (entry.kind === "json") return `${JSON.stringify(entry.value, null, 2)}\n`;
	return entry.text;
}

/**
 * Normalizes every file under srcDir. Returns Map<normalizedRelPath, entry>.
 * Files that are not UTF-8 text are represented by their sha256.
 */
export function normalizeTreeEntries(srcDir, baseCtx) {
	const ctx = { ...baseCtx, ids: new Map(), idCounts: new Map() };
	const entries = new Map();
	for (const file of listFiles(srcDir)) {
		const rel = normalizeText(relative(srcDir, file).split(sep).join("/"), ctx);
		const bytes = readFileSync(file);
		const text = bytes.toString("utf8");
		const entry = Buffer.from(text, "utf8").equals(bytes)
			? normalizeFileText(rel, text, ctx)
			: {
					kind: "text",
					text: `<BINARY sha256=${createHash("sha256").update(bytes).digest("hex")}>\n`,
				};
		if (entries.has(rel)) throw new Error(`normalized path collision: ${rel}`);
		entries.set(rel, entry);
	}
	return entries;
}

// ---------------------------------------------------------------- allowed differences

export function loadAllowedDifferences(file = DEFAULT_ALLOWED_FILE) {
	if (!file || !existsSync(file)) return [];
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	for (const entry of parsed.entries ?? []) {
		if (
			!entry.id ||
			!entry.reason ||
			!Array.isArray(entry.keys) ||
			entry.keys.length === 0
		)
			throw new Error(
				`allowed-difference entry needs id, reason and keys: ${JSON.stringify(entry)}`,
			);
	}
	return parsed.entries ?? [];
}

/**
 * A rule key is either a bare field name ("stateRootSha256") or a dotted
 * suffix of object keys ("grant.identitySha256"); array levels are skipped.
 */
function keyMatches(rules, keyPath) {
	for (const rule of rules) {
		const parts = rule.split(".");
		if (parts.length > keyPath.length) continue;
		if (
			parts.every(
				(part, index) =>
					keyPath[keyPath.length - parts.length + index] === part,
			)
		)
			return true;
	}
	return false;
}

function collectAllowedValues(value, rules, found, keyPath = []) {
	if (Array.isArray(value)) {
		for (const entry of value)
			collectAllowedValues(entry, rules, found, keyPath);
		return;
	}
	if (value && typeof value === "object") {
		for (const childKey of Object.keys(value).sort())
			collectAllowedValues(value[childKey], rules, found, [
				...keyPath,
				childKey,
			]);
		return;
	}
	if (
		keyPath.length > 0 &&
		typeof value === "string" &&
		/^[0-9a-f]{64}$/.test(value) &&
		!found.includes(value) &&
		keyMatches(rules, keyPath)
	)
		found.push(value);
}

/** Non-digest scalars (numbers, non-sha256 strings) at rule keys become <ALLOWED:id>. */
function maskScalars(value, allowed, keyPath = []) {
	if (Array.isArray(value))
		return value.map((entry) => maskScalars(entry, allowed, keyPath));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value))
			out[key] = maskScalars(value[key], allowed, [...keyPath, key]);
		return out;
	}
	if (keyPath.length === 0 || value === null) return value;
	if (
		typeof value === "string" &&
		(/^[0-9a-f]{64}$/.test(value) || value.startsWith("<ALLOWED:"))
	)
		return value;
	for (const rule of allowed)
		if (keyMatches(rule.keys, keyPath)) return `<ALLOWED:${rule.id}>`;
	return value;
}

function replaceValues(value, replacements) {
	if (typeof value === "string") {
		let out = value;
		for (const [from, to] of replacements) out = out.split(from).join(to);
		return out;
	}
	if (Array.isArray(value))
		return value.map((entry) => replaceValues(entry, replacements));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort())
			out[replaceValues(key, replacements)] = replaceValues(
				value[key],
				replacements,
			);
		return out;
	}
	return value;
}

/**
 * Alpha-renames opaque digests found under the allowed keys: each distinct
 * value becomes <ALLOWED:id#n> (numbered by first appearance), and every other
 * occurrence of that value -- or of its 16-hex prefix used in generated file
 * names -- is renamed identically. Equality structure is preserved: two trees
 * compare equal only if the digests play the same roles in both.
 */
export function applyAllowedDifferences(entries, allowed) {
	if (allowed.length === 0) return entries;
	const replacements = [];
	for (const rule of allowed) {
		const found = [];
		for (const [, entry] of [...entries].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			if (entry.kind === "json")
				collectAllowedValues(entry.value, rule.keys, found);
			else if (entry.kind === "jsonl")
				for (const line of entry.value)
					collectAllowedValues(line, rule.keys, found);
		}
		found.forEach((value, index) => {
			if (replacements.some(([from]) => from === value)) return;
			replacements.push([value, `<ALLOWED:${rule.id}#${index + 1}>`]);
			replacements.push([
				value.slice(0, 16),
				`<ALLOWED:${rule.id}#${index + 1}:16>`,
			]);
		});
	}
	// Full digests before prefixes.
	replacements.sort((left, right) => right[0].length - left[0].length);
	const out = new Map();
	for (const [rel, entry] of entries) {
		const name = replaceValues(rel, replacements);
		if (entry.kind === "text")
			out.set(name, {
				kind: "text",
				text: replaceValues(entry.text, replacements),
			});
		else if (entry.kind === "json")
			out.set(name, {
				kind: "json",
				value: maskScalars(replaceValues(entry.value, replacements), allowed),
			});
		else
			out.set(name, {
				kind: "jsonl",
				value: entry.value.map((line) =>
					maskScalars(replaceValues(line, replacements), allowed),
				),
			});
	}
	return out;
}

// ---------------------------------------------------------------- tree API

export function normalizeTree(srcDir, outDir, ctx, options = {}) {
	const allowed = options.allowed ?? [];
	const entries = applyAllowedDifferences(
		normalizeTreeEntries(srcDir, ctx),
		allowed,
	);
	if (outDir) {
		rmSync(outDir, { recursive: true, force: true });
		for (const [rel, entry] of [...entries].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			const target = join(
				outDir,
				...rel
					.split("/")
					.map((part) =>
						part.replace(
							/[<>:]/g,
							(c) => ({ "<": "{", ">": "}", ":": "~" })[c],
						),
					),
			);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, serialize(entry));
		}
	}
	return entries;
}

function readTree(dir) {
	const out = new Map();
	for (const file of listFiles(dir))
		out.set(
			relative(dir, file).split(sep).join("/"),
			readFileSync(file, "utf8"),
		);
	return out;
}

/** Byte comparison of two normalized trees. Returns a list of differences. */
export function compareTrees(dirA, dirB) {
	const a = readTree(dirA);
	const b = readTree(dirB);
	const diffs = [];
	for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		if (!a.has(name)) diffs.push({ file: name, kind: "only-in-b" });
		else if (!b.has(name)) diffs.push({ file: name, kind: "only-in-a" });
		else if (a.get(name) !== b.get(name))
			diffs.push({
				file: name,
				kind: "content",
				detail: firstLineDiff(a.get(name), b.get(name)),
			});
	}
	return diffs;
}

export function firstLineDiff(left, right) {
	const a = left.split("\n");
	const b = right.split("\n");
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		if (a[index] !== b[index])
			return { line: index + 1, a: a[index], b: b[index] };
	}
	return undefined;
}

// ---------------------------------------------------------------- replay keys

/**
 * Stable call key used by replay: sha256 of the canonical JSON of
 * {method, args} after the same normalization as the run record (fresh id
 * numbering per call, allowed-difference renaming per call).
 */
export function replayKey(method, args, ctx, allowed = []) {
	const local = { ...ctx, ids: new Map(), idCounts: new Map() };
	const normalized = normalizeJson({ method, args }, local);
	const [entry] = applyAllowedDifferences(
		new Map([["call", { kind: "json", value: normalized }]]),
		allowed,
	).values();
	const canonical = JSON.stringify(entry.value);
	return {
		key: createHash("sha256").update(canonical).digest("hex"),
		canonical,
	};
}

// ---------------------------------------------------------------- CLI

function detectRoot(dir) {
	for (const candidate of [
		join(dir, "run.json"),
		join(dir, "run", "run.json"),
	]) {
		if (existsSync(candidate)) {
			try {
				const cwd = JSON.parse(readFileSync(candidate, "utf8")).cwd;
				if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
			} catch {
				/* ignore */
			}
		}
	}
	return undefined;
}

async function main(argv) {
	if (argv[0] === "--compare") {
		const diffs = compareTrees(resolve(argv[1]), resolve(argv[2]));
		for (const diff of diffs) process.stdout.write(`${JSON.stringify(diff)}\n`);
		process.stdout.write(
			diffs.length === 0 ? "identical\n" : `${diffs.length} difference(s)\n`,
		);
		return diffs.length === 0 ? 0 : 1;
	}
	const positional = [];
	const roots = {};
	let allowedFile = DEFAULT_ALLOWED_FILE;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--root") roots.ROOT = argv[++index];
		else if (arg === "--pkg") roots.PKG = argv[++index];
		else if (arg === "--home") roots.HOME = argv[++index];
		else if (arg === "--tmp") roots.TMP = argv[++index];
		else if (arg === "--allowed") allowedFile = argv[++index];
		else if (arg === "--no-allowed") allowedFile = undefined;
		else positional.push(arg);
	}
	const [src, out] = positional;
	if (!src || !out) {
		process.stderr.write(
			"usage: normalize.mjs <runDir> <outDir> [--root P] [--pkg P] [--home P] [--tmp P] [--allowed FILE|--no-allowed]\n       normalize.mjs --compare <dirA> <dirB>\n",
		);
		return 2;
	}
	const srcDir = resolve(src);
	if (!statSync(srcDir).isDirectory())
		throw new Error(`not a directory: ${srcDir}`);
	roots.ROOT ??= detectRoot(srcDir);
	roots.HOME ??= homedir();
	roots.TMP ??= tmpdir();
	const ctx = createContext(roots);
	const entries = normalizeTree(srcDir, resolve(out), ctx, {
		allowed: loadAllowedDifferences(allowedFile),
	});
	process.stdout.write(
		`normalized ${entries.size} file(s) -> ${resolve(out)} (${POLICY_VERSION})\n`,
	);
	return 0;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = await main(process.argv.slice(2));
}
