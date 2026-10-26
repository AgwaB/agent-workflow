// New in agent-workflow (WP2b): terminal-last-write invariant under CPU load. Observers and
// reconcile rely on: once an attempt's result.json is terminal, every attempt artifact is complete
// and present (stderr.log, output.log, exec-events.jsonl when a ref exists, a decided
// authority.json when consume ran, every artifact the result lists, the worktree finalization, and
// an ack for every control request written before the mailbox closed). Many durable runs across
// the terminal paths (completed, released barrier, engine revoke, barrier timeout, rediscovery
// refusal, fence violation, SIGTERM, mailbox cancel, worktree) are observed by a tight poller that
// reads every artifact the moment result.json turns terminal, while busy child processes load the
// CPU. Zero misses are allowed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
	createDurableLaunchBarrierV2,
	interruptSubagent,
	readRunEvents,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	runSubagent,
	waitForDurableLaunchBarrierV2Ready,
	waitForSubagent,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DECIDED_AUTHORITY = new Set(["released", "revoked", "failed"]);
let root;
let counter = 0;
const burners = [];

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-terminal-last-write-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
	// CPU load: one busy child per core (bounded), killed in after().
	const count = Math.max(2, Math.min(8, availableParallelism()));
	for (let index = 0; index < count; index += 1)
		burners.push(
			spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
		);
});
after(async () => {
	for (const burner of burners) burner.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
});

function fresh(label) {
	counter += 1;
	return {
		cwd: join(root, `${label}-${counter}`),
		effectLog: join(root, `${label}-${counter}.effects.jsonl`),
		barrierDir: join(root, `${label}-${counter}.barrier`),
	};
}

function attemptDir(cwd, run) {
	return join(
		cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
}

async function createRepo(repo) {
	await mkdir(repo, { recursive: true });
	await execFileAsync("git", ["init"], { cwd: repo });
	await writeFile(join(repo, "README.md"), "base\n");
	await execFileAsync("git", ["add", "README.md"], { cwd: repo });
	await execFileAsync(
		"git",
		[
			"-c",
			"user.name=AW Check",
			"-c",
			"user.email=aw-check@example.invalid",
			"commit",
			"-m",
			"init",
		],
		{ cwd: repo },
	);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Everything that must hold the moment result.json is terminal. Synchronous on purpose: no other
 * work interleaves between seeing the terminal result and reading the artifacts.
 */
function invariantProblems(dir, result, effectLog) {
	const problems = [];
	const present = (name) => existsSync(join(dir, name));
	for (const name of ["stderr.log", "output.log"])
		if (!present(name)) problems.push(`${name} missing`);
	for (const artifact of result.artifacts ?? []) {
		const path = join(result.cwd, artifact.path);
		if (!existsSync(path)) {
			problems.push(`listed artifact ${artifact.type} missing`);
			continue;
		}
		if (
			artifact.type !== "result" &&
			artifact.type !== "worker" &&
			typeof artifact.bytes === "number" &&
			statSync(path).size !== artifact.bytes
		)
			problems.push(
				`listed artifact ${artifact.type} has ${statSync(path).size} bytes, result says ${artifact.bytes}`,
			);
	}
	if (
		result.metadata?.executor?.ref !== undefined &&
		!present("exec-events.jsonl")
	)
		problems.push("exec-events.jsonl missing although a ref exists");
	const consumed = readEffectLog(effectLog).some(
		(entry) => entry.type === "consume",
	);
	const authority = readJson(join(dir, "authority.json"));
	if (consumed && authority === undefined)
		problems.push("authority.json missing although consume ran");
	if (authority !== undefined && !DECIDED_AUTHORITY.has(authority.phase))
		problems.push(`authority.json phase ${authority.phase} is not decided`);
	if (
		result.workspace?.mode === "worktree" &&
		!["removed", "kept", "failed"].includes(
			result.workspace.worktreeCleanupStatus,
		)
	)
		problems.push(
			`worktree not finalized (${result.workspace.worktreeCleanupStatus})`,
		);
	const controlDir = join(dir, "control");
	if (existsSync(controlDir)) {
		const names = readdirSync(controlDir);
		if (!names.includes("closed.json"))
			problems.push("control mailbox not closed");
		const closedAt = readJson(join(controlDir, "closed.json"))?.lastSeq ?? 0;
		for (const name of names) {
			const match = /^(\d+)-[a-z_]+\.json$/u.exec(name);
			if (match === null) continue;
			const seq = Number(match[1]);
			if (seq <= closedAt && !names.includes(`${match[1]}.ack.json`))
				problems.push(`control request ${name} has no ack`);
		}
	}
	return problems;
}

/** Tight poll of result.json; checks the invariant on the first terminal read. */
async function observe(dir, effectLog, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// The registry (run.json) commits from the terminal result, never ahead of it.
		const record = readJson(join(dir, "../../run.json"));
		const result = readJson(join(dir, "result.json"));
		if (result !== undefined && TERMINAL.has(result.status))
			return { result, problems: invariantProblems(dir, result, effectLog) };
		if (record !== undefined && TERMINAL.has(record.status))
			return {
				result,
				problems: [`run.json is ${record.status} before result.json`],
			};
		await new Promise((resolve) => setImmediate(resolve));
	}
	return { result: undefined, problems: ["no terminal result.json"] };
}

async function barrier(dir, timeoutMs = 30_000) {
	return await createDurableLaunchBarrierV2({
		directory: dir,
		subjectSha256: sha256(`subject:${dir}`),
		timeoutMs,
		pollIntervalMs: 5,
	});
}

async function waitForEvent(dir, type, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (readFileSync(join(dir, "exec-events.jsonl"), "utf8").includes(type))
				return;
		} catch {
			// not yet
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`no ${type} event`);
}

