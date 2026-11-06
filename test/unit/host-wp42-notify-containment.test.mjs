import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP42 review round 1, finding 4): the completion-check writers never write
// through a workspace-controlled symlink. A symlinked `.agent-workflow` or `.agent-workflow/
// notify-check` pointing outside the project leaves the outside directory unchanged, for the
// plugin's prompt hook (whose shell only reads; the stamp is written by `notify-check --stamp`
// through the contained writer) and for `notify-check` / `wait`'s seen-marker called directly.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const notify = await import("../../dist/hosts/notify-check.js");
const runFiles = await import("../../dist/hosts/run-files.js");
const plugins = await import("../../tools/release/plugins.mjs");

let root;
let counter = 0;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp42-notify-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

function settledRun(runId, at = new Date().toISOString()) {
	return {
		runId,
		name: "contained",
		type: "workflow",
		createdAt: at,
		updatedAt: at,
		tasks: [
			{
				taskId: "a-1",
				specId: "a",
				displayName: "a",
				status: "completed",
				statusDetail: "completed",
				files: { output: "" },
			},
		],
		taskSummary: {
			total: 1,
			completed: 1,
			failed: 0,
			interrupted: 0,
			pending: 0,
			running: 0,
			blocked: 0,
			skipped: 0,
		},
	};
}

async function writeRun(workflowsDir, runId) {
	const dir = join(workflowsDir, runId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "run.json"), JSON.stringify(settledRun(runId)));
}

/** Every path under `dir` (relative), sorted: the outside tree before/after. */
async function tree(dir) {
	const entries = await readdir(dir, { recursive: true });
	return entries.map(String).sort();
}

/** `<root>/pN` and `<root>/outsideN`. */
async function layout() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const outside = join(root, `outside${counter}`);
	await mkdir(cwd, { recursive: true });
	await mkdir(outside, { recursive: true });
	return { cwd, outside };
}

/** `.agent-workflow` itself is a symlink to `outside` (which holds a settled run). */
async function symlinkedStateRoot() {
	const { cwd, outside } = await layout();
	await writeRun(join(outside, "workflows"), "workflow_outside1");
	await symlink(outside, join(stateDir(cwd), ".agent-workflow"));
	return { cwd, outside };
}

/** A real `.agent-workflow` with a settled run; `notify-check` is a symlink to `outside`. */
async function symlinkedNotifyDir() {
	const { cwd, outside } = await layout();
	await writeRun(
		join(stateDir(cwd), ".agent-workflow", "workflows"),
		"workflow_inside1",
	);
	await symlink(
		outside,
		join(stateDir(cwd), ".agent-workflow", "notify-check"),
	);
	return { cwd, outside };
}

function hook(cwd, cli = plugins.devCliLaunch(repo)) {
	return spawnSync(
		"sh",
		["-c", plugins.notifyHookCommand(cli, "claude-code")],
		{
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
			input: '{"prompt":"hi"}',
			encoding: "utf8",
		},
	);
}

test("the prompt hook writes nothing outside through a symlinked .agent-workflow", async () => {
	const { cwd, outside } = await symlinkedStateRoot();
	const before = await tree(outside);
	const ran = hook(cwd);
	assert.equal(ran.status, 0, ran.stderr);
	assert.deepEqual(await tree(outside), before, "outside directory unchanged");
});

test("the prompt hook writes nothing outside through a symlinked notify-check directory", async () => {
	const { cwd, outside } = await symlinkedNotifyDir();
	const ran = hook(cwd);
	assert.equal(ran.status, 0, ran.stderr);
	assert.deepEqual(
		await tree(outside),
		[],
		"no stamp, marker or baseline outside",
	);
});

test("the prompt hook's shell only reads: a fake CLI sees no stamp written by the shell", async () => {
	const { cwd } = await layout();
	await writeRun(
		join(stateDir(cwd), ".agent-workflow", "workflows"),
		"workflow_shell1",
	);
	const ran = hook(cwd, { command: "true", args: [] });
	assert.equal(ran.status, 0);
	assert.deepEqual(
		(await readdir(join(stateDir(cwd), ".agent-workflow"))).sort(),
		["workflows"],
		"the shell creates neither notify-check/ nor a stamp",
	);
});

