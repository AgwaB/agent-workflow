// test-tier: integration
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

/** Unrelated content plus genuine orphans of an adapter whose digest is `length` hex (old). */
async function fixtures(stateDir, length = 32) {
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
	// Genuine orphans this adapter left behind.
	for (const name of orphanNames(length)) {
		if (name === "d".repeat(length)) {
			await fs.mkdir(join(dir, name));
			await fs.utimes(join(dir, name), OLD, OLD);
		} else await oldFile(join(dir, name), "{}\n");
	}
	return dir;
}

function orphanNames(length) {
	return [
		`${"a".repeat(length)}.events.jsonl`,
		`${"b".repeat(length)}.log`,
		`${"c".repeat(length)}.json.123.0a1b2c3d.tmp`,
		`${"c".repeat(length)}.json.123.tmp`,
		"d".repeat(length),
	];
}

const KEPT = [
	"foreign.json",
	"manual-evidence",
	"notes.log",
	"review-notes.md",
];

test("prune keeps unidentified old files and directories, removes genuine orphans", async (t) => {
	const home = await temp(t);
	const lengths = { claude: 40, codex: 32, pi: 64 };
	for (const [id, length] of Object.entries(lengths))
		await fixtures(join(home, "executors", id), length);
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
	const dir = await fixtures(stateDir, 32);
	schedulePeriodicAdapterStatePrune({
		stateDir,
		classify: classifyCodexAttemptRecord,
		attemptDigestLength: 32,
	});
	// The background pass removes the orphans one by one: wait until all are gone.
	const orphans = orphanNames(32);
	for (let i = 0; i < 300; i += 1) {
		const names = await fs.readdir(dir);
		if (!orphans.some((name) => names.includes(name))) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.deepEqual((await fs.readdir(dir)).sort(), KEPT);
});

test("round 8: only the adapter's exact digest length is an orphan (a 56-hex SHA-224 name is kept)", async (t) => {
	const home = await temp(t);
	const lengths = { claude: 40, codex: 32, pi: 64 };
	for (const [id, length] of Object.entries(lengths)) {
		const dir = join(home, "executors", id, "attempts");
		await fs.mkdir(join(dir, "e".repeat(56)), { recursive: true });
		await fs.writeFile(join(dir, "e".repeat(56), "valuable.json"), "keep\n");
		await fs.utimes(join(dir, "e".repeat(56)), OLD, OLD);
		await oldFile(join(dir, `${"f".repeat(56)}.log`), "keep\n");
		// Another adapter's digest length is not this adapter's orphan either.
		const other = length === 32 ? 40 : 32;
		await oldFile(join(dir, `${"1".repeat(other)}.log`), "keep\n");
		// This adapter's own length is.
		await oldFile(join(dir, `${"2".repeat(length)}.log`), "orphan\n");
	}
	const env = { ...process.env, AGENT_WORKFLOW_HOME: home };
	await pruneExecutorAdapterState({ env, dryRun: false });
	for (const [id, length] of Object.entries(lengths)) {
		const other = length === 32 ? 40 : 32;
		const names = (
			await fs.readdir(join(home, "executors", id, "attempts"))
		).sort();
		assert.deepEqual(
			names,
			[
				`${"1".repeat(other)}.log`,
				"e".repeat(56),
				`${"f".repeat(56)}.log`,
			].sort(),
			`${id}: ${names.join(",")}`,
		);
	}
});
