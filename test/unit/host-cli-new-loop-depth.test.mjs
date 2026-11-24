// test-tier: integration
// `new fix-loop` and `new adaptive-depth`: the generated shape, and the helpers of both bundles on real temp
// repositories and files (test command pass/fail/timeout, the worktree's changed files, the plan's caps, the
// collect gate). No model, no network. The generic rules (validate with 0 warnings, rehearse, byte-identical,
// closed schemas, profileRole) run for every pattern in host-cli-new.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const cli = await import("../../dist/hosts/cli/index.js");
const { validateJsonSchema } = await import("../../dist/core/json-schema.js");

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.test",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.test",
};

let root;
let home;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-loop-depth-")));
	home = join(root, "home");
	await mkdir(home, { recursive: true });
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

async function run(argv, cwd) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: home },
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
}

function git(dir, ...args) {
	return execFileSync("git", ["-C", dir, ...args], {
		env: GIT_ENV,
		encoding: "utf8",
	});
}

/** A project with a git repository (one empty commit), the workflow generated into it, its helpers imported. */
async function generated(pattern, name, helperFiles) {
	const dir = await mkdtemp(join(root, `${pattern}-`));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	git(dir, "init", "-q");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	const created = await run(["new", pattern, name], dir);
	assert.equal(created.code, 0, created.err + created.out);
	const bundle = join(dir, ".agent-workflow/workflows", name);
	const helpers = {};
	for (const file of helperFiles) {
		const module = await import(
			`${pathToFileURL(join(bundle, "helpers", file)).href}?${Math.random()}`
		);
		helpers[file] = module.default;
	}
	const spec = JSON.parse(await readFile(join(bundle, "spec.json"), "utf8"));
	const schema = async (file) =>
		JSON.parse(await readFile(join(bundle, "schemas", file), "utf8"));
	return { dir, bundle, helpers, spec, schema };
}