test("the prompt hook stamps through notify-check --stamp and stays idle afterwards", async () => {
	const { cwd } = await layout();
	await writeRun(
		join(stateDir(cwd), ".agent-workflow", "workflows"),
		"workflow_stamp1",
	);
	const first = hook(cwd);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /workflow_stamp1/);
	const names = await readdir(
		join(stateDir(cwd), ".agent-workflow", "notify-check"),
	);
	assert.ok(names.includes("hook-claude-code.stamp"), names.join(","));
	assert.ok(!names.some((name) => name.endsWith(".tmp")), names.join(","));
	assert.equal(hook(cwd).stdout, "");
	const marker = join(root, `cli-started-${counter}`);
	const idle = hook(cwd, {
		command: "sh",
		args: ["-c", `touch ${marker}; exit 0`, "x"],
	});
	assert.equal(idle.status, 0);
	assert.equal(
		await readdir(dirname(marker)).then((all) =>
			all.includes(`cli-started-${counter}`),
		),
		false,
		"no CLI start without a change",
	);
});

function markerCli(name) {
	const marker = join(root, name);
	return {
		marker,
		cli: { command: "sh", args: ["-c", `touch ${marker}; exit 0`, "x"] },
	};
}

async function exists(path) {
	return readdir(dirname(path)).then((all) => all.includes(basename(path)));
}

test("the prompt hook's shell finds the state base of a symlinked project path with spaces", async () => {
	counter += 1;
	const real = join(root, `real project ${counter}`);
	const link = join(root, `link ${counter}`);
	await mkdir(real, { recursive: true });
	await symlink(real, link);
	const fresh = markerCli(`cli-fresh-${counter}`);
	assert.equal(hook(link, fresh.cli).status, 0);
	assert.equal(await exists(fresh.marker), false, "no state: no CLI start");
	await writeRun(
		join(stateDir(real), ".agent-workflow", "workflows"),
		"workflow_link1",
	);
	const changed = markerCli(`cli-changed-${counter}`);
	assert.equal(hook(link, changed.cli).status, 0);
	assert.equal(
		await exists(changed.marker),
		true,
		"a run without a stamp starts the CLI (the shell found the state base)",
	);
	assert.match(hook(link).stdout, /workflow_link1/);
	const idle = markerCli(`cli-idle-${counter}`);
	assert.equal(hook(link, idle.cli).status, 0);
	assert.equal(await exists(idle.marker), false, "stamped and unchanged: idle");
});

test("without realpath on PATH the prompt hook leaves discovery to the CLI", async () => {
	const { cwd } = await layout();
	const bin = join(root, `bin-${counter}`);
	await mkdir(bin);
	for (const tool of [
		"sh",
		"cut",
		"find",
		"head",
		"shasum",
		"sha256sum",
		"touch",
	]) {
		const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
			encoding: "utf8",
		}).stdout.trim();
		if (found) await symlink(found, join(bin, tool));
	}
	const { marker, cli } = markerCli(`cli-norealpath-${counter}`);
	const ran = spawnSync(
		"/bin/sh",
		["-c", plugins.notifyHookCommand(cli, "claude-code")],
		{
			cwd,
			env: { ...process.env, PATH: bin, CLAUDE_PROJECT_DIR: cwd },
			input: '{"prompt":"hi"}',
			encoding: "utf8",
		},
	);
	assert.equal(ran.status, 0, ran.stderr);
	assert.equal(await exists(marker), true, "no hash: the CLI decides");
});

test("notify-check (and --stamp) creates nothing outside through a symlinked .agent-workflow", async () => {
	const { cwd, outside } = await symlinkedStateRoot();
	const before = await tree(outside);
	const result = await notify.notifyCheck(cwd, { stamp: "hook-claude-code" });
	assert.deepEqual(result.data.notifications, []);
	assert.deepEqual(await tree(outside), before, "outside directory unchanged");
	assert.equal(
		await runFiles.containedProjectStateDir(cwd, "notify-check", true),
		undefined,
	);
	assert.deepEqual(await tree(outside), before);
});

test("notify-check (and --stamp) writes nothing through a symlinked notify-check directory", async () => {
	const { cwd, outside } = await symlinkedNotifyDir();
	const result = await notify.notifyCheck(cwd, { stamp: "hook-claude-code" });
	assert.deepEqual(result.data.notifications, []);
	assert.deepEqual(await tree(outside), []);
});

test("wait's seen-marker creates nothing outside through a symlinked .agent-workflow", async () => {
	const { cwd, outside } = await symlinkedStateRoot();
	const before = await tree(outside);
	await notify.markRunNotifySeen(cwd, settledRun("workflow_outside1"));
	assert.deepEqual(await tree(outside), before);
});

test("containedProjectStateDir(create) still creates real directories in a fresh project", async () => {
	const { cwd } = await layout();
	const dir = await runFiles.containedProjectStateDir(
		cwd,
		"notify-check",
		true,
	);
	assert.equal(dir, join(stateDir(cwd), ".agent-workflow", "notify-check"));
	assert.deepEqual(await readdir(join(stateDir(cwd), ".agent-workflow")), [
		"notify-check",
	]);
});
