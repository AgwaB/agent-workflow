// test-tier: integration
// Review 2026-11-23 (M7, M8, M9): a rehearsal of a workflow that can write must stay physically inside its
// temporary root or refuse to run: for a writer that only exists in a loop or onExhausted template, for a
// writer whose cwd names the real project, and under a user's global git configuration (hooks, filters).
// The fixtures are temporary git repositories; the real repository's refs, worktree registrations and status
// must be unchanged afterwards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { rehearseWorkflow } from "../../dist/core/rehearsal.js";
import { createShadowProject } from "../../dist/core/rehearsal-shadow.js";

let base;
let counter = 0;

before(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "aw-rehearse-iso-")));
});
after(async () => {
	await rm(base, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

const WRITER_AGENT = [
	"---",
	"name: writer",
	"description: writer",
	"tools: read, bash",
	"---",
	"You do the task and report.",
	"",
].join("\n");
const REVIEW_SCHEMA = {
	type: "object",
	required: ["schema", "digest", "passed", "n"],
	additionalProperties: false,
	properties: {
		schema: { type: "string" },
		digest: { type: "string" },
		passed: { type: "boolean" },
		n: { type: "integer", minimum: 0, maximum: 9 },
	},
};
const READ_DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };
const WRITE = {
	agent: "writer",
	readOnly: false,
	tools: ["read", "bash"],
	worktreePolicy: "on",
};

function git(repo, ...args) {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** A committed repository holding a writer agent, `spec.json` and its review schema. */
async function fixture(spec, files = {}) {
	counter += 1;
	const repo = join(base, `repo${counter}`);
	await mkdir(join(repo, ".agent-workflow", "agents"), { recursive: true });
	await mkdir(join(repo, "sub"), { recursive: true });
	await writeFile(
		join(repo, ".agent-workflow", "agents", "writer.md"),
		WRITER_AGENT,
	);
	await writeFile(join(repo, "sub", "keep.txt"), "keep\n");
	await writeFile(join(repo, "r.json"), JSON.stringify(REVIEW_SCHEMA));
	for (const [name, text] of Object.entries(files))
		await writeFile(join(repo, name), text);
	await writeFile(join(repo, "spec.json"), JSON.stringify(spec(repo)));
	git(repo, "init", "-q");
	git(repo, "add", "-A", "-f");
	git(
		repo,
		"-c",
		"user.email=t@example.test",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		"init",
	);
	return { repo, spec: join(repo, "spec.json") };
}

/** Everything a worktree or branch created by the engine would change in the repository. */
function repoState(repo) {
	const admin = join(repo, ".git", "worktrees");
	return JSON.stringify({
		refs: git(repo, "for-each-ref"),
		worktrees: git(repo, "worktree", "list", "--porcelain"),
		status: git(repo, "status", "--porcelain", "--untracked-files=all"),
		admin: existsSync(admin) ? readdirSync(admin) : [],
	});
}

function loopWithWriter({ onExhaustedWriter = false } = {}) {
	return (_repo) => ({
		schemaVersion: 1,
		name: "loop-writer",
		defaults: READ_DEFAULTS,
		artifactGraph: {
			stages: [
				{
					id: "refine",
					type: "loop",
					maxRounds: 2,
					progressPath: "$.n",
					until: { stage: "review", path: "$.passed", equals: true },
					...(onExhaustedWriter
						? {
								onExhausted: {
									id: "fix",
									type: "single",
									prompt: "Fix what still fails.",
									...WRITE,
								},
							}
						: {}),
					stages: [
						onExhaustedWriter
							? { id: "draft", type: "single", prompt: "Draft." }
							: { id: "edit", type: "single", prompt: "Edit.", ...WRITE },
						{
							id: "review",
							type: "single",
							prompt: "Review.",
							output: { controlSchema: "./r.json" },
						},
					],
				},
			],
		},
	});
}

function singleWriter(cwdOf) {
	return (repo) => ({
		schemaVersion: 1,
		name: "abs-cwd",
		defaults: READ_DEFAULTS,
		artifactGraph: {
			stages: [
				{
					id: "edit",
					type: "single",
					prompt: "Edit.",
					...WRITE,
					cwd: cwdOf(repo),
				},
			],
		},
	});
}

test("M7: a writer only inside a loop template runs in the shadow clone, never in the real repository", async () => {
	const { repo, spec } = await fixture(loopWithWriter());
	const before = repoState(repo);
	const result = await rehearseWorkflow(repo, { workflow: spec });
	assert.equal(result.leftover, undefined);
	assert.equal(repoState(repo), before, "the real repository is unchanged");
	assert.equal(result.report.ok, true, result.report.findings.join("\n"));
});

test("M7: a writer only in onExhausted runs in the shadow clone, never in the real repository", async () => {
	const { repo, spec } = await fixture(
		loopWithWriter({ onExhaustedWriter: true }),
	);
	const before = repoState(repo);
	const result = await rehearseWorkflow(repo, {
		workflow: spec,
		loop: "exhaust",
	});
	assert.equal(result.leftover, undefined);
	assert.equal(repoState(repo), before, "the real repository is unchanged");
	assert.equal(result.report.ok, true, result.report.findings.join("\n"));
	assert.ok(
		result.report.loops.some((loop) => loop.status === "exhausted"),
		"the exhausted path ran",
	);
});

for (const [label, cwdOf] of [
	["the project root", (repo) => repo],
	["a project subdirectory", (repo) => join(repo, "sub")],
]) {
	test(`M8: a writer whose cwd is the absolute path of ${label} is refused, not run in the real repository`, async () => {
		const { repo, spec } = await fixture(singleWriter(cwdOf));
		const before = repoState(repo);
		const result = await rehearseWorkflow(repo, { workflow: spec });
		assert.equal(repoState(repo), before, "the real repository is unchanged");
		assert.equal(result.report.ok, false);
		assert.match(
			result.report.findings.join("\n"),
			/outside the rehearsal's temporary root/u,
		);
	});
}

test("M8: defaults.cwd naming the real project is refused as well", async () => {
	const { repo, spec } = await fixture((repo) => ({
		schemaVersion: 1,
		name: "defaults-cwd",
		defaults: { ...WRITE, cwd: repo },
		artifactGraph: {
			stages: [{ id: "edit", type: "single", prompt: "Edit." }],
		},
	}));
	const before = repoState(repo);
	const result = await rehearseWorkflow(repo, { workflow: spec });
	assert.equal(repoState(repo), before, "the real repository is unchanged");
	assert.equal(result.report.ok, false);
	assert.match(
		result.report.findings.join("\n"),
		/outside the rehearsal's temporary root/u,
	);
});

/** A user's global git configuration with a checkout hook and a smudge filter that each write a marker. */
async function globalGitConfig(dir) {
	const hooks = join(dir, "hooks");
	await mkdir(hooks, { recursive: true });
	const marker = join(dir, "markers");
	await mkdir(marker);
	for (const name of [
		"post-checkout",
		"post-commit",
		"reference-transaction",
	]) {
		await writeFile(
			join(hooks, name),
			`#!/bin/sh\ntouch "${marker}/hook-${name}"\nexit 0\n`,
		);
		await chmod(join(hooks, name), 0o755);
	}
	// (`;` starts a comment in a git config value, so the filter is a script.)
	const smudge = join(dir, "smudge.sh");
	await writeFile(smudge, `#!/bin/sh\ntouch "${marker}/smudge"\ncat\n`);
	await chmod(smudge, 0o755);
	const config = join(dir, "gitconfig");
	await writeFile(
		config,
		[
			"[core]",
			`\thooksPath = ${hooks}`,
			'[filter "mark"]',
			`\tsmudge = ${smudge}`,
			"\tclean = cat",
			"",
		].join("\n"),
	);
	return { config, marker };
}

async function withGlobalGit(config, body) {
	const saved = {
		global: process.env.GIT_CONFIG_GLOBAL,
		nosystem: process.env.GIT_CONFIG_NOSYSTEM,
		prompt: process.env.GIT_TERMINAL_PROMPT,
	};
	process.env.GIT_CONFIG_GLOBAL = config;
	try {
		return await body();
	} finally {
		for (const [name, value] of [
			["GIT_CONFIG_GLOBAL", saved.global],
			["GIT_CONFIG_NOSYSTEM", saved.nosystem],
			["GIT_TERMINAL_PROMPT", saved.prompt],
		]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("M9: the shadow clone and checkout ignore the user's global git configuration", async () => {
	const { repo } = await fixture(
		singleWriter(() => "."),
		{
			".gitattributes": "*.txt filter=mark\n",
		},
	);
	const dir = join(base, `global${counter}`);
	await mkdir(dir);
	const { config, marker } = await globalGitConfig(dir);
	const root = join(base, `root${counter}`);
	await mkdir(root);
	await withGlobalGit(config, async () => {
		assert.ok(createShadowProject(repo, root) !== undefined);
	});
	assert.deepEqual(readdirSync(marker), [], "no global hook or filter ran");
});

test("M9: a whole rehearsal (clone and the engine's worktree add) runs no global hook or filter", async () => {
	const { repo, spec } = await fixture(loopWithWriter(), {
		".gitattributes": "*.txt filter=mark\n",
	});
	const dir = join(base, `global${counter}`);
	await mkdir(dir);
	const { config, marker } = await globalGitConfig(dir);
	const before = repoState(repo);
	const result = await withGlobalGit(config, () =>
		rehearseWorkflow(repo, { workflow: spec }),
	);
	assert.equal(result.report.ok, true, result.report.findings.join("\n"));
	assert.deepEqual(readdirSync(marker), [], "no global hook or filter ran");
	assert.equal(repoState(repo), before);
	// The environment is restored: the global configuration is the test's again.
	assert.equal(process.env.GIT_CONFIG_GLOBAL, undefined);
	assert.equal(process.env.GIT_CONFIG_NOSYSTEM, undefined);
});
