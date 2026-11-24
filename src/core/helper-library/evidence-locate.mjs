// evidence-locate.mjs: find a claim's evidence by its QUOTE in a project file. Library, no default export
// (use it from your own helper, or through evidence-gate.mjs). Deterministic; it only reads (lstat, realpath,
// one bounded read per file) and never writes. No model call, no network.
//
// Contract
//   locateEvidence({ cwd, file, quote, term, claimedStart, claimedEnd, minQuoteChars, termMatch, cache })
//     -> Promise<Verdict>
//   locateInText(text, quote, { term, claimedStart, claimedEnd, minQuoteChars, termMatch }) -> Verdict   (pure)
//   readProjectFile(cwd, file) -> Promise<string>      throws Refused
//
//   Verdict = { verdict: "exact" | "located" | "rejected", reason?, file?, startLine, endLine, quote,
//               occurrences, claimed?, lineCorrected }
//     exact     the quote occurs verbatim in the file (CRLF and LF are not told apart).
//     located   the quote occurs once whitespace runs (spaces, tabs, indentation, line breaks) are not told
//               apart: a model that re-wrapped or re-indented a snippet still points at real text.
//     rejected  `reason` says why: empty quote; fewer than `minQuoteChars` (default 8) non-blank characters;
//               `term` (when given) is not in the quote; the quote is not in the file; the file is refused.
//   startLine / endLine (1-based, inclusive) are the REAL range of the match, computed from the file. A line
//   number the model claimed (claimedStart / claimedEnd) is never trusted and never a reason to reject: it
//   only picks the nearest occurrence when the quote occurs several times (`occurrences` > 1), and
//   `lineCorrected: true` (with `claimed: { startLine, endLine }`) says it was off. `quote` is the text as it
//   stands in the file (at most 600 characters).
//   termMatch: "word" (default; the term must not be glued to identifier characters) or "substring".
//   cache: an optional Map shared across calls so each file is read once.
//
// Containment: `file` must be a relative path of a regular file inside `cwd`, reached without a symlink on
// the way (not even a symlinked folder), at most 4 MiB, valid UTF-8, and unchanged while it is read. Anything
// else is a rejected verdict with the reason, never a read outside the project.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MIN_QUOTE_CHARS = 8;
const MAX_QUOTE_SHOWN = 600;
const MAX_OCCURRENCES = 200;
const IDENT = /[\p{L}\p{N}_$]/u;

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) =>
	same(a, b) &&
	a.size === b.size &&
	a.mtimeNs === b.mtimeNs &&
	a.ctimeNs === b.ctimeNs;

export class Refused extends Error {}

/** Current text of one project file; any doubt about where the path really leads is a refusal. */
export async function readProjectFile(cwd, file) {
	if (
		typeof file !== "string" ||
		file === "" ||
		file.length > 240 ||
		file.includes("\0") ||
		/^[a-z][a-z0-9+.-]*:/i.test(file) ||
		isAbsolute(file)
	) {
		throw new Refused("the file is not a relative path inside the project");
	}
	const root = await realpath(resolve(cwd));
	const target = resolve(root, file);
	const rel = relative(root, target);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	) {
		throw new Refused("the file path leaves the project directory");
	}
	const ancestors = [];
	let walked = root;
	for (const part of ["", ...rel.split(sep).slice(0, -1)]) {
		walked = resolve(walked, part);
		let stat;
		try {
			stat = await lstat(walked, { bigint: true });
		} catch {
			throw new Refused("the file does not exist");
		}
		if (stat.isSymbolicLink())
			throw new Refused("the file path goes through a symlink (refused)");
		if (!stat.isDirectory())
			throw new Refused(
				"the file path goes through something that is not a folder",
			);
		ancestors.push({ path: walked, stat });
	}
	let leaf;
	try {
		leaf = await lstat(target, { bigint: true });
	} catch {
		throw new Refused("the file does not exist");
	}
	if (leaf.isSymbolicLink())
		throw new Refused("the file is a symlink (refused)");
	if (!leaf.isFile()) throw new Refused("the path is not a regular file");
	if (leaf.size > BigInt(MAX_FILE_BYTES))
		throw new Refused("the file is larger than 4 MiB and was not checked");
	const unchanged = async () => {
		for (const ancestor of ancestors) {
			if (!same(ancestor.stat, await lstat(ancestor.path, { bigint: true })))
				throw new Refused("the file path changed while it was read");
		}
		if (
			!sameFile(leaf, await lstat(target, { bigint: true })) ||
			(await realpath(target)) !== target
		) {
			throw new Refused("the file changed while it was read");
		}
	};
	const handle = await open(
		target,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || !sameFile(leaf, before))
			throw new Refused("the file changed while it was read");
		await unchanged();
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				size,
				Math.min(65536, buffer.length - size),
				size,
			);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (
			BigInt(size) !== before.size ||
			!sameFile(before, await handle.stat({ bigint: true }))
		) {
			throw new Refused("the file changed while it was read");
		}
		await unchanged();
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, size),
			);
		} catch {
			throw new Refused("the file is not valid UTF-8 text");
		}
	} finally {
		await handle.close();
	}
}

