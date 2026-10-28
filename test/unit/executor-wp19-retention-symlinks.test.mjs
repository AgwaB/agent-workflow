// New in agent-workflow (WP19, stage-2 review #3): adapter-state retention checks physical
// containment. A symlinked ancestor (`<stateDir>/runs` for Pi, `<stateDir>/attempts` for every
// adapter) pointing outside the state dir is refused; files outside the state dir survive.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyCodexAttemptRecord } from "../../dist/executors/codex/state.js";
import { classifyPiAttemptRecord } from "../../dist/executors/pi/state.js";
import { pruneAdapterAttemptState } from "../../dist/executors/state-retention.js";

const OLD = new Date(Date.now() - 30 * 86_400_000);

async function aged(path) {
	await utimes(path, OLD, OLD);
}

test("review #3: Pi prune through a symlinked <stateDir>/runs keeps the outside sentinel", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-sym-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stateDir = join(root, "state");
	const outside = join(root, "outside");
	await mkdir(join(stateDir, "attempts"), { recursive: true });
	await mkdir(join(outside, "h1"), { recursive: true });
	const sentinel = join(outside, "h1", "sentinel.txt");
	await writeFile(sentinel, "outside the state dir\n");
	await aged(join(outside, "h1"));
	await symlink(outside, join(stateDir, "runs"));
	const record = join(stateDir, "attempts", "h1.json");
	await writeFile(
		record,
		JSON.stringify({
			schema: "agent-workflow-pi-attempt-v1",
			attemptKey: "k1",
			phase: "exited",
			runDir: join(stateDir, "runs", "h1"),
			exit: { exitCode: 0, signal: null, cancelled: false },
			updatedAt: OLD.toISOString(),
		}),
	);
	await aged(record);
	const summary = await pruneAdapterAttemptState({
		stateDir,
		classify: (value) => classifyPiAttemptRecord(stateDir, value),
	});
	assert.equal(existsSync(sentinel), true, "outside sentinel was deleted");
	assert.ok(
		summary.errors.some((error) => /symlink/.test(error)),
		JSON.stringify(summary.errors),
	);
});

test("review #3: a symlinked <stateDir>/attempts is refused (outside records survive)", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19-sym-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stateDir = join(root, "state");
	const outside = join(root, "elsewhere");
	await mkdir(stateDir, { recursive: true });
	await mkdir(outside, { recursive: true });
	const record = join(outside, "x.json");
	const companion = join(outside, "x.events.jsonl");
	await writeFile(
		record,
		JSON.stringify({
			schema: "agent-workflow-codex-attempt-v1",
			attemptKey: "k",
			phase: "revoked",
			updatedAt: OLD.getTime(),
		}),
	);
	await writeFile(companion, "{}\n");
	await aged(record);
	await aged(companion);
	await symlink(outside, join(stateDir, "attempts"));
	const summary = await pruneAdapterAttemptState({
		stateDir,
		classify: classifyCodexAttemptRecord,
	});
	assert.equal(existsSync(record), true, "outside record was deleted");
	assert.equal(existsSync(companion), true, "outside companion was deleted");
	assert.ok(summary.errors.length > 0);
});
