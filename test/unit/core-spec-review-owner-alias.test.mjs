import { stateDir } from "../helpers/state-dir.mjs";
// agent-workflow 2026-11-04 (live claude/haiku spec-review workflow_mw2hhe44_d3766c, frozen in
// test/fixtures/support-replay): the report stage copied the first owner row with source
// "verify-findings.finding-001" instead of its alias "verify-findings", and a correct GAPS_FOUND
// review failed. The renderer now compares the report's copy without the routing alias; every
// identity field still has to match.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { materialize, replaySupport } from "../helpers/support-replay.mjs";

const LABEL = "claude-spec-review-d3766c";

async function finalWith(edit) {
	const { cwd, run } = materialize(LABEL);
	try {
		const report = run.tasks.find((task) => task.specId === "report.main");
		const path = join(
			stateDir(cwd),
			".agent-workflow",
			"workflows",
			run.runId,
			"tasks",
			report.taskId,
			"control.json",
		);
		const control = JSON.parse(readFileSync(path, "utf8"));
		edit(control);
		writeFileSync(path, JSON.stringify(control));
		return (await replaySupport(cwd, run))["final.main"];
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("spec-review: the report's owner-ledger copy may spell the source alias differently", async () => {
	const recorded = await finalWith(() => {});
	assert.equal(recorded.status, "passed");
	assert.equal(recorded.verdict, "GAPS_FOUND");
	const anyAlias = await finalWith((control) => {
		for (const row of control.ownerLedger)
			row.source = `verify-findings.${row.itemIdentity}`;
	});
	assert.equal(anyAlias.status, "passed");
});

test("spec-review: a report owner row with another task, item or status still fails", async () => {
	for (const [field, value] of [
		["taskId", "task-999"],
		["itemIdentity", "finding-999"],
		["specId", "verify-findings.finding-999"],
		["status", "failed"],
	]) {
		const final = await finalWith((control) => {
			control.ownerLedger[0][field] = value;
		});
		assert.equal(final.status, "failed", field);
		assert.ok(
			final.blockers.some((row) =>
				/owner ledger or reconciliation does not match/.test(row),
			),
			field,
		);
	}
	const dropped = await finalWith((control) => {
		control.ownerLedger.pop();
	});
	assert.equal(dropped.status, "failed");
});