const lineAt = (text, offset) => {
	let line = 1;
	for (
		let i = text.indexOf("\n");
		i >= 0 && i < offset;
		i = text.indexOf("\n", i + 1)
	)
		line++;
	return line;
};

/** Whitespace runs -> one space; `origin[i]` is the offset in `text` of squashed character i. */
function squash(text) {
	let out = "";
	const origin = [];
	let blank = false;
	for (let i = 0; i < text.length; i++) {
		if (/\s/.test(text[i])) {
			if (!blank) {
				out += " ";
				origin.push(i);
			}
			blank = true;
		} else {
			out += text[i];
			origin.push(i);
			blank = false;
		}
	}
	return { out, origin };
}

function termIn(text, term, mode) {
	if (mode === "substring") return text.includes(term);
	const first = IDENT.test(term[0]);
	const last = IDENT.test(term[term.length - 1]);
	for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
		if (first && at > 0 && IDENT.test(text[at - 1])) continue;
		const end = at + term.length;
		if (last && end < text.length && IDENT.test(text[end])) continue;
		return true;
	}
	return false;
}

function occurrencesOf(haystack, needle) {
	const found = [];
	for (
		let at = haystack.indexOf(needle);
		at >= 0 && found.length < MAX_OCCURRENCES;
		at = haystack.indexOf(needle, at + 1)
	)
		found.push(at);
	return found;
}

const asLine = (value) =>
	typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value.trim())
			? Number(value.trim())
			: undefined;

const reject = (reason, extra = {}) => ({
	verdict: "rejected",
	reason,
	startLine: 0,
	endLine: 0,
	quote: "",
	occurrences: 0,
	lineCorrected: false,
	...extra,
});

/** Where `quote` really is in `text`; the model's line numbers only choose between several matches. */
export function locateInText(text, quote, options = {}) {
	const minChars = Number.isInteger(options.minQuoteChars)
		? options.minQuoteChars
		: DEFAULT_MIN_QUOTE_CHARS;
	const wanted = typeof quote === "string" ? quote.replace(/\r\n/g, "\n") : "";
	const trimmed = wanted.trim();
	if (trimmed === "") return reject("the row has no quote");
	if (trimmed.replace(/\s/g, "").length < minChars)
		return reject(
			`the quote is too short to prove anything (under ${minChars} non-blank characters)`,
		);
	const term = typeof options.term === "string" ? options.term.trim() : "";
	if (
		term !== "" &&
		!termIn(
			trimmed.replace(/\s+/g, " "),
			term.replace(/\s+/g, " "),
			options.termMatch,
		)
	)
		return reject(
			`the quote does not contain ${JSON.stringify(term.slice(0, 60))}`,
		);

	const lf = text.replace(/\r\n/g, "\n");
	let verdict = "exact";
	let spans = occurrencesOf(lf, trimmed).map((at) => [at, at + trimmed.length]);
	if (spans.length === 0) {
		verdict = "located";
		const { out, origin } = squash(lf);
		const needle = trimmed.replace(/\s+/g, " ");
		spans = occurrencesOf(out, needle).map((at) => [
			origin[at],
			origin[at + needle.length - 1] + 1,
		]);
	}
	if (spans.length === 0) return reject("the quote is not in the file");

	const claimedStart = asLine(options.claimedStart);
	const claimedEnd = asLine(options.claimedEnd);
	let best = spans[0];
	if (spans.length > 1 && claimedStart !== undefined) {
		let distance = Number.POSITIVE_INFINITY;
		for (const span of spans) {
			const d = Math.abs(lineAt(lf, span[0]) - claimedStart);
			if (d < distance) {
				distance = d;
				best = span;
			}
		}
	}
	const startLine = lineAt(lf, best[0]);
	const endLine =
		startLine + (lf.slice(best[0], best[1]).split("\n").length - 1);
	const claimed =
		claimedStart === undefined && claimedEnd === undefined
			? undefined
			: {
					startLine: claimedStart ?? 0,
					endLine: claimedEnd ?? claimedStart ?? 0,
				};
	const lineCorrected =
		claimed !== undefined &&
		((claimedStart !== undefined && claimedStart !== startLine) ||
			(claimedEnd !== undefined && claimedEnd !== endLine));
	return {
		verdict,
		startLine,
		endLine,
		quote: lf.slice(best[0], best[1]).slice(0, MAX_QUOTE_SHOWN),
		occurrences: spans.length,
		...(claimed === undefined ? {} : { claimed }),
		lineCorrected,
	};
}

/** Read `file` under `cwd` (containment above) and locate `quote` in it. Never throws for a bad row. */
export async function locateEvidence(args) {
	const { cwd, file, cache } = args;
	const files = cache instanceof Map ? cache : new Map();
	if (!files.has(file)) {
		try {
			files.set(file, { text: await readProjectFile(cwd, file) });
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			files.set(file, { reason: error.message });
		}
	}
	const read = files.get(file);
	const shown = typeof file === "string" ? file.slice(0, 240) : "";
	if (read.reason !== undefined) return reject(read.reason, { file: shown });
	return { file: shown, ...locateInText(read.text, args.quote, args) };
}
