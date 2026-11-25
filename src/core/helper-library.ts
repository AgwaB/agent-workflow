// The verified helper building blocks `agent-workflow new helper <helper> <workflow>` copies into a bundle's
// helpers/ directory (src/hosts/new.ts). The sources are plain .mjs files in ./helper-library/ (copied to
// dist by `npm run build`), each tested directly and carrying its contract in its header, so a run's bundle
// snapshot is self-contained: the engine runs them as bundle-local support helpers and never imports the
// installed package. Output is the file bytes, so the same helper always writes the same bytes.
import { readFileSync } from "node:fs";

export const HELPER_LIBRARY_IDS = [
	"evidence-locate",
	"evidence-gate",
	"keyed-join",
	"coverage-gate",
	"graph-edges",
	"render-report",
] as const;
export type HelperLibraryId = (typeof HELPER_LIBRARY_IDS)[number];

export interface HelperLibraryEntry {
	id: HelperLibraryId;
	description: string;
	/** Files written into helpers/, the helper's own file last; the others are imported by it. */
	files: string[];
	/** A support stage using it, or undefined for a library imported by other helpers. */
	stage?: string;
}

export const HELPER_LIBRARY: ReadonlyArray<HelperLibraryEntry> = [
	{
		id: "evidence-locate",
		description:
			"library: find a claim's evidence by its quote in a project file (whitespace-normalised), return the real line range; exact / located / rejected; contained, no symlink escape",
		files: ["evidence-locate.mjs"],
	},
	{
		id: "evidence-gate",
		description:
			"support stage: check every row's quote with evidence-locate; policy drop (default: keep verified rows, list rejected) or block (declare blocked)",
		files: ["evidence-locate.mjs", "evidence-gate.mjs"],
		stage: `{ "id": "gate", "from": ["<rows stage>"], "support": { "uses": "./helpers/evidence-gate.mjs", "options": { "from": "<rows stage>", "rows": "items", "fields": { "file": "file", "quote": "quote", "startLine": "startLine", "endLine": "endLine" }, "policy": "drop" } } }`,
	},
	{
		id: "keyed-join",
		description:
			"support stage: join/diff two row lists by a composite key (method + path): only left, only right, both, field conflicts; key normalisation (case, :id vs {id})",
		files: ["key-normalize.mjs", "keyed-join.mjs"],
		stage: `{ "id": "diff", "from": ["<left stage>", "<right stage>"], "support": { "uses": "./helpers/keyed-join.mjs", "options": { "left": { "from": "<left stage>", "rows": "items" }, "right": { "from": "<right stage>", "rows": "items" }, "key": ["method", "path"], "normalize": { "method": ["trim", "upper"], "path": ["path-params", "trailing-slash"] }, "compare": ["handler"] } } }`,
	},
	{
		id: "coverage-gate",
		description:
			"support stage: compare expected and produced IDs (by default trim and case-fold); report missing, extra and duplicates; policy drop or block",
		files: ["key-normalize.mjs", "coverage-gate.mjs"],
		stage: `{ "id": "coverage", "from": ["<inventory>", "<workers>"], "sourcePolicy": "partial", "support": { "uses": "./helpers/coverage-gate.mjs", "options": { "expected": { "from": "<inventory>", "rows": "items" }, "produced": { "from": "<workers>", "identity": true }, "policy": "block" } } }`,
	},
	{
		id: "graph-edges",
		description:
			"support stage: directed graph from (from, to) rows: simple cycles up to a bound, strongly connected components, hubs by degree",
		files: ["graph-edges.mjs"],
		stage: `{ "id": "graph", "from": ["<rows stage>"], "support": { "uses": "./helpers/graph-edges.mjs", "options": { "from": "<rows stage>", "rows": "items", "fromField": "name", "toField": "imports", "maxCycleLength": 8, "top": 5 } } }`,
	},
	{
		id: "render-report",
		description:
			"support stage: safe Markdown tables, lists and linked indexes; word-boundary clipping and placeholders; also a library for code-built reports",
		files: ["render-report.mjs"],
		stage: `{ "id": "report", "from": ["<rows stage>"], "support": { "uses": "./helpers/render-report.mjs", "options": { "title": "Report", "sections": [{ "title": "Rows", "from": "<rows stage>", "rows": "items", "type": "table", "columns": ["id", "name"] }] } } }`,
	},
];

export function isHelperLibraryId(value: string): value is HelperLibraryId {
	return (HELPER_LIBRARY_IDS as readonly string[]).includes(value);
}

/** The bytes of one helper file (a name from an entry's `files`). */
export function readHelperFile(file: string): string {
	return readFileSync(
		new URL(`./helper-library/${file}`, import.meta.url),
		"utf8",
	);
}