async function withEnv(values, body) {
	const saved = {};
	for (const [key, value] of Object.entries(values)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// ------------------------------------------------------------------ fix-loop

const FIX_HELPERS = ["run-tests.mjs", "report-fix.mjs"];

test("fix-loop: a bounded loop of writer and checker, an exit on the copied exit code, code stages after it", async () => {
	const { spec, dir } = await generated("fix-loop", "fl", FIX_HELPERS);
	const [loop, test, report] = spec.artifactGraph.stages;
	assert.equal(loop.type, "loop");
	assert.equal(loop.maxRounds, 3);
	assert.deepEqual(loop.until, {
		stage: "check",
		path: "$.exitCode",
		equals: 0,
	});
	const [write, check] = loop.stages;
	assert.equal(write.id, "write");
	assert.equal(write.readOnly, false);
	assert.equal(write.worktreePolicy, "on");
	assert.ok(write.tools.includes("edit") && write.tools.includes("bash"));
	assert.equal(write.profileRole, "research-execution");
	assert.equal(check.id, "check");
	assert.equal(check.profileRole, "verification");
	assert.equal(check.tools.includes("edit"), false);
	// The loop's children are model stages only; the code runs after the loop and reads it through from.
	assert.equal(test.support.uses, "./helpers/run-tests.mjs");
	assert.deepEqual(test.from, ["fix-loop"]);
	assert.equal(report.support.uses, "./helpers/report-fix.mjs");
	assert.deepEqual(report.from, ["fix-loop", "test"]);
	assert.equal(report.sourcePolicy, "partial");
	// The test command is one value in three places: the writer prompt, the checker prompt and the test stage.
	const command = test.support.options.command;
	assert.deepEqual(command, ["npm", "test"]);
	for (const stage of [write, check])
		assert.ok(stage.prompt.includes(command.join(" ")), stage.id);
	// The exit code is the checker's own field, shown as a key in its example (validate checks the until path).
	assert.match(check.prompt, /"exitCode":/u);
	// Two bundle-local agents in the agents directory, with the tool ceilings the stages need.
	const agent = async (file) =>
		readFile(join(dir, ".agent-workflow/agents", file), "utf8");
	assert.match(
		await agent("fl-writer.md"),
		/^tools: read, grep, find, ls, edit, write, bash$/mu,
	);
	assert.match(
		await agent("fl-checker.md"),
		/^tools: read, grep, find, ls, bash$/mu,
	);
	assert.match(await agent("fl-checker.md"), /^readOnly: false$/mu);
});

/** A worktree of `dir` on the branch the engine would give task-1 of run1, holding a node:test suite. */
async function testWorktree(dir, source) {
	await mkdir(join(dir, "src"), { recursive: true });
	await mkdir(join(dir, "test"), { recursive: true });
	await writeFile(join(dir, "src/value.js"), source);
	await writeFile(
		join(dir, "test/value.test.js"),
		[
			'const test = require("node:test");',
			'const assert = require("node:assert/strict");',
			'const { value } = require("../src/value.js");',
			'test("value is 2", () => assert.equal(value(), 2));',
			'test("value is not 4", () => assert.notEqual(value(), 4));',
			"",
		].join("\n"),
	);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "tests");
	const tree = join(dir, "wt");
	git(dir, "worktree", "add", "-q", "-b", "agent-workflow/run1-task-1", tree);
	return tree;
}

const TEST_CONTEXT = (dir) => ({
	runId: "run1",
	cwd: dir,
	sourceStatuses: [],
});

test("fix-loop: the test stage runs the command in the loop worktree and records pass, fail, excerpt and changes", async () => {
	const { dir, helpers, schema } = await generated(
		"fix-loop",
		"t1",
		FIX_HELPERS,
	);
	const tree = await testWorktree(dir, "exports.value = () => 3;\n");
	const check = validateJsonSchema;
	const testSchema = await schema("test-run.schema.json");
	const options = { command: ["node", "--test"], timeoutMs: 60000 };
	const go = async (opts = options) => {
		const value = await helpers["run-tests.mjs"]({
			options: opts,
			context: TEST_CONTEXT(dir),
		});
		assert.deepEqual(check(value, testSchema).issues, []);
		return value;
	};
	// Red: the real exit code, counts, an excerpt that names the failing test, the worktree and its branch.
	let value = await go();
	assert.equal(value.outcome, "red");
	assert.equal(value.exitCode, 1);
	assert.equal(value.passed, 1);
	assert.equal(value.failed, 1);
	assert.match(value.excerpt, /value is 2/u);
	assert.equal(value.branch, "agent-workflow/run1-task-1");
	assert.equal(await realpath(value.worktree), await realpath(tree));
	assert.deepEqual(value.changedFiles, []);
	// The fix lands in the worktree only; the command then passes and the changed file is listed.
	await writeFile(join(tree, "src/value.js"), "exports.value = () => 2;\n");
	value = await go();
	assert.equal(value.outcome, "green");
	assert.equal(value.exitCode, 0);
	assert.equal(value.failed, 0);
	assert.equal(value.passed, 2);
	assert.equal(value.excerpt, "");
	assert.deepEqual(value.changedFiles, ["src/value.js"]);
	assert.deepEqual(value.protectedChanged, []);
	assert.equal(
		await readFile(join(dir, "src/value.js"), "utf8"),
		"exports.value = () => 3;\n",
	);
	// Editing the tests is reported, not hidden: the protected prefixes default to test/ and tests/.
	await writeFile(join(tree, "test/extra.test.js"), "// added\n");
	value = await go();
	assert.deepEqual(value.protectedChanged, ["test/extra.test.js"]);
	assert.deepEqual(value.changedFiles, ["src/value.js", "test/extra.test.js"]);
	value = await go({ ...options, protectedPrefixes: [] });
	assert.deepEqual(value.protectedChanged, []);
});

test("fix-loop: a command that never ends is killed with its children at the timeout", async () => {
	const { dir, helpers, schema } = await generated(
		"fix-loop",
		"t2",
		FIX_HELPERS,
	);
	const tree = await testWorktree(dir, "exports.value = () => 2;\n");
	await writeFile(
		join(tree, "hang.js"),
		[
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
			'fs.writeFileSync("pids.txt", process.pid + " " + child.pid);',
			"setInterval(() => {}, 1000);",
			"",
		].join("\n"),
	);
	const started = Date.now();
	const value = await helpers["run-tests.mjs"]({
		options: { command: ["node", "hang.js"], timeoutMs: 1000 },
		context: TEST_CONTEXT(dir),
	});
	assert.equal(value.outcome, "timeout");
	assert.ok(Date.now() - started < 15000);
	assert.match(value.note, /killed after 1000 ms/u);
	assert.deepEqual(
		validateJsonSchema(value, await schema("test-run.schema.json")).issues,
		[],
	);
	const [parent, grandchild] = (await readFile(join(tree, "pids.txt"), "utf8"))
		.split(" ")
		.map(Number);
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (
		let attempt = 0;
		attempt < 40 && (alive(parent) || alive(grandchild));
		attempt += 1
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(parent), false);
	assert.equal(alive(grandchild), false);
});

test("fix-loop: a command that cannot start is an error outcome; bad options and a missing or double worktree throw", async () => {
	const { dir, helpers, schema } = await generated(
		"fix-loop",
		"t3",
		FIX_HELPERS,
	);
	const helper = helpers["run-tests.mjs"];
	// No worktree of this run yet: a wiring problem, not a result.
	await assert.rejects(
		helper({ options: {}, context: TEST_CONTEXT(dir) }),
		/no managed worktree of this run/u,
	);
	await testWorktree(dir, "exports.value = () => 2;\n");
	const value = await helper({
		options: { command: ["aw-no-such-command-xyz"] },
		context: TEST_CONTEXT(dir),
	});
	assert.equal(value.outcome, "error");
	assert.equal(value.exitCode, -1);
	assert.deepEqual(
		validateJsonSchema(value, await schema("test-run.schema.json")).issues,
		[],
	);
	for (const [options, pattern] of [
		[{ command: [] }, /argument array/u],
		[{ command: "npm test" }, /argument array/u],
		[{ command: ["npm", ""] }, /argument array/u],
		[{ timeoutMs: 5 }, /timeoutMs/u],
		[{ timeoutMs: 1.5 }, /timeoutMs/u],
		[{ protectedPrefixes: ["test"] }, /protectedPrefixes/u],
		[{ protectedPrefixes: ["../x/"] }, /protectedPrefixes/u],
	])
		await assert.rejects(
			helper({ options, context: TEST_CONTEXT(dir) }),
			pattern,
			JSON.stringify(options),
		);
	// A second managed worktree of the same run is ambiguous and refused, naming both branches.
	git(
		dir,
		"worktree",
		"add",
		"-q",
		"-b",
		"agent-workflow/run1-task-2",
		join(dir, "wt2"),
	);
	await assert.rejects(
		helper({ options: {}, context: TEST_CONTEXT(dir) }),
		/more than one managed worktree.*run1-task-1.*run1-task-2/u,
	);
});

test("fix-loop: under rehearsal the test stage finds the worktree and runs no command", async () => {
	const { dir, helpers } = await generated("fix-loop", "t4", FIX_HELPERS);
	const tree = await testWorktree(dir, "exports.value = () => 2;\n");
	const marker = join(tree, "ran.txt");
	const options = {
		command: ["node", "-e", 'require("node:fs").writeFileSync("ran.txt", "x")'],
	};
	const value = await withEnv({ AGENT_WORKFLOW_REHEARSAL: "1" }, () =>
		helpers["run-tests.mjs"]({ options, context: TEST_CONTEXT(dir) }),
	);
	assert.equal(value.outcome, "green");
	assert.match(value.note, /rehearsal/u);
	await assert.rejects(readFile(marker, "utf8"), /ENOENT/u);
	// The same options outside rehearsal do run the command.
	await helpers["run-tests.mjs"]({ options, context: TEST_CONTEXT(dir) });
	assert.equal(await readFile(marker, "utf8"), "x");
});

test("fix-loop: the output counts of node:test, jest, mocha and pytest are read, an unknown format gives -1", async () => {
	const { dir, helpers } = await generated("fix-loop", "t5", FIX_HELPERS);
	await testWorktree(dir, "exports.value = () => 2;\n");
	const outputs = [
		["Tests:       1 failed, 4 passed, 5 total", 4, 1],
		["Tests  2 failed | 3 passed (5)", 3, 2],
		["  3 passing (10ms)\n  1 failing", 3, 1],
		["==== 1 failed, 6 passed in 0.12s ====", 6, 1],
		["==== 6 passed in 0.12s ====", 6, 0],
		["# pass 2\n# fail 0", 2, 0],
		["nothing recognisable", -1, -1],
	];
	for (const [text, passed, failed] of outputs) {
		const value = await helpers["run-tests.mjs"]({
			options: {
				command: [
					"node",
					"-e",
					`console.log(${JSON.stringify(text)}); process.exit(${failed > 0 ? 1 : 0})`,
				],
			},
			context: TEST_CONTEXT(dir),
		});
		assert.equal(value.passed, passed, text);
		assert.equal(value.failed, failed, text);
	}
});

/** Report helper input: a finished loop and, optionally, the test stage's control. */
function reportInput({ loop, write, check, test }) {
	const rows = [];
	const sources = {};
	if (write) {
		rows.push({
			source: "fix-loop.write",
			stageId: "write",
			status: "completed",
			loop,
		});
		sources["fix-loop.write"] = write;
	}
	if (check) {
		rows.push({
			source: "fix-loop.check",
			stageId: "check",
			status: "completed",
			loop,
		});
		sources["fix-loop.check"] = check;
	}
	if (test) {
		rows.push({ source: "test", stageId: "test", status: "completed" });
		sources.test = test;
	}
	return { sources, options: {}, context: { sourceStatuses: rows } };
}

const HISTORY = [
	{ round: 1, summary: "Round the total", files: ["src/pricing.js"] },
	{ round: 2, summary: "Start pages at 0", files: ["src/paginate.js"] },
];
const TEST_GREEN = {
	outcome: "green",
	command: "npm test",
	exitCode: 0,
	passed: 7,
	failed: 0,
	excerpt: "",
	branch: "agent-workflow/run1-task-1",
	worktree: "/tmp/wt",
	changedTotal: 2,
	changedFiles: ["src/paginate.js", "src/pricing.js"],
	protectedChanged: [],
};

test("fix-loop: the report takes its status from the code run, lists per-round changes and flags unreported files", async () => {
	const { helpers, schema } = await generated("fix-loop", "r1", FIX_HELPERS);
	const report = helpers["report-fix.mjs"];
	const reportSchema = await schema("fix-report.schema.json");
	const valid = (value) =>
		assert.deepEqual(validateJsonSchema(value, reportSchema).issues, []);
	const loop = { loopId: "fix-loop", status: "completed", roundsUsed: 2 };
	const check = { exitCode: 0, history: HISTORY };

	let value = await report(reportInput({ loop, check, test: TEST_GREEN }));
	valid(value);
	assert.equal(value.status, "green");
	assert.equal(value.rounds, 2);
	assert.deepEqual(
		value.rows.map((row) => [row.round, row.tests]),
		[
			[1, "red (the loop went on)"],
			[2, "green"],
		],
	);
	assert.deepEqual(value.rows[0].files, ["src/pricing.js"]);
	assert.deepEqual(value.unreportedFiles, []);
	assert.match(value.markdown, /Status: \*\*green\*\*/u);
	assert.match(value.markdown, /Nothing is merged automatically/u);
	assert.match(value.completionSummaryMarkdown, /green after 2 rounds/u);

	// A changed file no round mentioned is listed.
	value = await report(
		reportInput({
			loop,
			check,
			test: {
				...TEST_GREEN,
				changedFiles: [...TEST_GREEN.changedFiles, "src/secret.js"],
				changedTotal: 3,
			},
		}),
	);
	valid(value);
	assert.deepEqual(value.unreportedFiles, ["src/secret.js"]);
	assert.match(value.markdown, /Changes no round reported: `src\/secret\.js`/u);

	// The checker claimed exit 0, the code run is red: red it is, and the mismatch is said.
	value = await report(
		reportInput({
			loop,
			check,
			test: {
				...TEST_GREEN,
				outcome: "red",
				exitCode: 1,
				failed: 1,
				excerpt: "not ok 3 - rounds",
			},
		}),
	);
	valid(value);
	assert.equal(value.status, "still-failing");
	assert.match(
		value.completionSummaryMarkdown,
		/last check reported exit 0 but the verified run is red/u,
	);
	assert.match(value.markdown, /not ok 3 - rounds/u);

	// The loop ran out of rounds: a plain outcome, not a failure of the report.
	const exhausted = { loopId: "fix-loop", status: "exhausted", roundsUsed: 3 };
	value = await report(
		reportInput({
			loop: exhausted,
			check: {
				exitCode: 1,
				history: [...HISTORY, { round: 3, summary: "Try again", files: [] }],
			},
			test: { ...TEST_GREEN, outcome: "red", exitCode: 1, failed: 2 },
		}),
	);
	valid(value);
	assert.equal(value.status, "still-failing");
	assert.equal(value.status === "failed", false);
	assert.match(
		value.completionSummaryMarkdown,
		/Tests still failing after 3 rounds/u,
	);
	assert.equal(value.rows.length, 3);

	// Green, but the fix edited the tests: flagged, not green.
	value = await report(
		reportInput({
			loop,
			check,
			test: { ...TEST_GREEN, protectedChanged: ["test/pricing.test.js"] },
		}),
	);
	valid(value);
	assert.equal(value.status, "protected-changed");
	assert.match(value.completionSummaryMarkdown, /test\/pricing\.test\.js/u);

	// No test result (the loop or the test stage failed): not verified, with whatever the loop reported.
	value = await report(
		reportInput({
			loop: { loopId: "fix-loop", status: "failed", roundsUsed: 1 },
			write: { history: HISTORY.slice(0, 1) },
		}),
	);
	valid(value);
	assert.equal(value.status, "unverified");
	assert.equal(value.rows[0].tests, "not verified");
	assert.match(value.markdown, /nothing was verified/u);
});

test("fix-loop: report text from the model is escaped, one line, and the options name the loop's stages", async () => {
	const { helpers } = await generated("fix-loop", "r2", FIX_HELPERS);
	const report = helpers["report-fix.mjs"];
	const loop = { loopId: "fix-loop", status: "completed", roundsUsed: 1 };
	const value = await report(
		reportInput({
			loop,
			check: {
				exitCode: 0,
				history: [
					{
						round: 1,
						summary: "a | b\n# heading `x` <b>",
						files: ["src/a|b.js"],
					},
				],
			},
			test: { ...TEST_GREEN, changedFiles: ["src/a|b.js"] },
		}),
	);
	const row = value.markdown
		.split("\n")
		.find((line) => line.startsWith("| 1 |"));
	assert.ok(row);
	assert.equal(row.split("\n").length, 1);
	assert.match(row, /a \\\| b # heading \\`x\\` \\<b\\>/u);
	// Renamed stages are found through options; a wrong option throws.
	const renamed = await report({
		sources: {
			"loop.fix": { history: HISTORY },
			"loop.run": { exitCode: 0, history: HISTORY },
			test: TEST_GREEN,
		},
		options: { loop: "loop", writer: "fix", checker: "run" },
		context: {
			sourceStatuses: [
				{
					source: "loop.run",
					loop: { loopId: "loop", status: "completed", roundsUsed: 2 },
				},
			],
		},
	});
	assert.equal(renamed.rounds, 2);
	await assert.rejects(
		report({
			sources: {},
			options: { loop: "" },
			context: { sourceStatuses: [] },
		}),
		/must be a stage id/u,
	);
});

// -------------------------------------------------------------- adaptive-depth

const DEPTH_HELPERS = [
	"load-items.mjs",
	"plan-depth.mjs",
	"attach-findings.mjs",
	"collect-dispositions.mjs",
	"render-depth.mjs",
];

test("adaptive-depth: triage, caps in code, a quick foreach, a two-step deep path, a collect gate", async () => {
	const { spec } = await generated("adaptive-depth", "ad", DEPTH_HELPERS);
	const stages = Object.fromEntries(
		spec.artifactGraph.stages.map((stage) => [stage.id, stage]),
	);
	assert.deepEqual(Object.keys(stages), [
		"load",
		"triage",
		"plan",
		"quick",
		"investigate",
		"attach-findings",
		"challenge",
		"collect",
		"report",
	]);
	assert.equal(stages.triage.profileRole, "planning");
	// The caps are explicit options of the code stage, not prompt text.
	assert.deepEqual(stages.plan.support.options, { maxDeep: 5, maxSteps: 60 });
	assert.deepEqual(stages.load.support.options.maxItems, 50);
	// One model call per quick item; the deep path is two model steps per item, both foreach over the deep items.
	assert.equal(stages.quick.from.path, "$.quick");
	assert.equal(stages.investigate.from.path, "$.deep");
	assert.equal(stages.investigate.from.source, "plan");
	assert.equal(stages.challenge.from.source, "attach-findings");
	for (const id of ["quick", "investigate", "challenge"]) {
		assert.equal(stages[id].type, "foreach");
		assert.equal(stages[id].each.itemIdentityPath, "$.id");
		assert.ok(stages[id].profileRole);
	}
	// The challenge step carries the investigation inside its item, never only an id.
	assert.match(stages.challenge.each.prompt, /\$\{item\}/u);
	// The gate and the report read the foreach results; a lost item fails the collect stage.
	assert.deepEqual(stages.collect.from, ["load", "plan", "quick", "challenge"]);
	assert.equal(stages.collect.sourcePolicy, "partial");
	assert.deepEqual(stages.report.from, ["collect"]);
	// Triage reads the loaded items through a required read and is told not to invent ids.
	assert.deepEqual(stages.triage.inputPolicy.requiredReads, [
		{ source: "load", artifact: "control" },
	]);
	assert.match(stages.triage.prompt, /do not invent, skip or repeat ids/u);
});

test("adaptive-depth: rehearsal exercises the deep path (investigate, attach, challenge) as well as the quick one", async () => {
	const { dir } = await generated("adaptive-depth", "ad-r", DEPTH_HELPERS);
	const rehearsed = await run(["rehearse", "ad-r", "--json"], dir);
	assert.equal(rehearsed.code, 0, rehearsed.out);
	const report = JSON.parse(rehearsed.out).data;
	assert.deepEqual(report.findings, []);
	const items = Object.fromEntries(
		report.stages.map((stage) => [stage.stage, stage.items]),
	);
	assert.equal(items.quick, 1);
	assert.equal(items.investigate, 1);
	assert.equal(items.challenge, 1);
});

async function writeItems(dir, name, content) {
	await writeFile(
		join(dir, name),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

test("adaptive-depth: load reads a JSON array, an items object or lines, with stable unique ids", async () => {
	const { dir, helpers, schema } = await generated(
		"adaptive-depth",
		"l1",
		DEPTH_HELPERS,
	);
	const load = helpers["load-items.mjs"];
	const loadSchema = await schema("load-items.schema.json");
	const go = async (options) => {
		const value = await load({ options, context: { cwd: dir } });
		assert.deepEqual(validateJsonSchema(value, loadSchema).issues, []);
		return value;
	};
	await writeItems(dir, "items.json", [
		{ id: "I-1", title: "typo" },
		{ id: 2, title: "numeric id" },
	]);
	let value = await go({});
	assert.deepEqual(
		value.items.map((item) => item.id),
		["I-1", "2"],
	);
	assert.deepEqual(JSON.parse(value.items[0].text), {
		id: "I-1",
		title: "typo",
	});
	assert.equal(value.source, "items.json");
	await writeItems(dir, "wrapped.json", { items: ["first", "second"] });
	value = await go({ file: "wrapped.json" });
	assert.deepEqual(value.items, [
		{ id: "item-01", text: "first" },
		{ id: "item-02", text: "second" },
	]);
	await writeItems(dir, "todo.txt", "alpha\n\n  beta  \r\ngamma\n");
	value = await go({ file: "todo.txt" });
	assert.deepEqual(
		value.items.map((item) => item.text),
		["alpha", "beta", "gamma"],
	);
	// A custom id key; a long item is cut and counted, never dropped.
	await writeItems(dir, "keyed.json", [{ key: "a", body: "x".repeat(2000) }]);
	value = await go({ file: "keyed.json", idPath: "key" });
	assert.equal(value.items[0].id, "a");
	assert.equal(value.items[0].text.length, 1000);
	assert.equal(value.truncated, 1);
});

test("adaptive-depth: load fails in plain words on a missing, empty, duplicate, oversized or unsafe input", async () => {
	const { dir, helpers } = await generated(
		"adaptive-depth",
		"l2",
		DEPTH_HELPERS,
	);
	const load = helpers["load-items.mjs"];
	const fails = async (options, pattern) =>
		assert.rejects(
			load({ options, context: { cwd: dir } }),
			pattern,
			JSON.stringify(options),
		);
	await fails({}, /items\.json does not exist/u);
	await writeItems(dir, "empty.json", []);
	await fails({ file: "empty.json" }, /lists no items/u);
	await writeItems(dir, "dup.json", [{ id: "a" }, { id: "a" }]);
	await fails({ file: "dup.json" }, /id a is used by more than one item/u);
	await writeItems(dir, "noobj.json", [{ id: { x: 1 } }]);
	await fails({ file: "noobj.json" }, /id that is not a string or number/u);
	await writeItems(dir, "bad.json", "{not json");
	await fails({ file: "bad.json" }, /not valid JSON/u);
	await writeItems(dir, "scalar.json", '"x"');
	await fails(
		{ file: "scalar.json" },
		/array, or an object with an items array/u,
	);
	await writeItems(dir, "blank.json", ["ok", ""]);
	await fails({ file: "blank.json" }, /item 2 is empty/u);
	await writeItems(
		dir,
		"many.json",
		Array.from({ length: 4 }, (_, index) => `n${index}`),
	);
	await fails(
		{ file: "many.json", maxItems: 3 },
		/lists 4 items, more than support\.options\.maxItems \(3\)/u,
	);
	for (const file of ["../outside.json", "/etc/passwd", "a\\b.json", ""])
		await fails({ file }, /relative path inside the project/u);
	await fails({ maxItems: 51 }, /maxItems must be an integer from 1 to 50/u);
	await fails({ format: "yaml" }, /format must be/u);
	await writeFile(join(root, "elsewhere.json"), "[1]");
	await symlink(join(root, "elsewhere.json"), join(dir, "link.json"));
	await fails({ file: "link.json" }, /is a symlink/u);
	// Under rehearsal a missing file gives two stand-in items; an existing one is still read.
	const value = await withEnv({ AGENT_WORKFLOW_REHEARSAL: "1" }, () =>
		load({ options: {}, context: { cwd: dir } }),
	);
	assert.equal(value.items.length, 2);
});

const LOADED = {
	items: ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6"].map((id) => ({
		id,
		text: `text of ${id}`,
	})),
};
const tiers = (spec) => ({
	tiers: Object.entries(spec).map(([id, tier]) => ({
		id,
		tier,
		reason: `why ${id}`,
	})),
});

test("adaptive-depth: plan gives every item one tier, caps deep items and model calls in code", async () => {
	const { helpers, schema } = await generated(
		"adaptive-depth",
		"p1",
		DEPTH_HELPERS,
	);
	const plan = helpers["plan-depth.mjs"];
	const planSchema = await schema("depth-plan.schema.json");
	const go = async (triage, options = {}) => {
		const value = await plan({ sources: { load: LOADED, triage }, options });
		assert.deepEqual(validateJsonSchema(value, planSchema).issues, []);
		return value;
	};
	let value = await go(
		tiers({
			"I-1": "quick",
			"I-2": "quick",
			"I-3": "quick",
			"I-4": "quick",
			"I-5": "deep",
			"I-6": "deep",
		}),
	);
	assert.deepEqual(
		value.quick.map((item) => item.id),
		["I-1", "I-2", "I-3", "I-4"],
	);
	assert.deepEqual(
		value.deep.map((item) => item.id),
		["I-5", "I-6"],
	);
	assert.equal(value.deep[0].text, "text of I-5");
	assert.equal(value.deep[0].reason, "why I-5");
	assert.equal(value.modelCalls, 1 + 4 + 2 * 2);
	assert.deepEqual(value.demoted, []);

	// The deep cap: only the first maxDeep stay deep, the rest are quick and listed with why.
	value = await go(
		tiers({
			"I-1": "deep",
			"I-2": "deep",
			"I-3": "deep",
			"I-4": "quick",
			"I-5": "quick",
			"I-6": "quick",
		}),
		{ maxDeep: 2 },
	);
	assert.deepEqual(
		value.deep.map((item) => item.id),
		["I-1", "I-2"],
	);
	assert.deepEqual(
		value.quick.map((item) => item.id),
		["I-3", "I-4", "I-5", "I-6"],
	);
	assert.deepEqual(value.demoted, [{ id: "I-3", why: "deep cap 2 reached" }]);
	assert.equal(value.maxDeep, 2);

	// The step cap: 6 items all deep would be 13 calls; maxSteps 10 demotes the last deep items until it fits.
	value = await go(
		tiers(Object.fromEntries(LOADED.items.map((item) => [item.id, "deep"]))),
		{ maxDeep: 20, maxSteps: 10 },
	);
	assert.ok(value.modelCalls <= 10);
	assert.deepEqual(
		value.deep.map((item) => item.id),
		["I-1", "I-2", "I-3"],
	);
	assert.deepEqual(
		value.quick.map((item) => item.id),
		["I-4", "I-5", "I-6"],
	);
	assert.ok(
		value.demoted.every((entry) => entry.why === "step cap 10 reached"),
	);
	assert.deepEqual(
		value.demoted.map((entry) => entry.id),
		["I-4", "I-5", "I-6"],
	);

	// Even an all-quick run over the cap is a plain failure, not a silent cut.
	await assert.rejects(
		go(tiers({}), { maxSteps: 5 }),
		/6 item\(s\) need 7 model calls even with no deep item/u,
	);

	// An item the triage skipped is quick and listed; unknown and repeated ids are ignored and listed.
	value = await go({
		tiers: [
			{ id: "I-1", tier: "deep", reason: "r" },
			{ id: "I-1", tier: "quick", reason: "again" },
			{ id: "nope", tier: "deep", reason: "x" },
			{ id: "I-2", tier: "bogus", reason: "y" },
		],
	});
	assert.deepEqual(
		value.deep.map((item) => item.id),
		["I-1"],
	);
	assert.deepEqual(value.untriaged, ["I-3", "I-4", "I-5", "I-6"]);
	assert.deepEqual(value.ignored, ["I-1", "nope"]);
	assert.equal(
		value.quick.find((item) => item.id === "I-3").reason,
		"not triaged: treated as quick",
	);
	assert.equal(value.quick.find((item) => item.id === "I-2").reason, "y");
	assert.equal(value.deep.length + value.quick.length, LOADED.items.length);
});

test("adaptive-depth: plan rejects bad options and a missing list", async () => {
	const { helpers } = await generated("adaptive-depth", "p2", DEPTH_HELPERS);
	const plan = helpers["plan-depth.mjs"];
	const sources = { load: LOADED, triage: tiers({}) };
	for (const [options, pattern] of [
		[{ maxDeep: 0 }, /maxDeep must be an integer from 1 to 20/u],
		[{ maxDeep: 21 }, /maxDeep/u],
		[{ maxSteps: 201 }, /maxSteps must be an integer from 1 to 200/u],
		[{ maxSteps: "9" }, /maxSteps/u],
	])
		await assert.rejects(plan({ sources, options }), pattern);
	await assert.rejects(
		plan({ sources: { triage: tiers({}) }, options: {} }),
		/no items list/u,
	);
	await assert.rejects(
		plan({ sources: { load: LOADED }, options: {} }),
		/no tiers list/u,
	);
});

const STATUS = (stageId, id, source, status = "completed") => ({
	stageId,
	itemIdentity: id,
	source,
	status,
});

test("adaptive-depth: attach joins each deep item with its own finding by identity and reports a lost one", async () => {
	const { helpers, schema } = await generated(
		"adaptive-depth",
		"a1",
		DEPTH_HELPERS,
	);
	const attach = helpers["attach-findings.mjs"];
	const plan = {
		deep: [
			{ id: "I-5", text: "five", reason: "r5" },
			{ id: "I-6", text: "six", reason: "r6" },
			{ id: "I-7", text: "seven", reason: "r7" },
		],
	};
	const finding = (summary) => ({
		summary,
		rootCause: `cause of ${summary}`,
		evidence: ["a.js"],
		open: [],
	});
	const value = await attach({
		sources: {
			plan,
			investigate: finding("six"),
			"investigate.i-5": finding("five"),
			"investigate.i-7": finding("seven"),
		},
		context: {
			sourceStatuses: [
				STATUS("investigate", "I-6", "investigate"),
				STATUS("investigate", "I-5", "investigate.i-5"),
				STATUS("investigate", "I-7", "investigate.i-7", "failed"),
			],
		},
	});
	assert.deepEqual(
		validateJsonSchema(value, await schema("deep-items.schema.json")).issues,
		[],
	);
	assert.deepEqual(
		value.items.map((item) => [item.id, item.finding.summary, item.text]),
		[
			["I-5", "five", "five"],
			["I-6", "six", "six"],
		],
	);
	assert.deepEqual(value.withoutFinding, ["I-7"]);
	// No deep item: an empty list, so the challenge foreach makes no model call.
	const none = await attach({
		sources: { plan: { deep: [] } },
		context: { sourceStatuses: [] },
	});
	assert.deepEqual(none.items, []);
	await assert.rejects(
		attach({ sources: {}, context: { sourceStatuses: [] } }),
		/no deep list/u,
	);
});

const DISPOSITION = (verdict, answer = "answer") => ({
	verdict,
	answer,
	evidence: ["a.js"],
	confidence: "high",
});
const PLAN = {
	quick: [
		{ id: "I-1", text: "one", reason: "easy" },
		{ id: "I-2", text: "two", reason: "easy" },
	],
	deep: [{ id: "I-5", text: "five", reason: "hard" }],
	demoted: [{ id: "I-2", why: "deep cap 1 reached" }],
};
const LOAD3 = { items: [{ id: "I-1" }, { id: "I-2" }, { id: "I-5" }] };

test("adaptive-depth: collect needs one disposition per input item; a missing one fails the stage", async () => {
	const { helpers, schema } = await generated(
		"adaptive-depth",
		"c1",
		DEPTH_HELPERS,
	);
	const collect = helpers["collect-dispositions.mjs"];
	const collectSchema = await schema("dispositions.schema.json");
	const go = async (sources, rows) => {
		const value = await collect({
			sources: { load: LOAD3, plan: PLAN, ...sources },
			context: { sourceStatuses: rows },
		});
		assert.deepEqual(validateJsonSchema(value, collectSchema).issues, []);
		assert.equal(value.gates.passed, value.status === "passed");
		return value;
	};
	let value = await go(
		{
			quick: DISPOSITION("confirmed", "one"),
			"quick.i-2": DISPOSITION("rejected"),
			challenge: DISPOSITION("confirmed", "five"),
		},
		[
			STATUS("quick", "I-1", "quick"),
			STATUS("quick", "I-2", "quick.i-2"),
			STATUS("challenge", "I-5", "challenge"),
		],
	);
	assert.equal(value.status, "passed");
	assert.equal(value.covered, 3);
	assert.deepEqual(value.missing, []);
	assert.deepEqual(value.byTier, { quick: 2, deep: 1, capped: 1 });
	assert.equal(value.modelSteps, 1 + 1 + 1 + 2);
	assert.deepEqual(
		value.rows.map((row) => [row.id, row.tier, row.steps, row.verdict]),
		[
			["I-1", "quick", 1, "confirmed"],
			["I-2", "quick", 1, "rejected"],
			["I-5", "deep", 2, "confirmed"],
		],
	);
	assert.equal(value.rows[1].capped, true);

	// The deep item's challenge failed: that item is missing, the stage declares failed (the run cannot end completed).
	value = await go(
		{ quick: DISPOSITION("confirmed"), "quick.i-2": DISPOSITION("rejected") },
		[
			STATUS("quick", "I-1", "quick"),
			STATUS("quick", "I-2", "quick.i-2"),
			STATUS("challenge", "I-5", "challenge", "failed"),
		],
	);
	assert.equal(value.status, "failed");
	assert.deepEqual(value.missing, ["I-5"]);
	assert.equal(value.covered, 2);
	assert.match(value.digest, /2 of 3 items have a disposition; missing: I-5/u);
	assert.equal(value.rows[2].verdict, "MISSING");

	// A disposition from the wrong path never fills a gap: the investigate-only item has no quick answer.
	value = await go(
		{
			quick: DISPOSITION("confirmed"),
			"quick.i-2": DISPOSITION("rejected"),
			"quick.i-5": DISPOSITION("confirmed"),
		},
		[
			STATUS("quick", "I-1", "quick"),
			STATUS("quick", "I-2", "quick.i-2"),
			STATUS("quick", "I-5", "quick.i-5"),
		],
	);
	assert.equal(value.status, "failed");
	assert.deepEqual(value.missing, ["I-5"]);
	assert.deepEqual(value.unexpected, ["I-5"]);

	// Every item missing; the digest stays within its 200-character bound.
	value = await go({}, []);
	assert.equal(value.status, "failed");
	assert.deepEqual(value.missing, ["I-1", "I-2", "I-5"]);
	assert.ok(value.digest.length <= 200);
	await assert.rejects(
		collect({ sources: { load: LOAD3 }, context: { sourceStatuses: [] } }),
		/no quick and deep lists/u,
	);
	// Under rehearsal a gap does not fail the stage (the synthetic workers cannot follow the tiers).
	value = await withEnv({ AGENT_WORKFLOW_REHEARSAL: "1" }, () => go({}, []));
	assert.equal(value.status, "passed");
	assert.equal(value.covered, 0);
});

test("adaptive-depth: the report renders one row per item, flags what is missing and escapes worker text", async () => {
	const { helpers, schema } = await generated(
		"adaptive-depth",
		"d1",
		DEPTH_HELPERS,
	);
	const collect = helpers["collect-dispositions.mjs"];
	const render = helpers["render-depth.mjs"];
	const reportSchema = await schema("depth-report.schema.json");
	const collected = await collect({
		sources: {
			load: LOAD3,
			plan: PLAN,
			quick: DISPOSITION("confirmed", "a | b\n# x"),
			"quick.i-2": DISPOSITION("rejected"),
		},
		context: {
			sourceStatuses: [
				STATUS("quick", "I-1", "quick"),
				STATUS("quick", "I-2", "quick.i-2"),
			],
		},
	});
	const value = await render({ sources: { collect: collected } });
	assert.deepEqual(validateJsonSchema(value, reportSchema).issues, []);
	assert.equal(value.status, "failed");
	assert.equal(value.gates.passed, false);
	const rows = value.markdown
		.split("\n")
		.filter((line) => /^\| I-/u.test(line));
	assert.equal(rows.length, 3);
	assert.match(rows[0], /a \\\| b # x/u);
	assert.match(rows[2], /MISSING/u);
	assert.match(value.markdown, /\*\*Incomplete:\*\* no disposition for `I-5`/u);
	assert.match(value.markdown, /2 with a disposition/u);
	assert.match(value.markdown, /I-2 \(quick, cut back by a cap\)/u);
	// A complete collect gives a passed report.
	const complete = await collect({
		sources: {
			load: LOAD3,
			plan: PLAN,
			quick: DISPOSITION("confirmed"),
			"quick.i-2": DISPOSITION("rejected"),
			challenge: DISPOSITION("confirmed"),
		},
		context: {
			sourceStatuses: [
				STATUS("quick", "I-1", "quick"),
				STATUS("quick", "I-2", "quick.i-2"),
				STATUS("challenge", "I-5", "challenge"),
			],
		},
	});
	const ok = await render({ sources: { collect: complete } });
	assert.equal(ok.status, "passed");
	assert.match(ok.markdown, /\| I-5 \| deep \(2 steps\) \|/u);
	assert.match(
		ok.completionSummaryMarkdown,
		/3 item\(s\), 2 quick, 1 deep, 5 model step\(s\)/u,
	);
	await assert.rejects(render({ sources: {} }), /no rows/u);
});
