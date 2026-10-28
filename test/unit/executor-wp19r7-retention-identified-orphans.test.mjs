// New in agent-workflow (WP19 round 7, stage-2 re-review): the adapter-state orphan sweep removes
// only names an adapter writes under `attempts/` (hex attemptKey digest alone or with a companion
// / atomic-write temp suffix). Notes, other tools' files and directories there are never touched,
// neither by `prune` (host wrapper) nor by the background retention on submit.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { pruneExecutorAdapterState } = await import(
	"../../dist/hosts/adapter-state.js"
);
const { schedulePeriodicAdapterStatePrune } = await import(
	"../../dist/executors/state-retention.js"
);
const { classifyCodexAttemptRecord } = await import(
	"../../dist/executors/codex/state.js"
);

const OLD = new Date(Date.now() - 30 * 86_400_000);

async function temp(t) {
	const path = await fs.mkdtemp(join(tmpdir(), "aw-wp19r7-retention-"));
	t.after(() => fs.rm(path, { recursive: true, force: true, maxRetries: 5 }));
	return path;
}

async function oldFile(path, text) {
	await fs.writeFile(path, text);
	await fs.utimes(path, OLD, OLD);
}

/** Unrelated content plus genuine adapter orphans (old, no record). */
async function fixtures(stateDir) {
	const dir = join(stateDir, "attempts");
	await fs.mkdir(join(dir, "manual-evidence"), { recursive: true });
	await oldFile(
		join(dir, "review-notes.md"),
		"unrelated manual review notes\n",
	);
	await oldFile(join(dir, "manual-evidence", "valuable.json"), "keep\n");
	await fs.utimes(join(dir, "manual-evidence"), OLD, OLD);
	await oldFile(
		join(dir, "foreign.json"),
		JSON.stringify({ schema: "other-tool", keep: true }),
	);
	await oldFile(join(dir, "notes.log"), "not an adapter log\n");
	// Genuine orphans an adapter left behind.
	await oldFile(join(dir, `${"a".repeat(32)}.events.jsonl`), "{}\n");
	await oldFile(join(dir, `${"b".repeat(40)}.log`), "log\n");
	await oldFile(join(dir, `${"c".repeat(64)}.json.123.0a1b2c3d.tmp`), "{");
	await fs.mkdir(join(dir, "d".repeat(40)));
	await fs.utimes(join(dir, "d".repeat(40)), OLD, OLD);
	return dir;
}

const KEPT = [
	"foreign.json",
	"manual-evidence",
	"notes.log",
	"review-notes.md",
];

test("prune keeps unidentified old files and directories, removes genuine orphans", async (t) => {
	const home = await temp(t);
	for (const id of ["claude", "codex", "pi"])
		await fixtures(join(home, "executors", id));
	const env = { ...process.env, AGENT_WORKFLOW_HOME: home };
	await pruneExecutorAdapterState({ env, dryRun: false });
	for (const id of ["claude", "codex", "pi"]) {
		const names = (
			await fs.readdir(join(home, "executors", id, "attempts"))
		).sort();
		assert.deepEqual(names, KEPT, `${id}: ${names.join(",")}`);
		assert.equal(
			await fs.readFile(
				join(
					home,
					"executors",
					id,
					"attempts",
					"manual-evidence",
					"valuable.json",
				),
				"utf8",
			),
			"keep\n",
		);
	}
});

test("background retention never removes unrelated old content", async (t) => {
	const stateDir = await temp(t);
	const dir = await fixtures(stateDir);
	schedulePeriodicAdapterStatePrune({
		stateDir,
		classify: classifyCodexAttemptRecord,
	});
	// The background pass removes the orphans one by one: wait until all four are gone.
	const orphans = [
		`${"a".repeat(32)}.events.jsonl`,
		`${"b".repeat(40)}.log`,
		`${"c".repeat(64)}.json.123.0a1b2c3d.tmp`,
		"d".repeat(40),
	];
	for (let i = 0; i < 300; i += 1) {
		const names = await fs.readdir(dir);
		if (!orphans.some((name) => names.includes(name))) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.deepEqual((await fs.readdir(dir)).sort(), KEPT);
});
