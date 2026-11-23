// test-tier: integration
// The shadow project a write-capable rehearsal runs in (src/core/rehearsal-shadow.ts) must carry the
// project's current agents and workflows, including uncommitted edits to tracked files, not the HEAD copies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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

async function snapshotTree(dir) {
	const out = [];
	const walk = (d, prefix) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const rel = `${prefix}${entry.name}`;
			if (entry.isDirectory()) {
				out.push(`${rel}/`);
				walk(join(d, entry.name), `${rel}/`);
			} else out.push(`${rel}=${readFileSync(join(d, entry.name), "utf8")}`);
		}
	};
	walk(dir, "");
	return out.sort();
}

function commitAll(repo) {
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
}

// Review 2026-11-23 (B1): a tracked `.agent-workflow` symlink in HEAD must not let the overlay remove or write the
// directory it points to.
test("a tracked .agent-workflow symlink in HEAD cannot make the overlay touch the directory it points to", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "aw-shadow-link-")));
	try {
		const outside = join(base, "outside");
		await mkdir(join(outside, "agents"), { recursive: true });
		await mkdir(join(outside, "workflows", "keep"), { recursive: true });
		await writeFile(join(outside, "agents", "keep.md"), "outside agent\n");
		await writeFile(join(outside, "workflows", "keep", "spec.json"), "{}\n");
		const before = await snapshotTree(outside);
		const repo = join(base, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "README.md"), "x\n");
		await symlink(outside, join(repo, ".agent-workflow"));
		commitAll(repo);
		// The working tree now has a real directory where HEAD has the link.
		await rm(join(repo, ".agent-workflow"));
		await mkdir(join(repo, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(
			join(repo, ".agent-workflow", "agents", "writer.md"),
			"working agent\n",
		);
		const root = join(base, "root");
		await mkdir(root);
		const shadow = createShadowProject(repo, root);
		assert.deepEqual(
			await snapshotTree(outside),
			before,
			"the linked directory is untouched",
		);
		assert.ok(shadow !== undefined);
		const state = join(shadow, ".agent-workflow");
		assert.equal(lstatSync(state).isSymbolicLink(), false);
		assert.equal(
			readFileSync(join(state, "agents", "writer.md"), "utf8"),
			"working agent\n",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a symlinked directory on the cwd path in HEAD makes the shadow refuse instead of writing outside", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "aw-shadow-sub-")));
	try {
		const outside = join(base, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep.txt"), "keep\n");
		const before = await snapshotTree(outside);
		const repo = join(base, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "README.md"), "x\n");
		await symlink(outside, join(repo, "sub"));
		commitAll(repo);
		await rm(join(repo, "sub"));
		await mkdir(join(repo, "sub", ".agent-workflow", "agents"), {
			recursive: true,
		});
		await writeFile(
			join(repo, "sub", ".agent-workflow", "agents", "a.md"),
			"a\n",
		);
		const root = join(base, "root");
		await mkdir(root);
		assert.throws(
			() => createShadowProject(join(repo, "sub"), root),
			/outside the temporary clone/,
		);
		assert.deepEqual(
			await snapshotTree(outside),
			before,
			"nothing was written outside",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
