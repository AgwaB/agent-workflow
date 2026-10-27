// New in agent-workflow (WP12d-1, stage-1 review #11): exact-match rules are written over index-free
// JSON paths (`tasks[].status`), but leaf diffs carry indexed paths (`tasks[0].status`). The rules
// must see the generic path, so an ordinary allowance can never classify an exact-match
// difference. Mutation tests use real recorded run records and their actual leaf-diff paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	classify,
	exactMatchRule,
	jsonLeafDiffs,
	loadExplainedDifferences,
} from "../replay/compare.mjs";
import { loadAllowedDifferences } from "../replay/normalize.mjs";

const fixtureFile = (fixture, rel) =>
	new URL(`../replay/fixtures/${fixture}/normalized/${rel}`, import.meta.url);
const readJson = (fixture, rel) =>
	JSON.parse(readFileSync(fixtureFile(fixture, rel), "utf8"));
const readJsonl = (fixture, rel) =>
	readFileSync(fixtureFile(fixture, rel), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));

/** An ordinary (non-divergence) allowance matching everything in `file`. */
const catchAll = (file) => [
	{
		id: "test-catch-all",
		reason: "test",
		differences: [{ file, path: ".*" }],
	},
];

function leafDiffs(file, recorded, replayed) {
	return jsonLeafDiffs(recorded, replayed).map((diff) => ({ file, ...diff }));
}

test("exactMatchRule matches indexed leaf-diff paths", () => {
	for (const [file, path, id] of [
		["run.json", "tasks[0].status", "task-status-order"],
		["run.json", "tasks[3].taskId", "task-status-order"],
		["run.json", "tasks[1].outputRetry.count", "retry-repair-counts"],
		["run.json", "tasks[0].usage.aggregate.attempts", "retry-repair-counts"],
		[
			"run.json",
			"tasks[2].launchBootstrap.records[1].prompt.sha256",
			"task-prompt-digest",
		],
		["tasks/task-4/read-ledger.jsonl", "[0].returnedBytes", "read-evidence"],
		["tasks/task-4/read-ledger.jsonl", "[12].truncated", "read-evidence"],
	])
		assert.equal(exactMatchRule({ file, path })?.id, id, `${file} ${path}`);
	// The ledger timestamp stays outside the set.
	assert.equal(
		exactMatchRule({ file: "tasks/task-4/read-ledger.jsonl", path: "[0].at" }),
		undefined,
	);
});

test("a mutated task status in a real run record is unexplained despite an allowance", () => {
	const recorded = readJson("minimal", "run.json");
	const replayed = structuredClone(recorded);
	replayed.tasks[0].status = "failed";
	const diffs = leafDiffs("run.json", recorded, replayed);
	assert.deepEqual(
		diffs.map((diff) => diff.path),
		["tasks[0].status"],
	);
	const result = classify(diffs[0], catchAll("^run\\.json$"), []);
	assert.equal(result.class, "unexplained");
	assert.equal(result.exactMatch, "task-status-order");
});

test("a mutated retry count in a real run record is unexplained despite an allowance", () => {
	const recorded = readJson("deep-research", "run.json");
	const replayed = structuredClone(recorded);
	const index = replayed.tasks.findIndex(
		(task) => task.usage?.aggregate?.attempts !== undefined,
	);
	assert.notEqual(index, -1);
	replayed.tasks[index].usage.aggregate.attempts += 1;
	const [diff, ...rest] = leafDiffs("run.json", recorded, replayed);
	assert.equal(rest.length, 0);
	assert.equal(diff.path, `tasks[${index}].usage.aggregate.attempts`);
	const result = classify(diff, catchAll("^run\\.json$"), []);
	assert.equal(result.class, "unexplained");
	assert.equal(result.exactMatch, "retry-repair-counts");
});

test("mutated read-ledger evidence is unexplained despite an allowance", () => {
	const file = "tasks/task-4/read-ledger.jsonl";
	const recorded = readJsonl("deep-research", file);
	const replayed = structuredClone(recorded);
	replayed[0].returnedBytes += 1;
	replayed[0].truncated = !replayed[0].truncated;
	const diffs = leafDiffs(file, recorded, replayed);
	assert.deepEqual(diffs.map((diff) => diff.path).sort(), [
		"[0].returnedBytes",
		"[0].truncated",
	]);
	for (const diff of diffs) {
		const result = classify(diff, catchAll("read-ledger\\.jsonl$"), []);
		assert.equal(result.class, "unexplained", diff.path);
		assert.equal(result.exactMatch, "read-evidence");
	}
	// The committed allow/explain lists do not cover them either (outside the refused-original
	// divergence, which explains every difference of that run).
	for (const diff of diffs)
		assert.equal(
			classify(diff, loadAllowedDifferences(), loadExplainedDifferences(), {
				fixture: "deep-research",
				variant: "engine-only",
			}).class,
			"unexplained",
		);
});
