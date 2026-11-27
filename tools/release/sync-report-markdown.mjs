#!/usr/bin/env node
// Workflow snapshots must be self-contained, so copy the canonical module verbatim.
import { readFile, writeFile } from "node:fs/promises";
const source = await readFile(
	new URL(
		"../../workflows/deep-research/helpers/report-markdown.mjs",
		import.meta.url,
	),
);
for (const name of ["deep-review", "impact-review", "spec-review"]) {
	const dest = new URL(
		`../../workflows/${name}/helpers/report-markdown.mjs`,
		import.meta.url,
	);
	if (process.argv.includes("--check")) {
		if (!source.equals(await readFile(dest)))
			throw new Error(`Stale report Markdown helper: ${name}`);
	} else await writeFile(dest, source);
}
