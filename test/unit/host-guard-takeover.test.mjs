// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP19, stage-2 review #1): the duplicate-launch guard's takeover is
// exclusive and fenced. Two launches that both find the same stale claim can no longer both end
// up `claimed` ("replace, then re-read" was not compare-and-swap), and a live owner whose launch
// takes longer than LAUNCH_CLAIM_STALE_MS (e.g. waiting for a user confirmation) keeps its claim
// because it renews its lease. Record/release only touch the caller's own claim.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { waitUntil } from "../helpers/wait-until.mjs";

const guard = await import("../../dist/hosts/launch-guard.js");

const roots = [];
after(async () => {
	for (const dir of roots.splice(0))
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
	const cwd = await mkdtemp(join(tmpdir(), "aw-wp19-guard-"));
	roots.push(cwd);
	await mkdir(join(stateDir(cwd), ".agent-workflow"), { recursive: true });
	return cwd;
}

/** A pending claim left by a launch that died a long time ago. */
async function staleClaim(cwd, fingerprint, nowMs) {
	const dir = guard.launchGuardDir(cwd);
	await mkdir(dir, { recursive: true });
	const old = new Date(nowMs - 10 * 60_000).toISOString();
	await writeFile(
		join(dir, `${fingerprint}.json`),
		JSON.stringify({
			schema: "agent-workflow-host-launch-v1",
			fingerprint,
			claimedAt: old,
			pid: 2 ** 22 + 12_345,
		}),
	);
}

test("two concurrent takeovers of one stale claim: exactly one is claimed", async () => {
	const cwd = await project();
	const fingerprint = "a".repeat(64);
	const nowMs = Date.now();
	await staleClaim(cwd, fingerprint, nowMs);
	// Deterministic interleaving: both launches have inspected the stale claim before either
	// replaces it (the hook is a no-op where the guard has no takeover step to pause).
	let arrived = 0;
	let open;
	const gate = new Promise((resolve) => {
		open = resolve;
	});
	const beforeTakeover = async () => {
		arrived += 1;
		if (arrived >= 2) open();
		await Promise.race([gate, new Promise((r) => setTimeout(r, 300))]);
	};
	const options = {
		now: () => nowMs,
		inFlightWaitMs: 0,
		beforeTakeover,
	};
	const [a, b] = await Promise.all([
		guard.claimLaunch(cwd, fingerprint, options),
		guard.claimLaunch(cwd, fingerprint, options),
	]);
	const kinds = [a.kind, b.kind].sort();
	assert.deepEqual(kinds, ["claimed", "in-flight"], JSON.stringify(kinds));
	const winner = a.kind === "claimed" ? a : b;
	await winner.release();
});

test("many concurrent takeovers: exactly one claimed", async () => {
	const cwd = await project();
	const fingerprint = "b".repeat(64);
	const nowMs = Date.now();
	await staleClaim(cwd, fingerprint, nowMs);
	const decisions = await Promise.all(
		Array.from({ length: 6 }, () =>
			guard.claimLaunch(cwd, fingerprint, {
				now: () => nowMs,
				inFlightWaitMs: 0,
			}),
		),
	);
	const claimed = decisions.filter((decision) => decision.kind === "claimed");
	assert.equal(claimed.length, 1);
	await claimed[0].release();
});

test("a live owner past 60 s keeps its claim (renewed lease); its record still lands", async () => {
	const cwd = await project();
	const fingerprint = "c".repeat(64);
	let clock = Date.now();
	const now = () => clock;
	const owner = await guard.claimLaunch(cwd, fingerprint, {
		now,
		renewMs: 10,
	});
	assert.equal(owner.kind, "claimed");
	// The owner is still waiting (e.g. on a user confirmation) two minutes later, and has renewed since
	// (2026-11-10: waited for, not assumed after a fixed 150 ms).
	clock += 120_000;
	await waitUntil(
		async () =>
			Date.parse(
				JSON.parse(
					await readFile(
						join(guard.launchGuardDir(cwd), `${fingerprint}.json`),
						"utf8",
					),
				).leaseExpiresAt,
			) > clock,
		"a renewal after the clock moved",
	);
	const second = await guard.claimLaunch(cwd, fingerprint, {
		now,
		inFlightWaitMs: 0,
	});
	assert.equal(second.kind, "in-flight", "live owner's claim was stolen");
	await owner.record("workflow_live_owner");
	const claim = JSON.parse(
		await readFile(
			join(guard.launchGuardDir(cwd), `${fingerprint}.json`),
			"utf8",
		),
	);
	assert.equal(claim.runId, "workflow_live_owner");
	await owner.release();
});

test("record/release of a taken-over claim leave the new owner's claim alone", async () => {
	const cwd = await project();
	const fingerprint = "d".repeat(64);
	let clock = Date.now();
	const now = () => clock;
	// The first owner stops renewing (renewMs far in the future), so its lease expires.
	const first = await guard.claimLaunch(cwd, fingerprint, {
		now,
		renewMs: 3_600_000,
	});
	assert.equal(first.kind, "claimed");
	// WP19 round 2 (N1): an alive owner's expired claim is only abandoned after
	// LAUNCH_CLAIM_ABANDON_MS past its lease.
	clock += guard.LAUNCH_CLAIM_ABANDON_MS + 120_000;
	const second = await guard.claimLaunch(cwd, fingerprint, {
		now,
		inFlightWaitMs: 0,
	});
	assert.equal(second.kind, "claimed");
	await first.record("workflow_old_owner");
	await first.release();
	const file = join(guard.launchGuardDir(cwd), `${fingerprint}.json`);
	const claim = JSON.parse(await readFile(file, "utf8"));
	assert.equal(claim.runId, undefined, "old owner overwrote the new claim");
	assert.equal(claim.token, second.token);
	await second.record("workflow_new_owner");
	assert.equal(
		JSON.parse(await readFile(file, "utf8")).runId,
		"workflow_new_owner",
	);
});

test("lease renewals never overlap: a slow renewal does not pile up later ticks", async () => {
	const cwd = await project();
	const fingerprint = "e".repeat(64);
	const owner = await guard.claimLaunch(cwd, fingerprint, { renewMs: 5 });
	assert.equal(owner.kind, "claimed");
	// Hold the claim's mutex from outside so every renewal has to wait on it.
	const { acquireDirectoryLock } = await import(
		"../../dist/runtime/artifacts/dir-lock.js"
	);
	const lockPath = join(guard.launchGuardDir(cwd), `${fingerprint}.lock`);
	const releaseOutside = await acquireDirectoryLock(lockPath, {
		retries: 0,
		retryMs: 1,
	});
	const lockParent = guard.launchGuardDir(cwd);
	const { readdir } = await import("node:fs/promises");
	let maxStaged = 0;
	const started = Date.now();
	while (Date.now() - started < 400) {
		const names = await readdir(lockParent);
		maxStaged = Math.max(
			maxStaged,
			names.filter((name) => name.includes(".lock.") || name.endsWith(".tmp"))
				.length,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await releaseOutside();
	// One waiting renewal stages at most one owner file next to the lock; overlapping renewals
	// (one per 5 ms tick) would stage dozens.
	assert.ok(maxStaged <= 2, `overlapping renewals staged ${maxStaged} files`);
	await owner.record("workflow_after_contention");
	await owner.release();
});
