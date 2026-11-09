// test-tier: integration
// agent-workflow 2026-11-08 (context-quality backlog X1): each run records the engine version (and
// its checkout when run from one) and the git state of the run's repository at launch, as hashes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	captureCodeRevisions,
	resetCodeRevisionCacheForTests,
} from "../../dist/core/code-revisions.js";

const EMPTY_SHA256 = createHash("sha256").digest("hex");
const cleanEnv = () => {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("GIT_")) delete env[key];
	return env;
};
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		env: cleanEnv(),
		encoding: "utf8",
	}).trim();

function tempDir(t, prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() =>
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	return dir;
}

function repo(t) {
	const dir = tempDir(t, "aw-code-rev-");
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}\n');
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "b.txt"), "b\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "initial");
	return dir;
}

const nonGitRoot = (t) => {
	const dir = tempDir(t, "aw-code-rev-pkg-");
	writeFileSync(join(dir, "package.json"), '{"version":"9.9.9"}\n');
	return dir;
};

test("a directory outside any repository records no git state and starts no git", async (t) => {
	const dir = tempDir(t, "aw-code-rev-plain-");
	const result = await captureCodeRevisions(dir, {
		packageRoot: nonGitRoot(t),
		git: "/nonexistent/git-must-not-run",
	});
	assert.deepEqual(result.target, { repository: false });
	assert.deepEqual(result.engine, { version: "9.9.9" });
	assert.ok(Date.parse(result.capturedAt));
});

test("a clean repository records head, branch and empty change hashes", async (t) => {
	const dir = repo(t);
	const { target } = await captureCodeRevisions(join(dir, "sub"), {
		packageRoot: nonGitRoot(t),
	});
	assert.deepEqual(target, {
		repository: true,
		head: git(dir, "rev-parse", "HEAD"),
		branch: "main",
		dirty: false,
		statusSha256: EMPTY_SHA256,
		diffSha256: EMPTY_SHA256,
	});
});

test("change hashes follow tracked content and untracked names, independent of diff config", async (t) => {
	const dir = repo(t);
	const root = nonGitRoot(t);
	const capture = async () =>
		(await captureCodeRevisions(dir, { packageRoot: root })).target;
	const clean = await capture();

	writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
	const edited = await capture();
	assert.equal(edited.dirty, true);
	assert.notEqual(edited.diffSha256, clean.diffSha256);
	assert.deepEqual(await capture(), edited, "same state, same hashes");

	// The user's diff settings do not change the recorded hash.
	git(dir, "config", "diff.noprefix", "true");
	git(dir, "config", "diff.algorithm", "patience");
	git(dir, "config", "diff.renames", "copies");
	git(dir, "config", "core.abbrev", "12");
	assert.equal((await capture()).diffSha256, edited.diffSha256);

	writeFileSync(join(dir, "a.txt"), "one\ntwo-changed\nthree\n");
	assert.notEqual((await capture()).diffSha256, edited.diffSha256);

	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(dir, "new.txt"), "untracked\n");
	const untracked = await capture();
	assert.equal(untracked.dirty, true);
	assert.notEqual(untracked.statusSha256, clean.statusSha256);
	assert.equal(
		untracked.diffSha256,
		clean.diffSha256,
		"untracked content is not in the diff",
	);
});

test("detached and unborn HEADs are recorded without failing", async (t) => {
	const dir = repo(t);
	git(dir, "checkout", "-q", "--detach");
	const detached = (
		await captureCodeRevisions(dir, { packageRoot: nonGitRoot(t) })
	).target;
	assert.equal(detached.head, git(dir, "rev-parse", "HEAD"));
	assert.equal(detached.branch, undefined);
	assert.equal(detached.issues, undefined);

	const unborn = tempDir(t, "aw-code-rev-unborn-");
	git(unborn, "init", "-q", "-b", "main");
	writeFileSync(join(unborn, "x.txt"), "x\n");
	const fresh = (
		await captureCodeRevisions(unborn, { packageRoot: nonGitRoot(t) })
	).target;
	assert.equal(fresh.repository, true);
	assert.equal(fresh.head, undefined);
	assert.equal(fresh.branch, "main");
	assert.equal(fresh.dirty, true);
	assert.equal(fresh.diffSha256, undefined);
	assert.deepEqual(fresh.issues, ["HEAD has no commit"]);
});

