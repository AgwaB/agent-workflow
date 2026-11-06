import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP19 round 6): pruning host launch claims never follows a symlinked
// `.agent-workflow` or `host-launches` directory and removes only positively identified claim
// files (`<sha256>.json` with the claim schema and matching fingerprint) and their writers' temp
// files — never other JSON, even when old.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const guard = await import("../../dist/hosts/launch-guard.js");

async function temp(t, prefix = "aw-wp19r6-claims-") {
	const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
	t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}

const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
async function oldFile(path, content) {
	await fs.writeFile(path, content);
	await fs.utimes(path, old, old);
}

test("a symlinked host-launches directory is never pruned", async (t) => {
	const cwd = await temp(t);
	const outside = await temp(t, "aw-wp19r6-claims-outside-");
	await fs.mkdir(join(stateDir(cwd), ".agent-workflow"), { recursive: true });
	await fs.symlink(
		outside,
		join(stateDir(cwd), ".agent-workflow", "host-launches"),
	);
	await oldFile(join(outside, "valuable.json"), '{"keep":true}');
	await oldFile(join(outside, `${"a".repeat(64)}.json`), "not a claim");
	const summary = await guard.pruneHostLaunchClaims(cwd);
	assert.deepEqual((await fs.readdir(outside)).sort(), [
		`${"a".repeat(64)}.json`,
		"valuable.json",
	]);
	assert.equal(summary.removed.length, 0);
});

test("a symlinked .agent-workflow ancestor: claims prune never deletes outside", async (t) => {
	const cwd = await temp(t);
	const outside = await temp(t, "aw-wp19r6-claims-outside-state-");
	await fs.symlink(outside, join(stateDir(cwd), ".agent-workflow"));
	await fs.mkdir(join(outside, "host-launches"));
	await oldFile(join(outside, "host-launches", "valuable.json"), "{}");
	await guard.pruneHostLaunchClaims(cwd);
	assert.deepEqual(await fs.readdir(join(outside, "host-launches")), [
		"valuable.json",
	]);
});

test("only positively identified stale claims and temp files are pruned", async (t) => {
	const cwd = await temp(t);
	const dir = guard.launchGuardDir(cwd);
	await fs.mkdir(dir, { recursive: true });
	const fp = "b".repeat(64);
	const other = "c".repeat(64);
	// Ours: a stale claim of a long-dead launch and a crashed writer's temp file.
	await oldFile(
		join(dir, `${fp}.json`),
		JSON.stringify({
			schema: "agent-workflow-host-launch-v1",
			fingerprint: fp,
			claimedAt: old.toISOString(),
			pid: 2 ** 22 + 4321,
			leaseExpiresAt: old.toISOString(),
		}),
	);
	await oldFile(join(dir, `${fp}.json.123.0123456789ab.tmp`), "{");
	// Not ours: other JSON, a claim-named file with foreign or mismatched content.
	await oldFile(join(dir, "notes.json"), "{}");
	await oldFile(join(dir, `${other}.json`), "not json");
	await oldFile(
		join(dir, `${"d".repeat(64)}.json`),
		JSON.stringify({
			schema: "agent-workflow-host-launch-v1",
			fingerprint: other,
		}),
	);
	await oldFile(join(dir, "random.tmp"), "x");
	await guard.pruneHostLaunchClaims(cwd);
	assert.deepEqual((await fs.readdir(dir)).sort(), [
		`${other}.json`,
		`${"d".repeat(64)}.json`,
		"notes.json",
		"random.tmp",
	]);
});