const SCENARIOS = {
	async completed() {
		const { cwd, effectLog } = fresh("completed");
		await mkdir(cwd, { recursive: true });
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "complete",
			async: true,
		});
		return { cwd, run, effectLog, expect: "completed" };
	},
	async released() {
		const { cwd, effectLog, barrierDir } = fresh("released");
		await mkdir(cwd, { recursive: true });
		const descriptor = await barrier(barrierDir);
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "complete after release",
			async: true,
			durableLaunchBarrier: descriptor,
		});
		const ready = await waitForDurableLaunchBarrierV2Ready(descriptor);
		await resolveDurableLaunchBarrierV2Release(
			descriptor,
			ready,
			sha256(`release:${ready.readySha256}`),
		);
		return { cwd, run, effectLog, expect: "completed" };
	},
	async revoked() {
		const { cwd, effectLog, barrierDir } = fresh("revoked");
		await mkdir(cwd, { recursive: true });
		const descriptor = await barrier(barrierDir);
		await revokeDurableLaunchBarrierV2(descriptor, {
			cancellationId: "stop-before-launch",
			reasonSha256: sha256("stop"),
		});
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "never",
			async: true,
			durableLaunchBarrier: descriptor,
		});
		return { cwd, run, effectLog, expect: "cancelled" };
	},
	async barrierTimeout() {
		const { cwd, effectLog, barrierDir } = fresh("barrier-timeout");
		await mkdir(cwd, { recursive: true });
		const descriptor = await barrier(barrierDir, 300);
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "never released",
			async: true,
			durableLaunchBarrier: descriptor,
		});
		return { cwd, run, effectLog, expect: "failed" };
	},
	async refused() {
		const { cwd, effectLog } = fresh("refused");
		await mkdir(cwd, { recursive: true });
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }, { version: "9.0.0" }),
			task: "never",
			async: true,
		});
		return { cwd, run, effectLog, expect: "failed" };
	},
	async fenceViolation() {
		const { cwd, effectLog } = fresh("fence");
		await mkdir(cwd, { recursive: true });
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog, mode: "skip-consume" }),
			task: "misbehave",
			async: true,
		});
		return { cwd, run, effectLog, expect: "failed" };
	},
	async sigterm() {
		const { cwd, effectLog } = fresh("sigterm");
		await mkdir(cwd, { recursive: true });
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog, stepDelayMs: 300 }),
			task: "slow",
			async: true,
		});
		return {
			cwd,
			run,
			effectLog,
			expect: "cancelled",
			async act() {
				await waitForEvent(attemptDir(cwd, run), "started");
				await interruptSubagent({
					cwd,
					runId: run.runId,
					attemptId: run.attemptId,
					reason: "stress",
					escalateAfterMs: 10_000,
					killAfterMs: 20_000,
				});
			},
		};
	},
	async worktree() {
		const { cwd, effectLog } = fresh("worktree");
		await createRepo(cwd);
		const run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "complete in a worktree",
			workspace: "worktree",
			async: true,
		});
		return { cwd, run, effectLog, expect: "completed" };
	},
};

test("terminal-last-write: every artifact is present the moment result.json is terminal (CPU load, many runs)", async () => {
	const rounds = 3;
	const misses = [];
	const statuses = [];
	for (let round = 0; round < rounds; round += 1) {
		await Promise.all(
			Object.entries(SCENARIOS).map(async ([name, start]) => {
				const staged = await start();
				const dir = attemptDir(staged.cwd, staged.run);
				const observed = observe(dir, staged.effectLog);
				await staged.act?.();
				const { result, problems } = await observed;
				statuses.push([name, result?.status]);
				if (result?.status !== staged.expect)
					problems.push(`status ${result?.status}, expected ${staged.expect}`);
				for (const problem of problems)
					misses.push(`${name}#${round}: ${problem}`);
				// Let the finalizer commit and publish before the next round (and before cleanup).
				const waited = await waitForSubagent({
					cwd: staged.cwd,
					runId: staged.run.runId,
					attemptId: staged.run.attemptId,
					timeoutMs: 60_000,
					pollIntervalMs: 25,
				});
				const deadline = Date.now() + 60_000;
				while (
					Date.now() < deadline &&
					!(
						await readRunEvents(
							{ cwd: staged.cwd, runId: staged.run.runId },
							Infinity,
						)
					).some((event) => event.type === `run.${waited.snapshot?.status}`)
				)
					await new Promise((resolve) => setTimeout(resolve, 25));
			}),
		);
	}
	assert.equal(statuses.length, rounds * Object.keys(SCENARIOS).length);
	assert.deepEqual(misses, []);
});
