import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeWorkflowNoticesCommand as command } from "../../dist/core/workflow-notices.js";
import * as hostApi from "../../dist/hosts/api.js";
import { unfinishedRunNotice } from "../../dist/hosts/pi/notices.js";

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
	await mkdir(join(stateDir(cwd), ".agent-workflow", "workflows"), {
		recursive: true,
	});
	return cwd;
}
const root = (cwd) => join(stateDir(cwd), ".agent-workflow", "workflows");
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
		tasks: [
			{
				taskId: "task-1",
				specId: "task-1",
				displayName: "fixture",
				agent: "scout",
				status,
				statusDetail: status,
				workerTaskId: "",
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
async function warnings(cwd, now = Date.now()) {
	return (await unfinishedRunNotice(hostApi, { cwd, env }, now)) ?? "";
}

test("only exact acknowledged failures, interruptions and eligible approval blocks are suppressed", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_failed");
	await fixture(cwd, "workflow_interrupted", { status: "interrupted" });
	await fixture(cwd, "workflow_blocked", {
		status: "blocked",
		parentRunId: "workflow_parent",
		tasks: [
			{
				taskId: "task-1",
				specId: "task-1",
				status: "blocked",
				statusDetail: "executor_needs_decision",
				files: {},
			},
		],
	});
	for (const id of [
		"workflow_failed",
		"workflow_interrupted",
		"workflow_blocked",
	])
		await ack(cwd, id);
	assert.equal(await warnings(cwd), "");
	await fixture(cwd, "workflow_new");
	const message = await warnings(cwd);
	assert.match(message, /workflow_new/);
	assert.doesNotMatch(
		message,
		/workflow_failed|workflow_interrupted|workflow_blocked/,
	);
	assert.equal((await list(cwd)).acknowledgements.length, 3);
});

for (const change of ["status", "updatedAt", "content"]) {
	test(`changed ${change} invalidates acknowledgement and returns to normal deduplication`, async (t) => {
		const cwd = await project(t);
		const id = "workflow_changed";
		const run = await fixture(cwd, id);
		await warnings(cwd, Date.now() - 1_000);
		const observed = await ack(cwd, id);
		assert.equal(await warnings(cwd), "");
		if (change === "status") {
			run.status = "interrupted";
			run.tasks[0].status = "interrupted";
		} else if (change === "updatedAt") run.updatedAt = new Date().toISOString();
		else
			run.tasks[0].lastMessage =
				"different failure with identical status/update timestamp";
		await writeFile(runFile(cwd, id), JSON.stringify(run));
		assert.equal((await list(cwd)).acknowledgements[0].active, false);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				id,
				"--state",
				observed.sha256,
				"--reason",
				"stale observation",
			]),
			/state changed/,
		);
		const now = Date.now() + 1_000;
		assert.match(await warnings(cwd, now), /workflow_changed/);
		assert.equal(await warnings(cwd, now + 1_000), "");
		await ack(cwd, id, "Reviewed changed state");
		assert.equal(await warnings(cwd, now + 7 * 60 * 60 * 1_000), "");
	});
}

test("malformed/invalid sidecars never suppress and mutations preserve their exact bytes", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_invalid");
	await ack(cwd, "workflow_invalid");
	const valid = JSON.parse(await readFile(sidecar(cwd), "utf8"));
	const entry = valid.acknowledgements[0];
	const invalid = [
		"{broken",
		"null",
		"[]",
		JSON.stringify({ ...valid, schema: "future" }),
		...[
			{ ...entry, reason: "" },
			{ ...entry, sha256: "bad" },
			{ ...entry, status: "completed" },
			{ ...entry, updatedAt: "invalid" },
			{ ...entry, updatedAt: "1" },
			{ ...entry, acknowledgedAt: null },
			{ ...entry, runId: "../escape" },
			{ ...entry, unknownField: true },
		].map((value) => JSON.stringify({ ...valid, acknowledgements: [value] })),
		JSON.stringify({ ...valid, acknowledgements: [entry, entry] }),
		JSON.stringify({ ...valid, acknowledgements: [entry, { bad: true }] }),
	];
	let now = Date.now();
	for (const bytes of invalid) {
		await writeFile(sidecar(cwd), bytes);
		await assert.rejects(list(cwd));
		await assert.rejects(command(cwd, ["clear", "workflow_invalid"]));
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				"workflow_invalid",
				"--state",
				entry.sha256,
				"--reason",
				"reviewed",
			]),
		);
		assert.equal(await readFile(sidecar(cwd), "utf8"), bytes);
		assert.match(await warnings(cwd, now), /workflow_invalid/);
		now += 7 * 60 * 60 * 1_000;
	}
});
