// New in agent-workflow (WP2c): owner-aware run lock. A lock whose recorded owner is provably dead
// (pid gone, or pid reused = different birth identity) is stolen race-safely; a live owner, an
// unreadable owner record or an unverifiable owner (other host) is never stolen.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { acquireDirectoryLock } from "../../dist/runtime/artifacts/dir-lock.js";
import {
	beginRunRecord,
	readRunRecord,
	reconcileSubagentRun,
	runPaths,
} from "../../dist/runtime/index.js";

const lockModule = new URL(
	"../../dist/runtime/artifacts/dir-lock.js",
	import.meta.url,
).href;
const OWNER_SCHEMA = "agent-workflow-dir-lock-owner-v1";
let root;
let counter = 0;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-dir-lock-owner-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

function freshDir(label) {
	counter += 1;
	return join(root, `${label}-${counter}`);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * A child process that tries to take `lockPath` once (retries 0) and prints "won" or
 * "ELOCKED <message>"; a winner keeps the lock until it is killed or `holdMs` elapses.
 */
function contender(lockPath, { holdMs = 60_000, retries = 0 } = {}) {
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { acquireDirectoryLock } = await import(${JSON.stringify(lockModule)});
try {
	const release = await acquireDirectoryLock(${JSON.stringify(lockPath)}, { retries: ${retries}, retryMs: 25 });
	process.stdout.write("won\\n");
	setTimeout(async () => { await release(); process.exit(0); }, ${holdMs});
} catch (error) {
	process.stdout.write(\`\${error.code} \${error.message}\\n\`);
	process.exit(0);
}`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const firstLine = new Promise((resolve) => {
		const lines = createInterface({ input: child.stdout });
		lines.once("line", resolve);
		child.once("exit", () => resolve("exited"));
	});
	return { child, firstLine };
}

async function kill(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

/** Leave a lock directory behind whose owner was SIGKILLed (and reaped). */
async function staleLockFromKilledHolder(lockPath) {
	const holder = contender(lockPath);
	assert.equal(await holder.firstLine, "won");
	await kill(holder.child);
	assert.equal(await exists(lockPath), true, "SIGKILL leaves the lock behind");
	return holder.child.pid;
}

async function writeOwner(lockPath, fields, token = "fixturetoken") {
	await mkdir(lockPath, { recursive: true });
	await writeFile(
		join(lockPath, `owner-${token}.json`),
		typeof fields === "string"
			? fields
			: `${JSON.stringify({
					schema: OWNER_SCHEMA,
					token,
					host: hostname(),
					acquiredAt: new Date().toISOString(),
					...fields,
				})}\n`,
	);
}

test("a lock left by a SIGKILLed holder is stolen: a later reconcile acquires it and completes", async () => {
	const cwd = freshDir("sigkill");
	await mkdir(cwd, { recursive: true });
	const runId = "run_lock_sigkill";
	const attemptId = "attempt_lock_sigkill";
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: "fixture",
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: "fixture",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
			},
		],
	});
	const { lockPath } = runPaths({ cwd, runId });
	await staleLockFromKilledHolder(lockPath);
	const reconciled = await reconcileSubagentRun({
		cwd,
		runId,
		staleAfterMs: 1,
	});
	assert.equal(reconciled.status, "marked-stale", JSON.stringify(reconciled));
	const record = await readRunRecord({ cwd, runId });
	assert.equal(record.status, "failed");
	assert.equal(record.failureKind, "stale");
	assert.equal(record.activeAttemptId, null);
	assert.equal(await exists(lockPath), false, "the stolen lock was released");
	assert.deepEqual(
		await readdir(dirname(lockPath)),
		[],
		"no tombstones or temp files are left beside the lock",
	);
});

test("a live holder is never stolen (long hold, many contenders)", async () => {
	const lockPath = join(freshDir("live"), "run.lock");
	await mkdir(join(lockPath, ".."), { recursive: true });
	const holder = contender(lockPath, { holdMs: 3_000 });
	assert.equal(await holder.firstLine, "won");
	try {
		const inProcess = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				acquireDirectoryLock(lockPath, { retries: 20, retryMs: 25 }),
			),
		);
		for (const outcome of inProcess) {
			assert.equal(outcome.status, "rejected");
			assert.equal(outcome.reason.code, "ELOCKED");
			assert.match(outcome.reason.message, /Lock file is already being held/u);
			assert.match(outcome.reason.message, /alive/u);
		}
		const others = Array.from({ length: 6 }, () =>
			contender(lockPath, { retries: 10 }),
		);
		const lines = await Promise.all(others.map((other) => other.firstLine));
		for (const line of lines) assert.match(line, /^ELOCKED /u);
		await Promise.all(others.map((other) => kill(other.child)));
		assert.equal(
			holder.child.exitCode,
			null,
			"the holder is still running and still owns the lock",
		);
	} finally {
		await kill(holder.child);
	}
});

