// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-notice-acknowledgements.test.mjs.
// MIT, same author. Deferred until WP11a because it spawned src/cli.mjs and loaded the Pi extension.
// Changes: imports from dist/core and dist/hosts; .pi→.agent-workflow; PI_WORKFLOW_ROLE→
// AGENT_WORKFLOW_ROLE; the CLI is src/hosts/cli/cli.mjs (`agent-workflow`), whose --json output is
// `{action, ok, outcome, data}` and whose usage errors exit 2 (was 1); the slash-command half of
// the parity test now compares the CLI with the host API handler (`noticesAction`) that the Pi host
// (WP11b) calls. Not ported (need the Pi session-start notice `notifyUnfinishedRuns`, Pi host
// WP11b): "only exact acknowledged failures, interruptions and eligible approval blocks are
// suppressed", "changed {status,updatedAt,content} invalidates acknowledgement and returns to
// normal deduplication", "malformed/invalid sidecars never suppress and mutations preserve their
// exact bytes", and the warnings() assertions inside the ported tests (marked in place).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	readRunRecord,
	setRunLeaseTestHooksForTests,
} from "../../dist/core/store.js";
import {
	executeWorkflowNoticesCommand as command,
	parseWorkflowNoticesArgs,
} from "../../dist/core/workflow-notices.js";
import { COMMAND_HELP, noticesAction } from "../../dist/hosts/api.js";

const exec = promisify(execFile);
const cli = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const sidecarName = "notice-acknowledgements.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = { ...process.env, AGENT_WORKFLOW_ROLE: "supervisor" };

async function project(t) {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "workflow-notice-ack-")),
	);
	t.after(() =>
		rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	await mkdir(join(cwd, ".agent-workflow", "workflows"), { recursive: true });
	return cwd;
}
const root = (cwd) => join(cwd, ".agent-workflow", "workflows");
const sidecar = (cwd) => join(root(cwd), sidecarName);
const runFile = (cwd, id) => join(root(cwd), id, "run.json");
async function fixture(cwd, id, overrides = {}) {
	const status = overrides.status ?? "failed";
	const updatedAt = new Date(Date.now() - 60_000).toISOString();
	const run = {
		schemaVersion: 1,
		runId: id,
		name: "notice fixture",
		type: "artifact-graph",
		status,
		cwd,
		createdAt: updatedAt,
		updatedAt,
		specPath: "fixture.json",
		backend: { type: "local", mode: "headless" },
		tasks: [
			{
				taskId: "task-1",
				specId: "task-1",
				displayName: "fixture",
				agent: "scout",
				status,
				statusDetail: status,
				backendTaskId: "",
				files: {},
			},
		],
		...overrides,
	};
	await mkdir(join(root(cwd), id, "attempts"), { recursive: true });
	await writeFile(runFile(cwd, id), JSON.stringify(run));
	await writeFile(
		join(root(cwd), id, "attempts", "raw.md"),
		"original fixture evidence\n",
	);
	return run;
}
async function list(cwd) {
	return JSON.parse(await command(cwd, ["list", "--json"]));
}
async function ack(
	cwd,
	id,
	reason = "Reviewed; preserve without further work",
) {
	const run = (await list(cwd)).notices.find((run) => run.runId === id);
	assert.ok(run);
	await command(cwd, [
		"acknowledge",
		id,
		"--state",
		run.sha256,
		"--reason",
		reason,
	]);
	return run;
}
async function hashes(directory) {
	const result = {};
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(result, await hashes(path));
		else result[path] = digest(await readFile(path));
	}
	return result;
}

