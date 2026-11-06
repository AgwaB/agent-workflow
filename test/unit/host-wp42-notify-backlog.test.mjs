import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP42 review round 1, finding 5): the prompt hook's idle fast path never
// strands the deferred backlog. notify-check delivers at most five runs per check; a check that
// left runs for later does not keep a stamp, so the next prompt checks again (no `run.json` change
// needed) until every settled run was delivered; only then does the hook go idle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { after, before, test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const notify = await import("../../dist/hosts/notify-check.js");
const plugins = await import("../../tools/release/plugins.mjs");

let cwd;
before(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-wp42-backlog-")));
});
after(async () => {
	await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
});

async function settledRuns(count) {
	const at = new Date().toISOString();
	for (let index = 0; index < count; index += 1) {
		const runId = `workflow_backlog${index}`;
		const dir = join(stateDir(cwd), ".agent-workflow", "workflows", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "run.json"),
			JSON.stringify({
				runId,
				name: "backlog",
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
			}),
		);
	}
}

function hook(cli = plugins.devCliLaunch(repo)) {
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

function delivered(stdout) {
	return [...stdout.matchAll(/\(run (workflow_backlog\d+)\) finished/g)].map(
		(match) => match[1],
	);
}

test("six settled runs and two prompts with no run.json change in between deliver all six (five, then one)", async () => {
	await settledRuns(6);
	const first = hook();
	assert.equal(first.status, 0, first.stderr);
	assert.equal(delivered(first.stdout).length, 5, first.stdout);
	assert.match(first.stdout, /1 more finished run/);
	const second = hook();
	assert.equal(second.status, 0, second.stderr);
	const all = [...delivered(first.stdout), ...delivered(second.stdout)];
	assert.equal(delivered(second.stdout).length, 1, second.stdout);
	assert.equal(new Set(all).size, 6, "every run delivered exactly once");
	const pending = await notify.notifyCheck(cwd, { host: "claude-code" });
	assert.deepEqual(pending.data.notifications, [], "nothing left behind");
	// Drained: the stamp is kept now and the next prompt is idle again (no CLI start).
	const names = await readdir(
		join(stateDir(cwd), ".agent-workflow", "notify-check"),
	);
	assert.ok(names.includes("hook-claude-code.stamp"), names.join(","));
	const marker = join(cwd, "cli-started");
	assert.equal(
		hook({ command: "sh", args: ["-c", `touch ${marker}; exit 0`, "x"] })
			.status,
		0,
	);
	assert.equal(
		(await readdir(cwd)).includes("cli-started"),
		false,
		"idle after the backlog drained",
	);
});

test("notify-check --stamp keeps no stamp while runs are deferred", async () => {
	const project = await realpath(
		await mkdtemp(join(tmpdir(), "aw-wp42-backlog-stamp-")),
	);
	try {
		const previous = cwd;
		cwd = project;
		try {
			await settledRuns(7);
		} finally {
			cwd = previous;
		}
		const dir = join(stateDir(project), ".agent-workflow", "notify-check");
		const first = await notify.notifyCheck(project, {
			stamp: "hook-claude-code",
		});
		assert.equal(first.data.deferred, 2);
		assert.ok(!(await readdir(dir)).includes("hook-claude-code.stamp"));
		const drained = await notify.notifyCheck(project, {
			stamp: "hook-claude-code",
		});
		assert.equal(drained.data.notifications.length, 2);
		assert.equal(drained.data.deferred, 0);
		assert.ok((await readdir(dir)).includes("hook-claude-code.stamp"));
	} finally {
		await rm(project, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
