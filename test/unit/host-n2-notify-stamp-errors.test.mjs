import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP42 review round 2, N2): the prompt hook's stamp is best-effort
// bookkeeping. When it cannot be replaced or removed (here: a directory at the stamp path), the
// notifications the check already claimed are still printed, the obstruction is never removed
// recursively, and the next prompt checks again (the hook's fast path needs a regular stamp file).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const notify = await import("../../dist/hosts/notify-check.js");
const plugins = await import("../../tools/release/plugins.mjs");

const roots = [];
after(async () => {
	for (const root of roots)
		await rm(root, { recursive: true, force: true, maxRetries: 10 });
});
async function project() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-wp42-n2-")));
	roots.push(cwd);
	return cwd;
}

async function settledRuns(cwd, count) {
	const at = new Date().toISOString();
	for (let index = 0; index < count; index += 1) {
		const runId = `workflow_stamp${index}`;
		const dir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "run.json"),
			JSON.stringify({
				runId,
				name: "stamp",
				type: "workflow",
				createdAt: at,
				updatedAt: at,
				tasks: [
					{
						taskId: "a-1",
						specId: "a",
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
			}),
		);
	}
}

function hook(cwd) {
	return spawnSync(
		"sh",
		[
			"-c",
			plugins.notifyHookCommand(plugins.devCliLaunch(repo), "claude-code"),
		],
		{
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
			input: '{"prompt":"hi"}',
			encoding: "utf8",
		},
	);
}
const delivered = (stdout) =>
	[...stdout.matchAll(/\(run workflow_stamp\d+\)/gu)].length;

for (const count of [1, 6])
	test(`N2: a directory at the stamp path still prints the claimed notifications (${count} run${count === 1 ? "" : "s"})`, async () => {
		const cwd = await project();
		await settledRuns(cwd, count);
		const stamp = join(
			stateDir(cwd),
			".agent-workflow",
			"notify-check",
			"hook-claude-code.stamp",
		);
		await mkdir(join(stamp, "inside"), { recursive: true });
		const first = hook(cwd);
		assert.equal(first.status, 0);
		assert.equal(delivered(first.stdout), Math.min(5, count), first.stdout);
		// The obstruction is never removed recursively.
		assert.ok(existsSync(join(stamp, "inside")));
		const markers = (await readdir(dirname(stamp))).filter((name) =>
			/^workflow_.*\.json$/u.test(name),
		);
		assert.equal(markers.length, Math.min(5, count));
		// The next prompt checks again: the backlog (if any) is delivered with the stamp still blocked.
		const second = hook(cwd);
		assert.equal(delivered(second.stdout), count - Math.min(5, count));
		await rm(stamp, { recursive: true });
		const third = hook(cwd);
		assert.equal(delivered(third.stdout), 0);
		assert.deepEqual((await notify.notifyCheck(cwd)).data.notifications, []);
	});

test("N2: in process, a failed stamp update returns the claimed text and warns on stderr", async () => {
	const cwd = await project();
	await settledRuns(cwd, 1);
	const stamp = join(
		stateDir(cwd),
		".agent-workflow",
		"notify-check",
		"x.stamp",
	);
	await mkdir(join(stamp, "inside"), { recursive: true });
	const writes = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk, ...rest) => {
		writes.push(String(chunk));
		return typeof rest.at(-1) === "function" ? (rest.at(-1)(), true) : true;
	};
	let checked;
	try {
		checked = await notify.notifyCheck(cwd, { stamp: "x" });
	} finally {
		process.stderr.write = original;
	}
	assert.equal(checked.data.notifications.length, 1);
	assert.match(checked.text, /\(run workflow_stamp0\)/u);
	assert.match(writes.join(""), /stamp/u);
	assert.ok(existsSync(join(stamp, "inside")));
});

test("N2 control: a writable stamp path still gets a stamp and the idle fast path", async () => {
	const cwd = await project();
	await settledRuns(cwd, 1);
	const first = hook(cwd);
	assert.equal(delivered(first.stdout), 1);
	assert.ok(
		existsSync(
			join(
				stateDir(cwd),
				".agent-workflow",
				"notify-check",
				"hook-claude-code.stamp",
			),
		),
	);
	assert.equal(hook(cwd).stdout, "");
});