test("notices list/ack/clear preserve all original files and leave status/inspect visible", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_preserved");
	// Not ported: the Pi session-start notice baseline (notifyUnfinishedRuns, Pi host WP11b).
	const before = await hashes(root(cwd));
	const listed = await list(cwd);
	assert.equal(
		listed.notices[0].sha256,
		digest(await readFile(runFile(cwd, "workflow_preserved"))),
	);
	await ack(cwd, "workflow_preserved");
	assert.equal((await list(cwd)).acknowledgements[0].active, true);
	assert.equal(
		(await readRunRecord(cwd, "workflow_preserved")).status,
		"failed",
	);
	const inspected = await exec(
		process.execPath,
		[cli, "inspect", "workflow_preserved", "--json"],
		{ cwd, env },
	);
	// agent-workflow CLI: --json prints {action, ok, outcome, data}; data.run is the record.
	assert.equal(JSON.parse(inspected.stdout).data.run.status, "failed");
	await command(cwd, ["clear", "workflow_preserved"]);
	assert.deepEqual((await list(cwd)).acknowledgements, []);
	for (const [path, original] of Object.entries(before))
		assert.equal(digest(await readFile(path)), original, path);
	const added = Object.keys(await hashes(root(cwd))).filter(
		(path) => !(path in before),
	);
	assert.deepEqual(added, [sidecar(cwd)]);
	// Not ported: the cleared run notifies again at Pi session start (notifyUnfinishedRuns, WP11b).
});

test("ineligible runs and prefixes cannot be acknowledged; stale and unrelated entries survive clear", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_keep");
	const changing = await fixture(cwd, "workflow_stale");
	await ack(cwd, "workflow_keep");
	await ack(cwd, "workflow_stale");
	changing.tasks[0].lastMessage = "changed";
	await writeFile(runFile(cwd, "workflow_stale"), JSON.stringify(changing));
	const retained = (await list(cwd)).acknowledgements.find(
		(entry) => entry.runId === "workflow_stale",
	);
	await command(cwd, ["clear", "workflow_keep"]);
	assert.deepEqual((await list(cwd)).acknowledgements, [retained]);
	for (const [id, overrides] of [
		["workflow_done", { status: "completed" }],
		["workflow_running", { status: "running" }],
		["workflow_child", { parentRunId: "workflow_keep" }],
		["workflow_other_block", { status: "blocked" }],
		["workflow_mock", { provenance: { mode: "mock" } }],
	]) {
		await fixture(cwd, id, overrides);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				id,
				"--state",
				"a".repeat(64),
				"--reason",
				"reviewed",
			]),
			/not an eligible/,
		);
	}
	await assert.rejects(
		command(cwd, [
			"acknowledge",
			"workflow_sta",
			"--state",
			"a".repeat(64),
			"--reason",
			"reviewed",
		]),
	);
});

test("independent concurrent CLI acknowledgements keep every entry and leave run evidence untouched", async (t) => {
	const cwd = await project(t);
	for (let index = 0; index < 8; index++)
		await fixture(cwd, `workflow_concurrent_${index}`);
	const before = await hashes(root(cwd));
	const notices = (await list(cwd)).notices;
	const outcomes = await Promise.allSettled(
		notices.map((run) =>
			exec(
				process.execPath,
				[
					cli,
					"notices",
					"acknowledge",
					run.runId,
					"--state",
					run.sha256,
					"--reason",
					`Explicit reason for ${run.runId}`,
				],
				{ cwd, env },
			),
		),
	);
	// Join every subprocess even on failure before test teardown removes its fixture.
	for (const outcome of outcomes)
		assert.equal(
			outcome.status,
			"fulfilled",
			outcome.status === "rejected" ? String(outcome.reason) : "",
		);
	const result = await list(cwd);
	assert.deepEqual(
		result.acknowledgements.map((entry) => entry.runId).sort(),
		notices.map((run) => run.runId).sort(),
	);
	assert.ok(
		result.acknowledgements.every(
			(entry) =>
				entry.active && entry.reason === `Explicit reason for ${entry.runId}`,
		),
	);
	for (const [path, original] of Object.entries(before))
		assert.equal(digest(await readFile(path)), original);
	// Not ported: acknowledged runs stay silent at Pi session start (notifyUnfinishedRuns, WP11b).
});

