// test-tier: integration
// The shadow project a write-capable rehearsal runs in (src/core/rehearsal-shadow.ts) must carry the
// project's current agents and workflows, including uncommitted edits to tracked files, not the HEAD copies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createShadowProject } from "../../dist/core/rehearsal-shadow.js";

test("the shadow project copies the working-tree agents and workflows over the HEAD copies", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "aw-shadow-")));
	try {
		const repo = join(base, "repo");
		const agents = join(repo, ".agent-workflow", "agents");
		const workflows = join(repo, ".agent-workflow", "workflows", "w");
		await mkdir(agents, { recursive: true });
		await mkdir(workflows, { recursive: true });
		await writeFile(join(agents, "writer.md"), "committed agent\n");
		await writeFile(join(agents, "gone.md"), "deleted since the commit\n");
		await writeFile(join(workflows, "workflow.yaml"), "committed spec\n");
		const git = (...args) =>
			execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
		git("init", "-q");
		git("add", "-A", "-f");
		git(
			"-c",
			"user.email=t@example.test",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"-m",
			"init",
		);
		await writeFile(join(agents, "writer.md"), "edited agent\n");
		await rm(join(agents, "gone.md"));
		await writeFile(join(workflows, "workflow.yaml"), "edited spec\n");

		const root = join(base, "root");
		await mkdir(root);
		const shadow = createShadowProject(repo, root);
		assert.ok(shadow !== undefined);
		const shadowState = join(shadow, ".agent-workflow");
		assert.equal(
			readFileSync(join(shadowState, "agents", "writer.md"), "utf8"),
			"edited agent\n",
		);
		assert.equal(existsSync(join(shadowState, "agents", "gone.md")), false);
		assert.equal(
			readFileSync(
				join(shadowState, "workflows", "w", "workflow.yaml"),
				"utf8",
			),
			"edited spec\n",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
