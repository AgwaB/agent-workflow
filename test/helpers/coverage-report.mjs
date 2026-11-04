// Line coverage of the whole unit suite, merged across every process (the runner spawns one Node
// process per test file, and tests spawn more). Before and after a refactor, compare the numbers of
// the files it touches. No dependency: V8's own block coverage (NODE_V8_COVERAGE).
//
//   NODE_V8_COVERAGE=/tmp/aw-v8cov node test/run-unit.mjs        (about 6 minutes; ~1 GB of JSON)
//   node test/helpers/coverage-report.mjs /tmp/aw-v8cov [filter-regex] [--uncovered]
//
// A line counts as covered when the innermost V8 block range that contains its start ran at least
// once in any process. dist/ is the compiled src/ (no source maps): read uncovered dist lines next
// to the matching TypeScript. Comment-only, blank and lone-brace lines are not counted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [covDir, filter = ".", ...rest] = process.argv.slice(2);
const showUncovered = rest.includes("--uncovered") || filter === "--uncovered";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (!covDir) {
	console.error(
		"usage: node test/helpers/coverage-report.mjs <NODE_V8_COVERAGE dir> [filter-regex] [--uncovered]",
	);
	process.exit(2);
}
const prefix = `file://${repo}/`;
const interesting = (url) =>
	url.startsWith(prefix) &&
	/^(dist|workflows|skills\/workflow-guide\/scaffolds)\//.test(
		url.slice(prefix.length),
	) &&
	/\.(m?js)(\?.*)?$/.test(url);
const lineStarts = new Map(); // path -> offsets of line starts
const covered = new Map(); // path -> Uint8Array per line: 0 unknown, 1 seen uncovered, 2 covered
function starts(path) {
	if (!lineStarts.has(path)) {
		const text = readFileSync(path, "utf8");
		const offs = [0];
		for (let i = 0; i < text.length; i++)
			if (text.charCodeAt(i) === 10) offs.push(i + 1);
		lineStarts.set(path, { offs });
	}
	return lineStarts.get(path);
}
for (const file of readdirSync(covDir)) {
	let data;
	try {
		data = JSON.parse(readFileSync(join(covDir, file), "utf8"));
	} catch {
		continue;
	}
	for (const script of data.result ?? []) {
		const url = script.url.replace(/\?.*$/, "");
		if (!interesting(script.url)) continue;
		const path = fileURLToPath(url);
		if (!existsSync(path)) continue;
		const { offs } = starts(path);
		// innermost-range count per line start (use first non-space char offset approx = line start)
		const counts = new Array(offs.length).fill(-1);
		const ranges = [];
		for (const fn of script.functions)
			for (const r of fn.ranges) ranges.push(r);
		// sort by size descending so inner ranges overwrite outer ones
		ranges.sort(
			(a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset),
		);
		for (const r of ranges) {
			// lines whose start lies within [start, end)
			let lo = 0;
			let hi = offs.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (offs[mid] < r.startOffset) lo = mid + 1;
				else hi = mid;
			}
			for (
				let line = lo;
				line < offs.length && offs[line] < r.endOffset;
				line++
			)
				counts[line] = r.count;
		}
		const arr = covered.get(path) ?? new Uint8Array(offs.length);
		for (let line = 0; line < offs.length; line++) {
			if (counts[line] > 0) arr[line] = 2;
			else if (counts[line] === 0 && arr[line] === 0) arr[line] = 1;
		}
		covered.set(path, arr);
	}
}
const result = {};
for (const [path, arr] of covered) {
	const rel = path.slice(repo.length + 1);
	const uncovered = [];
	let total = 0;
	let hit = 0;
	const text = readFileSync(path, "utf8").split("\n");
	for (let i = 0; i < arr.length; i++) {
		const src = text[i]?.trim() ?? "";
		if (
			!src ||
			src.startsWith("//") ||
			src.startsWith("*") ||
			src.startsWith("/*") ||
			src === "}" ||
			src === "});"
		)
			continue;
		total++;
		if (arr[i] === 2) hit++;
		else if (arr[i] === 1) uncovered.push(i + 1);
	}
	result[rel] = {
		lines: total,
		covered: hit,
		pct: total ? Math.round((hit / total) * 1000) / 10 : 100,
		uncovered,
	};
}
const pattern = new RegExp(filter === "--uncovered" ? "." : filter);
let lines = 0;
let hits = 0;
for (const [rel, row] of Object.entries(result).sort(([a], [b]) =>
	a.localeCompare(b),
)) {
	if (!pattern.test(rel)) continue;
	lines += row.lines;
	hits += row.covered;
	console.log(
		`${String(row.pct).padStart(5)}%  ${String(row.lines).padStart(5)}  ${rel}`,
	);
	if (showUncovered && row.uncovered.length)
		console.log(`        uncovered: ${row.uncovered.join(",")}`);
}
console.log(
	`${lines ? ((hits / lines) * 100).toFixed(1) : "100.0"}% of ${lines} lines`,
);