test("ID/argument validation rejects paths, traversal, missing state/reason and extra options", () => {
	for (const id of [
		"../escape",
		"/absolute",
		"..",
		".",
		"a/b",
		"a\\b",
		"a\0b",
		"--all",
		"a:b",
		"a b",
	]) {
		assert.throws(() => parseWorkflowNoticesArgs(["clear", id]));
		assert.throws(() =>
			parseWorkflowNoticesArgs([
				"acknowledge",
				id,
				"--state",
				"a".repeat(64),
				"--reason",
				"reviewed",
			]),
		);
	}
	for (const args of [
		["list", "--all"],
		["clear", "workflow_a", "--all"],
		["acknowledge", "workflow_a"],
		["acknowledge", "workflow_a", "--state", "a".repeat(64), "--reason", ""],
		[
			"acknowledge",
			"workflow_a",
			"--state",
			"a".repeat(64),
			"--reason",
			"x".repeat(2_001),
		],
		[
			"acknowledge",
			"workflow_a",
			"--state",
			"a".repeat(64),
			"--reason",
			"unsafe\nreason",
		],
	])
		assert.throws(() => parseWorkflowNoticesArgs(args));
});

test("symlink and hard-link evidence escapes are rejected without touching valid targets", async (t) => {
	for (const target of [
		".agent-workflow",
		"workflows",
		"run-dir",
		"run-file",
		"sidecar",
		"lock",
		"hard-linked-run",
		"hard-linked-sidecar",
		"hard-linked-lock",
	]) {
		const cwd = await project(t);
		const outside = await project(t);
		await fixture(cwd, "workflow_escape");
		const observed = await ack(cwd, "workflow_escape");
		await fixture(outside, "workflow_escape");
		await writeFile(
			runFile(outside, "workflow_escape"),
			await readFile(runFile(cwd, "workflow_escape")),
		);
		await writeFile(sidecar(outside), await readFile(sidecar(cwd)));
		const validDestination = await list(outside);
		assert.equal(validDestination.notices[0].sha256, observed.sha256);
		assert.equal(validDestination.acknowledgements[0].active, true);
		let path;
		let destination;
		let safetyError;
		if (target === ".agent-workflow") {
			path = join(cwd, ".agent-workflow");
			destination = join(outside, ".agent-workflow");
			safetyError = "Unsafe workflow notices root.";
		} else if (target === "workflows") {
			path = root(cwd);
			destination = root(outside);
			safetyError = "Unsafe workflow notices root.";
		} else if (target === "run-dir") {
			path = join(root(cwd), "workflow_escape");
			destination = join(root(outside), "workflow_escape");
			safetyError = "Unsafe workflow run directory.";
		} else if (target === "lock" || target === "hard-linked-lock") {
			path = `${sidecar(cwd)}.lock`;
			destination = `${sidecar(outside)}.lock`;
			await writeFile(destination, `${JSON.stringify({ pid: process.pid })}\n`);
			safetyError = "Unsafe notices lock.";
		} else {
			const isRun = target === "run-file" || target === "hard-linked-run";
			path = isRun ? runFile(cwd, "workflow_escape") : sidecar(cwd);
			destination = isRun
				? runFile(outside, "workflow_escape")
				: sidecar(outside);
			safetyError = target.startsWith("hard-linked-")
				? "Unsafe workflow notices file."
				: "ELOOP";
		}
		await rm(path, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		if (target.startsWith("hard-linked-")) await link(destination, path);
		else await symlink(destination, path);
		const before = await hashes(outside);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				"workflow_escape",
				"--state",
				observed.sha256,
				"--reason",
				"reviewed",
			]),
			(error) =>
				safetyError === "ELOOP"
					? error.code === "ELOOP"
					: error.message === safetyError,
			target,
		);
		assert.deepEqual(await hashes(outside), before, target);
	}
});

test("empty list is read-only and creates neither roots nor sidecars", async (t) => {
	const cwd = await project(t);
	const missing = join(cwd, "empty");
	await mkdir(missing);
	assert.deepEqual(await list(missing), {
		notices: [],
		acknowledgements: [],
		warnings: [],
	});
	assert.deepEqual(await readdir(missing), []);
});

