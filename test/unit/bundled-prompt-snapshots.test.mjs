// agent-workflow 2026-11-08 (context-quality X5, first step): every bundled model stage's compiled prompt is kept as a
// normalized SHA-256 snapshot, so a change in what a model stage is asked (wording, projections, required reads) is
// visible as "request drift" in the regression net instead of silently replaying recorded outputs against a new
// request. Intended changes are re-recorded with AGENT_WORKFLOW_WRITE_PROMPT_SNAPSHOTS=1 and reviewed in the diff.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { parseWorkflow } from "../../dist/core/schema.js";
import { BUNDLED_SPEC_FILES } from "../helpers/bundled-support-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT = join(
	root,
	"test",
	"fixtures",
	"prompt-snapshots",
	"bundled.json",
);
const TASK = "PROMPT-SNAPSHOT-TASK";

/** Run-independent form: absolute paths of the repo and the temporary cwd become placeholders. */
function normalize(text, cwd) {
	return text.split(cwd).join("<cwd>").split(root).join("<repo>");
}

async function currentSnapshots() {
	const cwd = await mkdtemp(join(tmpdir(), "aw-prompt-snapshot-"));
	try {
		const out = {};
		for (const file of [...BUNDLED_SPEC_FILES].sort()) {
			const specPath = join(root, file);
			const raw = JSON.parse(await readFile(specPath, "utf8"));
			const compiled = await compileWorkflow(parseWorkflow(raw), {
				cwd,
				specPath,
				task: TASK,
			});
			const stages = {};
			for (const task of compiled.tasks) {
				if (
					task.support !== undefined ||
					typeof task.compiledPrompt !== "string"
				)
					continue;
				const text = normalize(task.compiledPrompt, cwd);
				stages[task.id] = {
					chars: text.length,
					sha256: createHash("sha256").update(text).digest("hex"),
				};
			}
			out[file] = stages;
		}
		return out;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("bundled model-stage prompts match their recorded snapshots (request drift)", async () => {
	const current = await currentSnapshots();
	if (process.env.AGENT_WORKFLOW_WRITE_PROMPT_SNAPSHOTS === "1") {
		await writeFile(SNAPSHOT, `${JSON.stringify(current, null, "\t")}\n`);
		return;
	}
	const recorded = JSON.parse(await readFile(SNAPSHOT, "utf8"));
	const drift = [];
	for (const file of new Set([
		...Object.keys(recorded),
		...Object.keys(current),
	])) {
		for (const stage of new Set([
			...Object.keys(recorded[file] ?? {}),
			...Object.keys(current[file] ?? {}),
		])) {
			const before = recorded[file]?.[stage];
			const after = current[file]?.[stage];
			if (before?.sha256 !== after?.sha256)
				drift.push(
					`${file} ${stage}: ${before ? `${before.chars} chars` : "absent"} → ${after ? `${after.chars} chars` : "absent"}`,
				);
		}
	}
	assert.deepEqual(
		drift,
		[],
		`model-stage requests changed; if intended, run AGENT_WORKFLOW_WRITE_PROMPT_SNAPSHOTS=1 node test/run-unit.mjs test/unit/bundled-prompt-snapshots.test.mjs and review the snapshot diff:\n${drift.join("\n")}`,
	);
});
