// WP43 (UI v2): agent rows read a foreach item's title and a finished task's one-line outcome from
// contained control.json files — bounded, cached, and never raw output.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	attachTaskTexts,
	itemTitle,
	oneLine,
	outcomeOf,
	parseItemPath,
} from "../../dist/hosts/dashboard/task-text.js";

const RUN = ".agent-workflow/workflows/workflow_t";
async function project() {
	const cwd = await mkdtemp(join(tmpdir(), "aw-task-text-"));
	const control = async (taskId, value) => {
		await mkdir(join(cwd, RUN, "tasks", taskId), { recursive: true });
		await writeFile(
			join(cwd, RUN, "tasks", taskId, "control.json"),
			typeof value === "string" ? value : JSON.stringify(value),
		);
		return { result: `${RUN}/tasks/${taskId}/result.json` };
	};
	return { cwd, control };
}
const cleanup = (cwd) =>
	rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test("status words become a tone and a readable word", () => {
	assert.deepEqual(outcomeOf({ status: "verified", digest: "Says so." }), {
		status: "Verified",
		tone: "ok",
		text: "Says so.",
	});
	assert.equal(
		outcomeOf({ status: "partially_supported" }).status,
		"Partly supported",
	);
	assert.equal(outcomeOf({ status: "partially_supported" }).tone, "warn");
	assert.equal(outcomeOf({ status: "verification_blocked" }).tone, "err");
	assert.equal(outcomeOf({ verdict: "refuted" }).tone, "err");
	// 2026-11-03: outcomes that leave review work to do are warnings.
	for (const status of ["NEEDS_WORK", "GAPS_FOUND", "Keep", "WEAKEN"])
		assert.equal(outcomeOf({ status }).tone, "warn", status);
	assert.equal(outcomeOf({ status: "Drop" }).tone, "ok");
	assert.equal(outcomeOf({ verdict: "REVIEW_COMPLETE" }).tone, "ok");
	// A long or odd status value is not a status word.
	assert.equal(
		outcomeOf({ status: "x".repeat(80), summary: "S" }).status,
		undefined,
	);
	assert.equal(outcomeOf({ status: "<b>ok</b>" }), undefined);
	assert.equal(outcomeOf(["status"]), undefined);
	// The summary that only repeats the title is skipped for the next candidate.
	assert.equal(
		outcomeOf(
			{ digest: "The claim as written here", conclusion: "Holds." },
			"The claim as written here",
		).text,
		"Holds.",
	);
});

test("titles and lines are one bounded line without control characters", () => {
	assert.equal(
		itemTitle({ id: "c-1", claim: "A\nclaim\u0007 here" }),
		"A claim here",
	);
	assert.equal(itemTitle("plain item"), "plain item");
	assert.equal(itemTitle({ id: "only-an-id" }), undefined);
	assert.equal(oneLine("x".repeat(500)).length, 160);
	assert.ok(oneLine("x".repeat(500)).endsWith("…"));
});

test("item paths accept only $.key and [n] steps", () => {
	assert.deepEqual(parseItemPath("$.inv.items[3]"), ["inv", "items", 3]);
	assert.deepEqual(parseItemPath("$"), []);
	for (const bad of [
		"$..x",
		"$['a']",
		"$.a[-1]",
		"a.b",
		"$.a.__proto__x[0](",
		"$[0]; rm",
	])
		assert.equal(parseItemPath(bad), undefined, bad);
});

test("attachTaskTexts fills item titles and completed outcomes from contained files", async () => {
	const { cwd, control } = await project();
	try {
		const source = await control("task-1", {
			items: [
				{ id: "a", claim: "First claim" },
				{ id: "b", title: "Second" },
			],
		});
		const done = await control("task-3", {
			status: "verified",
			digest: "Confirmed by the source.",
		});
		const running = await control("task-4", {
			status: "verified",
			digest: "Not shown while running.",
		});
		const records = [
			{ taskId: "task-1", status: "completed", files: source },
			{
				taskId: "task-2",
				status: "completed",
				files: {},
				dispatchMap: {
					entries: [
						{
							taskId: "task-3",
							itemSourceTaskId: "task-1",
							itemRef: "src.main:control:$.items[0]",
						},
						{
							taskId: "task-4",
							itemSourceTaskId: "task-1",
							itemRef: "src.main:control:$.items[1]",
						},
						{
							taskId: "task-5",
							itemSourceTaskId: "task-1",
							itemRef: "src.main:control:$.items[9]",
						},
						{
							taskId: "task-6",
							itemSourceTaskId: "task-1",
							itemRef: "src.main:control:$.constructor",
						},
					],
				},
			},
			{ taskId: "task-3", status: "completed", files: done },
			{ taskId: "task-4", status: "running", files: running },
			{ taskId: "task-5", status: "pending", files: {} },
			{ taskId: "task-6", status: "pending", files: {} },
		];
		const targets = records.map((record) => ({ taskId: record.taskId }));
		await attachTaskTexts(cwd, records, targets);
		const by = Object.fromEntries(
			targets.map((target) => [target.taskId, target]),
		);
		assert.equal(by["task-3"].title, "First claim");
		assert.deepEqual(by["task-3"].outcome, {
			status: "Verified",
			tone: "ok",
			text: "Confirmed by the source.",
		});
		assert.equal(by["task-4"].title, "Second");
		assert.equal(
			by["task-4"].outcome,
			undefined,
			"a running task has no outcome yet",
		);
		assert.equal(by["task-5"].title, undefined, "a missing index is no title");
		assert.equal(
			by["task-6"].title,
			undefined,
			"an inherited property is no title",
		);
		assert.equal(by["task-1"].outcome, undefined, "no status or summary keys");
	} finally {
		await cleanup(cwd);
	}
});