for (const change of ["sidecar", "run"]) {
	test(`commit fence preserves concurrently changed ${change} evidence`, async (t) => {
		const cwd = await project(t);
		const id = "workflow_fenced";
		const run = await fixture(cwd, id);
		await ack(cwd, id);
		const observed = (await list(cwd)).notices[0];
		const originalSidecar = await readFile(sidecar(cwd), "utf8");
		const corrupt = "{concurrent invalid evidence";
		let injected = false;
		setRunLeaseTestHooksForTests({
			onBeforeAtomicRename: async ({ file }) => {
				if (file !== sidecar(cwd) || injected) return;
				injected = true;
				if (change === "sidecar") await writeFile(sidecar(cwd), corrupt);
				else {
					run.tasks[0].lastMessage = "Changed at the commit boundary";
					await writeFile(runFile(cwd, id), JSON.stringify(run));
				}
			},
		});
		try {
			await assert.rejects(
				command(cwd, [
					"acknowledge",
					id,
					"--state",
					observed.sha256,
					"--reason",
					"new reason",
				]),
				/changed/,
			);
			assert.ok(injected);
			assert.equal(
				await readFile(sidecar(cwd), "utf8"),
				change === "sidecar" ? corrupt : originalSidecar,
			);
			assert.equal(
				await readFile(runFile(cwd, id), "utf8"),
				JSON.stringify(run),
			);
			assert.equal(
				(await readdir(root(cwd))).some(
					(name) => name.endsWith(".lock") || name.endsWith(".tmp"),
				),
				false,
			);
		} finally {
			setRunLeaseTestHooksForTests();
		}
	});
}

// Changed: "slash/standalone commands share list, acknowledge, clear, errors and help registration"
// now compares the agent-workflow CLI with the host API handler the Pi host calls (no Pi slash
// handler here); help registration is the CLI command help; usage errors exit 2 (was 1).
test("CLI and host API notices share list, acknowledge, clear, errors and help", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_parity");
	assert.match(COMMAND_HELP.notices, /notices acknowledge <exact-run-id>/);
	const cliList = await exec(
		process.execPath,
		[cli, "notices", "list", "--json"],
		{ cwd, env },
	);
	const hostList = await noticesAction(
		{ cwd, env },
		{ argv: ["list", "--json"] },
	);
	assert.equal(hostList.outcome, "success");
	assert.deepEqual(JSON.parse(hostList.text), JSON.parse(cliList.stdout));
	assert.deepEqual(hostList.data, JSON.parse(cliList.stdout));
	const state = JSON.parse(cliList.stdout).notices[0].sha256;
	const acknowledged = await noticesAction(
		{ cwd, env },
		{
			argv: [
				"acknowledge",
				"workflow_parity",
				"--state",
				state,
				"--reason",
				"Explicit  parity reason",
			],
		},
	);
	assert.equal(acknowledged.outcome, "success");
	assert.equal(
		(await list(cwd)).acknowledgements[0].reason,
		"Explicit  parity reason",
	);
	await assert.rejects(
		noticesAction(
			{ cwd, env },
			{ argv: ["acknowledge", "workflow_parity", "--state", state] },
		),
		/Usage: notices/,
	);
	const cleared = await exec(
		process.execPath,
		[cli, "notices", "clear", "workflow_parity", "--json"],
		{ cwd, env },
	);
	assert.equal(JSON.parse(cleared.stdout).notificationOnly, true);
	await exec(
		process.execPath,
		[
			cli,
			"notices",
			"acknowledge",
			"workflow_parity",
			"--state",
			state,
			"--reason",
			"CLI parity reason",
		],
		{ cwd, env },
	);
	assert.equal(
		(await noticesAction({ cwd, env }, { argv: ["clear", "workflow_parity"] }))
			.outcome,
		"success",
	);
	assert.deepEqual((await list(cwd)).acknowledgements, []);
	await assert.rejects(
		noticesAction({ cwd, env }, { argv: ["clear", "../escape"] }),
		/Invalid workflow run id/,
	);
	await assert.rejects(
		exec(process.execPath, [cli, "notices", "clear", "../escape"], {
			cwd,
			env,
		}),
		(error) => error.code === 2,
	);
	await assert.rejects(
		exec(process.execPath, [cli, "notices", "list"], {
			cwd,
			env: { ...env, AGENT_WORKFLOW_ROLE: "worker" },
		}),
		/not allowed/,
	);
	assert.equal(
		(await readdir(root(cwd))).some(
			(name) => name.includes("supervisor") || name.includes("supervise"),
		),
		false,
	);
});
