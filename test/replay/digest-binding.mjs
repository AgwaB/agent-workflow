// WP1b digest bindings: a replayed sha256 that differs from the recorded one only because the bytes it
// digests contain a renamed literal (allowed-differences.json `renames`, e.g. the run state path
// `.agent-workflow/workflows` ↔ `.pi/workflows`) is mapped to the recorded value — but only with a
// binding check that recomputes both digests (replay record "Digest bindings"):
//
//   file  X' = sha256(replayed file bytes), X = sha256(recorded file bytes, host root restored), and
//         the two files are equal after normalization, literal renames and the bindings proven so far.
//   self  a JSON control whose top-level `digest` is reproduced on both sides by one of the bundled
//         helpers' digest formulas (SELF_DIGEST_FORMULAS: recomputed from the control itself), and
//         whose objects without `digest` are equal after normalization, literal renames and the
//         bindings proven so far.
//
// Bindings are proven to a fixpoint (a proven binding can make another file equal). Nothing is masked:
// the replayed digest is replaced by the recorded one only where the replayed bytes provably differ
// by renamed literals alone. The recorded digest can only be recomputed when the recorded host root
// is known (fixtures that pin `replayRoot`); otherwise no binding is proven.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	applyLiteralRenames,
	createContext,
	normalizeFileText,
	normalizeText,
	restorePaths,
} from "./normalize.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const SHA256_HEX = /\b[0-9a-f]{64}\b/gu;

function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}

/** stableStringify of the bundled helpers (sorted keys, JSON scalars). */
export function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/**
 * Control digest formulas of the original bundled helpers (pi-workflow b83cc4f), each recomputed
 * from the control itself:
 *   stable-rest            sha256(stableStringify(control without `digest`)) — spec-review
 *                          partition (spec-review-pipeline.mjs) and the same pattern elsewhere.
 *   spec-review-render-v1  sha256(stableStringify(controlForDigest)) of render-spec-review-report.mjs:
 *                          {verdict, findingSummary, rendered*Ids, scopeLimitations,
 *                          testExecutionAttested, passed, markdown}; `passed` is not stored, so
 *                          both values are tried.
 */
const SELF_DIGEST_FORMULAS = [
	(value) => {
		const { digest: _digest, ...rest } = value;
		return [rest];
	},
	(value) =>
		value.schema !== "spec-review-render-v1"
			? []
			: [true, false].map((passed) => ({
					verdict: value.verdict,
					findingSummary: value.findingSummary,
					renderedFindingIds: value.renderedFindingIds,
					renderedNeedsHumanIds: value.renderedNeedsHumanIds,
					renderedDroppedFindingIds: value.renderedDroppedFindingIds,
					scopeLimitations: value.scopeLimitations,
					testExecutionAttested: value.testExecutionAttested,
					passed,
					markdown: value.markdown,
				})),
];

function selfDigest(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.digest !== "string"
	)
		return undefined;
	const match = /^sha256:([0-9a-f]{64})$/u.exec(value.digest);
	if (!match) return undefined;
	for (const formula of SELF_DIGEST_FORMULAS)
		for (const input of formula(value))
			if (sha256(stableStringify(input)) === match[1]) return match[1];
	return undefined;
}

/** Replace every proven replayed digest with its recorded value. */
export function applyDigestBindings(text, bindings) {
	if (bindings.size === 0) return text;
	return text.replace(SHA256_HEX, (hex) => bindings.get(hex)?.recorded ?? hex);
}

/**
 * Per-file view of a run directory: normalized name → {raw, comparable, comparableWithoutDigest}.
 * Each file is normalized with a fresh context, so id placeholders number within the file and a
 * partial (in-flight) replay tree pairs with the complete recording.
 */
function treeView(dir, { roots, restoreRoots, renames }) {
	const view = new Map();
	for (const file of listFiles(dir)) {
		const ctx = {
			...createContext(roots),
			ids: new Map(),
			idCounts: new Map(),
		};
		const rel = relative(dir, file).split(sep).join("/");
		const name = applyLiteralRenames(normalizeText(rel, ctx), renames).text;
		const bytes = readFileSync(file);
		const text = bytes.toString("utf8");
		if (!Buffer.from(text, "utf8").equals(bytes)) continue;
		const raw =
			restoreRoots === undefined ? text : restorePaths(text, restoreRoots);
		const entry = normalizeFileText(name, text, ctx);
		const comparable = (value) =>
			applyLiteralRenames(
				typeof value === "string" ? value : JSON.stringify(value),
				renames,
			).text;
		let parsed;
		let withoutDigest;
		if (entry.kind === "json") {
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
			if (entry.value && typeof entry.value === "object") {
				const { digest: _digest, ...rest } = entry.value;
				withoutDigest = comparable(rest);
			}
		}
		view.set(name, {
			name,
			hash: sha256(Buffer.from(raw, "utf8")),
			comparable: comparable(entry.kind === "text" ? entry.text : entry.value),
			selfDigest: selfDigest(parsed),
			withoutDigest,
		});
	}
	return view;
}

/**
 * Prove digest bindings between a recorded run directory (portable text; `recordedRoots` restores
 * the host roots the recording ran with) and a replayed run directory (`replayRoots`).
 * Returns Map<replayed hex, {recorded, kind, file}>.
 */
export function proveDigestBindings({
	recordedDir,
	replayedDir,
	recordedRoots,
	replayRoots,
	renames,
}) {
	const bindings = new Map();
	if (!recordedRoots?.ROOT) return bindings;
	const recorded = treeView(recordedDir, {
		roots: {},
		restoreRoots: recordedRoots,
		renames: [],
	});
	const replayed = treeView(replayedDir, { roots: replayRoots, renames });
	const bind = (from, to, kind, file) => {
		if (from === to || bindings.has(from)) return false;
		bindings.set(from, { recorded: to, kind, file });
		return true;
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, rec] of recorded) {
			const rep = replayed.get(name);
			if (rep === undefined) continue;
			if (
				rec.hash !== rep.hash &&
				!bindings.has(rep.hash) &&
				rec.comparable === applyDigestBindings(rep.comparable, bindings)
			)
				changed = bind(rep.hash, rec.hash, "file", name) || changed;
			if (
				rec.selfDigest !== undefined &&
				rep.selfDigest !== undefined &&
				rec.selfDigest !== rep.selfDigest &&
				!bindings.has(rep.selfDigest) &&
				rec.withoutDigest ===
					applyDigestBindings(rep.withoutDigest ?? "", bindings)
			)
				changed = bind(rep.selfDigest, rec.selfDigest, "self", name) || changed;
		}
	}
	return bindings;
}