test("the engine checkout is recorded only when the package root is the repository root", async (t) => {
	const dir = repo(t);
	resetCodeRevisionCacheForTests();
	const atRoot = await captureCodeRevisions(tempDir(t, "aw-code-rev-cwd-"), {
		packageRoot: dir,
	});
	assert.equal(atRoot.engine.version, "1.2.3");
	assert.equal(atRoot.engine.checkout?.head, git(dir, "rev-parse", "HEAD"));
	assert.equal(atRoot.engine.checkout?.branch, "main");

	// An installed copy inside someone else's repository is not that repository's checkout.
	const nested = join(dir, "node_modules", "@agwab", "agent-workflow");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), '{"version":"0.1.0"}\n');
	const installed = await captureCodeRevisions(tempDir(t, "aw-code-rev-cwd-"), {
		packageRoot: nested,
	});
	assert.deepEqual(installed.engine, { version: "0.1.0" });
});

test("repository variables of the calling process do not redirect git", async (t) => {
	const target = repo(t);
	const other = repo(t);
	writeFileSync(join(other, "a.txt"), "other\n");
	git(other, "commit", "-qam", "other");
	const saved = process.env.GIT_DIR;
	process.env.GIT_DIR = join(other, ".git");
	try {
		const result = await captureCodeRevisions(target, {
			packageRoot: nonGitRoot(t),
		});
		assert.equal(result.target.head, git(target, "rev-parse", "HEAD"));
	} finally {
		if (saved === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = saved;
	}
});

test("repository-configured commands (fsmonitor, external diff, textconv) are not run", async (t) => {
	const dir = repo(t);
	const marker = join(tempDir(t, "aw-code-rev-marker-"), "ran");
	const hook = join(dir, ".git", "hook.sh");
	writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`);
	chmodSync(hook, 0o755);
	git(dir, "config", "core.fsmonitor", hook);
	git(dir, "config", "diff.external", hook);
	git(dir, "config", "diff.conv.textconv", hook);
	writeFileSync(join(dir, ".gitattributes"), "*.txt diff=conv\n");
	writeFileSync(join(dir, "a.txt"), "changed\n");
	const { target } = await captureCodeRevisions(dir, {
		packageRoot: nonGitRoot(t),
	});
	assert.equal(target.dirty, true);
	assert.equal(typeof target.diffSha256, "string");
	assert.equal(
		existsSync(marker),
		false,
		existsSync(marker) ? readFileSync(marker, "utf8") : "",
	);
});

test("a hung or missing git is recorded as an issue and never throws", async (t) => {
	const dir = repo(t);
	const slow = join(tempDir(t, "aw-code-rev-slow-"), "git");
	writeFileSync(slow, "#!/bin/sh\nsleep 10\n");
	chmodSync(slow, 0o755);
	const started = Date.now();
	const hung = await captureCodeRevisions(dir, {
		packageRoot: nonGitRoot(t),
		git: slow,
		timeoutMs: 200,
	});
	assert.ok(Date.now() - started < 5_000);
	assert.equal(hung.target.repository, true);
	assert.equal(hung.target.head, undefined);
	assert.match(hung.target.issues.join("; "), /timed out after 200 ms/u);

	const missing = await captureCodeRevisions(dir, {
		packageRoot: nonGitRoot(t),
		git: "/nonexistent/git-binary",
	});
	assert.equal(missing.target.repository, true);
	assert.match(missing.target.issues.join("; "), /could not start/u);
});
