// New in agent-workflow (2026-11-03): the dashboard's task result reader — digest, analysis, refs and
// control JSON from tasks/<task>/, contained to the project's artifact root and bounded.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readTaskResult } from "../../dist/hosts/dashboard/task-result.js";

async function project(t) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-task-result-")));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const rel = ".agent-workflow/workflows/workflow_abc123_def456/tasks/task-1";
	await mkdir(join(cwd, rel), { recursive: true });
	return { cwd, rel, dir: join(cwd, rel), result: `${rel}/result.json` };
}

test("a finished task's digest, analysis, refs (object and string forms) and pretty control", async (t) => {
	const { cwd, dir, result } = await project(t);
	await writeFile(
		join(dir, "control.json"),
		JSON.stringify({
			schema: "stage-control-v1",
			digest: "Short answer.",
			n: 1,
		}),
	);
	await writeFile(join(dir, "analysis.md"), "\n# Heading\n\n- **a** point\n");
	await writeFile(
		join(dir, "refs.json"),
		JSON.stringify([
			{
				sourceRef: "s1",
				url: "https://example.org/a",
				title: "A",
				relevance: "why",
			},
			"https://example.org/b",
			"src/x.ts:12",
			42,
		]),
	);
	assert.deepEqual(await readTaskResult(cwd, { files: { result } }), {
		digest: "Short answer.",
		control: JSON.stringify(
			{ schema: "stage-control-v1", digest: "Short answer.", n: 1 },
			null,
			2,
		),
		analysis: "# Heading\n\n- **a** point",
		refs: [
			{ title: "A", url: "https://example.org/a", note: "why" },
			{ url: "https://example.org/b" },
			{ note: "src/x.ts:12" },
		],
	});
});

test("bounded analysis, missing files, and paths outside the artifact root", async (t) => {
	const { cwd, dir, rel, result } = await project(t);
	assert.equal(await readTaskResult(cwd, { files: { result } }), undefined);
	assert.equal(await readTaskResult(cwd, {}), undefined);
	await writeFile(join(dir, "analysis.md"), "x".repeat(70_000));
	const long = await readTaskResult(cwd, { files: { result } });
	assert.equal(long.analysisTruncated, true);
	assert.ok(long.analysis.length <= 60_001);
	for (const bad of [
		`${rel}/../../../../../../etc/result.json`,
		"/etc/result.json",
		"elsewhere/tasks/task-1/result.json",
	])
		assert.equal(
			await readTaskResult(cwd, { files: { result: bad } }),
			undefined,
			bad,
		);
	// A symlinked task directory that leaves the artifact root is refused.
	const outside = await realpath(
		await mkdtemp(join(tmpdir(), "aw-task-result-out-")),
	);
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "analysis.md"), "secret");
	const linked =
		".agent-workflow/workflows/workflow_abc123_def456/tasks/task-2";
	await symlink(outside, join(cwd, linked));
	assert.equal(
		await readTaskResult(cwd, { files: { result: `${linked}/result.json` } }),
		undefined,
	);
});