test("attachTaskTexts refuses paths outside the artifact root, symlinks out and oversize files", async () => {
	const { cwd, control } = await project();
	const outside = await mkdtemp(join(tmpdir(), "aw-task-text-out-"));
	try {
		await writeFile(
			join(outside, "control.json"),
			JSON.stringify({ status: "verified", digest: "SECRET" }),
		);
		await mkdir(join(cwd, RUN, "tasks", "task-2"), { recursive: true });
		await symlink(
			join(outside, "control.json"),
			join(cwd, RUN, "tasks", "task-2", "control.json"),
		);
		const big = await control(
			"task-3",
			JSON.stringify({ status: "verified", digest: "x".repeat(600_000) }),
		);
		const broken = await control("task-4", "{not json");
		const records = [
			{
				taskId: "task-1",
				status: "completed",
				files: { result: "../../etc/result.json" },
			},
			{
				taskId: "task-2",
				status: "completed",
				files: { result: `${RUN}/tasks/task-2/result.json` },
			},
			{ taskId: "task-3", status: "completed", files: big },
			{ taskId: "task-4", status: "completed", files: broken },
			{
				taskId: "task-5",
				status: "completed",
				files: { result: "/abs/result.json" },
			},
		];
		const targets = records.map((record) => ({ taskId: record.taskId }));
		await attachTaskTexts(cwd, records, targets);
		for (const target of targets)
			assert.equal(target.outcome, undefined, target.taskId);
	} finally {
		await cleanup(cwd);
		await cleanup(outside);
	}
});

test("titles also come from the task's own itemRef or, failing that, the run spec's foreach source", async () => {
	const { cwd, control } = await project();
	try {
		const plan = await control("task-1", {
			items: [
				{ id: "C1", claim: "First" },
				"Second as text",
				{ id: "c3", title: "Third" },
			],
		});
		await writeFile(
			join(cwd, RUN, "spec.json"),
			JSON.stringify({
				artifactGraph: {
					stages: [
						{ id: "plan", type: "single" },
						{
							id: "check",
							type: "foreach",
							from: { source: "plan", path: "$.items" },
						},
						{
							id: "custom",
							type: "foreach",
							from: { source: "plan", path: "$.items" },
							itemIdentityPath: "$.claim",
						},
					],
				},
			}),
		);
		const gen = (taskId, specId, extra = {}) => ({
			taskId,
			specId,
			stageId: specId.split(".")[0],
			kind: "foreach",
			status: "pending",
			files: { result: `${RUN}/tasks/${taskId}/result.json` },
			foreachGenerated: {
				placeholderSpecId: `${specId.split(".")[0]}.item`,
				...extra,
			},
		});
		const records = [
			{
				taskId: "task-1",
				specId: "plan.main",
				stageId: "plan",
				kind: "single",
				status: "completed",
				files: plan,
			},
			gen("task-2", "check.c1"),
			gen("task-3", "check.item-002"),
			gen("task-4", "check.c3"),
			gen("task-5", "check.c9"),
			gen("task-6", "custom.first"),
			gen("task-7", "other.x", {
				itemSourceTaskId: "task-1",
				itemRef: "plan.main:control:$.items[2]",
			}),
		];
		const targets = records.map((record) => ({ taskId: record.taskId }));
		await attachTaskTexts(cwd, records, targets);
		const title = Object.fromEntries(
			targets.map((target) => [target.taskId, target.title]),
		);
		assert.equal(
			title["task-2"],
			"First",
			"id is matched the engine's way (lower-cased)",
		);
		assert.equal(
			title["task-3"],
			"Second as text",
			"an item without id matches by item-NNN",
		);
		assert.equal(title["task-4"], "Third");
		assert.equal(title["task-5"], undefined, "no matching item");
		assert.equal(
			title["task-6"],
			undefined,
			"a custom identity path is not guessed",
		);
		assert.equal(title["task-7"], "Third", "the task's own itemRef");
	} finally {
		await cleanup(cwd);
	}
});