test("concurrent stealers of one stale lock: exactly one wins (in-process and across processes)", async () => {
	const lockPath = join(freshDir("steal-race"), "run.lock");
	await mkdir(join(lockPath, ".."), { recursive: true });
	await staleLockFromKilledHolder(lockPath);
	const outcomes = await Promise.allSettled(
		Array.from({ length: 8 }, () =>
			acquireDirectoryLock(lockPath, { retries: 0, retryMs: 25 }),
		),
	);
	const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
	assert.equal(winners.length, 1, JSON.stringify(outcomes));
	for (const outcome of outcomes.filter(
		(candidate) => candidate.status === "rejected",
	))
		assert.equal(outcome.reason.code, "ELOCKED");
	await winners[0].value();
	assert.equal(await exists(lockPath), false);

	const crossLock = join(freshDir("steal-race-processes"), "run.lock");
	await mkdir(join(crossLock, ".."), { recursive: true });
	await staleLockFromKilledHolder(crossLock);
	const stealers = Array.from({ length: 6 }, () => contender(crossLock));
	try {
		const lines = await Promise.all(stealers.map((other) => other.firstLine));
		assert.equal(
			lines.filter((line) => line === "won").length,
			1,
			JSON.stringify(lines),
		);
		for (const line of lines.filter((candidate) => candidate !== "won"))
			assert.match(line, /^ELOCKED /u);
	} finally {
		await Promise.all(stealers.map((other) => kill(other.child)));
	}
});

test("an unreadable or unverifiable owner record is never stolen", async () => {
	const deadPid = await (async () => {
		const probe = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await once(probe, "exit");
		return probe.pid;
	})();
	for (const [label, fields, pattern] of [
		["garbage owner record", "{not json", /owner record .*unreadable/u],
		[
			"owner record without birth identity",
			{ pid: deadPid, birthIdentity: null },
			/birth identity/u,
		],
		[
			"owner on another host",
			{ pid: deadPid, birthIdentity: "x:1:2", host: "some-other-host" },
			/host/u,
		],
		[
			"owner record whose token does not match its file",
			{ pid: deadPid, birthIdentity: "x:1:2", token: "different" },
			/claim in progress|does not match/u,
		],
	]) {
		const lockPath = join(freshDir("unreadable"), "run.lock");
		await writeOwner(lockPath, fields);
		await assert.rejects(
			acquireDirectoryLock(lockPath, { retries: 2, retryMs: 5 }),
			(error) =>
				error.code === "ELOCKED" &&
				/Lock file is already being held/u.test(error.message) &&
				pattern.test(error.message),
			label,
		);
		assert.equal(await exists(lockPath), true, `${label}: not stolen`);
	}
	// A lock directory with no owner record at all (legacy, or a holder still recording) is
	// held, too.
	const empty = join(freshDir("no-owner"), "run.lock");
	await mkdir(empty, { recursive: true });
	await assert.rejects(
		acquireDirectoryLock(empty, { retries: 1, retryMs: 5 }),
		(error) =>
			error.code === "ELOCKED" && /no owner record/u.test(error.message),
	);
});

test("a reused pid (live process, different birth identity) is a dead owner: the lock is stolen", async () => {
	const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	try {
		const lockPath = join(freshDir("pid-reuse"), "run.lock");
		await writeOwner(lockPath, {
			pid: live.pid,
			birthIdentity: `${process.platform}:not-this-process:0`,
		});
		const release = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		const entries = await readdir(lockPath);
		assert.equal(entries.length, 1, JSON.stringify(entries));
		assert.match(entries[0], /^owner-[A-Za-z0-9_-]+\.json$/u);
		assert.notEqual(entries[0], "owner-fixturetoken.json");
		await release();
		assert.equal(await exists(lockPath), false);
		// Same pid with the matching birth identity is alive: not stolen.
		const selfLock = join(freshDir("pid-alive"), "run.lock");
		const { captureProcessIdentity } = await import(
			"../../dist/runtime/process-identity.js"
		);
		const identity = await captureProcessIdentity(live.pid);
		await writeOwner(selfLock, {
			pid: live.pid,
			birthIdentity: identity.birthIdentity,
		});
		await assert.rejects(
			acquireDirectoryLock(selfLock, { retries: 1, retryMs: 5 }),
			(error) => error.code === "ELOCKED" && /alive/u.test(error.message),
		);
	} finally {
		await kill(live);
	}
});

test("process.exit while an acquisition is in flight never leaves an ownerless lock", async () => {
	const dir = freshDir("exit-in-flight");
	await mkdir(dir, { recursive: true });
	for (let index = 0; index < 20; index += 1) {
		const lockPath = join(dir, `run-${index}.lock`);
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const { acquireDirectoryLock } = await import(${JSON.stringify(lockModule)});
await acquireDirectoryLock(${JSON.stringify(join(dir, "warm.lock"))}, { retries: 0, retryMs: 5 }).then((release) => release());
void acquireDirectoryLock(${JSON.stringify(lockPath)}, { retries: 0, retryMs: 5 });
setTimeout(() => process.exit(0), ${index % 4});`,
			],
			{ stdio: "ignore" },
		);
		await once(child, "exit");
		// Whatever the exit interrupted, the next contender gets the lock at once.
		const release = await acquireDirectoryLock(lockPath, {
			retries: 0,
			retryMs: 5,
		});
		await release();
	}
	assert.deepEqual(
		(await readdir(dir)).filter((name) => name !== "warm.lock"),
		[],
		"no lock directories or staged owner records are left",
	);
});
