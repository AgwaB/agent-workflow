// New in agent-workflow (WP18b): retention of the executor adapters' attempt state (Claude, Codex,
// Pi records under `<stateDir>/attempts/`): terminal records older than the window go with their
// companions; non-terminal, unreadable and recent records stay; `agent-workflow prune` prunes the
// default state dirs (dry run unless --yes); adapters prune in the background on submit. Temp state
// dirs only; the real ~/.agent-workflow is never touched.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const retention = await import("../../dist/executors/state-retention.js");
const claudeState = await import("../../dist/executors/claude/state.js");
const codexState = await import("../../dist/executors/codex/state.js");
const piState = await import("../../dist/executors/pi/state.js");
const api = await import("../../dist/hosts/api.js");

const DAY = 86_400_000;
const OLD = Date.now() - 10 * DAY;
let root;
let counter = 0;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-state-ret-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function dir(name) {
	counter += 1;
	const path = join(root, `${name}-${counter}`);
	await mkdir(join(path, "attempts"), { recursive: true });
	return path;
}

async function put(path, content, atMs = OLD) {
	if (content === null) await mkdir(path, { recursive: true });
	else await writeFile(path, content);
	await utimes(path, new Date(atMs), new Date(atMs));
}

function codexRecord(base, phase, extra = {}) {
	return JSON.stringify({
		schema: "agent-workflow-codex-attempt-v1",
		attemptKey: `k-${base}`,
		phase,
		updatedAt: OLD,
		...extra,
	});
}

test("codex: old terminal attempts go with their event log and log dir; active, recent and unreadable stay", async () => {
	const stateDir = await dir("codex");
	const a = join(stateDir, "attempts");
	await put(join(a, "done.json"), codexRecord("done", "terminal"));
	await put(join(a, "done.events.jsonl"), "{}\n");
	await put(join(a, "done.log"), null);
	await put(join(a, "rev.json"), codexRecord("rev", "revoked"));
	await put(
		join(a, "live.json"),
		codexRecord("live", "spawned", { pid: process.pid }),
	);
	await put(join(a, "live.log"), null);
	await put(join(a, "consumed.json"), codexRecord("consumed", "consumed"));
	await put(
		join(a, "recent.json"),
		codexRecord("recent", "terminal", { updatedAt: Date.now() }),
		Date.now(),
	);
	await put(join(a, "broken.json"), "{not json");
	// WP19 round 7: orphans are only adapter-written names (hex attemptKey digest + suffix).
	await put(join(a, `${"e".repeat(32)}.log`), null);
	await put(join(a, `${"9".repeat(32)}.log`), null, Date.now());
	await put(join(a, `${"f".repeat(32)}.json.123.abcd.tmp`), "{}");
	// Not adapter-written: never removed, even when old.
	await put(join(a, "orphan.log"), null);

	const classify = codexState.classifyCodexAttemptRecord;
	const dry = await retention.pruneAdapterAttemptState({
		stateDir,
		classify,
		attemptDigestLength: 32,
		dryRun: true,
	});
	assert.equal(dry.prunedRecords, 2);
	assert.ok(existsSync(join(a, "done.json")), "dry run removes nothing");

	const done = await retention.pruneAdapterAttemptState({
		stateDir,
		classify,
		attemptDigestLength: 32,
	});
	assert.equal(done.records, 6);
	assert.equal(done.prunedRecords, 2);
	assert.equal(done.keptActive, 3);
	// WP19: the launched (terminal) attempt stays as a tombstone; the revoked one goes.
	assert.equal(done.tombstoned, 1);
	assert.deepEqual((await readdir(a)).sort(), [
		`${"9".repeat(32)}.log`,
		"broken.json",
		"consumed.json",
		"done.json",
		"live.json",
		"live.log",
		"orphan.log",
		"recent.json",
	]);
	assert.equal(
		JSON.parse(await readFile(join(a, "done.json"), "utf8")).schema,
		"agent-workflow-attempt-tombstone-v1",
	);
});

test("claude: revoked and dead-process attempts go with their files dir; pi: only its own runs/ dir goes", async () => {
	const claudeDir = await dir("claude");
	const ca = join(claudeDir, "attempts");
	const claude = (phase, pid) =>
		JSON.stringify({
			schema: "agent-workflow-claude-attempt-v1",
			attemptKey: "k",
			phase,
			sessionId: null,
			keepSession: false,
			pid,
			updatedAt: new Date(OLD).toISOString(),
		});
	await put(join(ca, "gone.json"), claude("spawned", null));
	await put(join(ca, "gone"), null);
	await put(join(ca, "rev.json"), claude("revoked"));
	await put(join(ca, "running.json"), claude("spawned", process.pid));
	await put(join(ca, "consumed.json"), claude("consumed"));
	const c = await retention.pruneAdapterAttemptState({
		stateDir: claudeDir,
		classify: claudeState.classifyClaudeAttemptRecord,
		attemptDigestLength: 40,
	});
	assert.equal(c.prunedRecords, 2);
	assert.deepEqual((await readdir(ca)).sort(), [
		"consumed.json",
		"gone.json",
		"running.json",
	]);

	const piDir = await dir("pi");
	const pa = join(piDir, "attempts");
	const own = join(piDir, "runs", "own");
	const foreign = join(root, `artifacts-${counter}`);
	await put(own, null);
	await put(foreign, null);
	const pi = (phase, runDir) =>
		JSON.stringify({
			schema: "agent-workflow-pi-attempt-v1",
			attemptKey: "k",
			phase,
			runDir,
			updatedAt: new Date(OLD).toISOString(),
		});
	await put(join(pa, "own.json"), pi("exited", own));
	await put(join(pa, "foreign.json"), pi("exited", foreign));
	await put(join(pa, "pending.json"), pi("pending", own));
	const p = await retention.pruneAdapterAttemptState({
		stateDir: piDir,
		classify: (record) => piState.classifyPiAttemptRecord(piDir, record),
		attemptDigestLength: 64,
	});
	assert.equal(p.prunedRecords, 2);
	assert.deepEqual((await readdir(pa)).sort(), [
		"foreign.json",
		"own.json",
		"pending.json",
	]);
	assert.equal(existsSync(own), false, "the adapter's own run dir goes");
	assert.equal(
		existsSync(foreign),
		true,
		"a runtime artifactsDir is never touched",
	);
});

test("prune action: dry run lists executor state, --yes removes it under AGENT_WORKFLOW_HOME", async () => {
	const home = await dir("home");
	const cwd = await dir("project");
	const codexDir = join(home, "executors", "codex");
	await mkdir(join(codexDir, "attempts"), { recursive: true });
	await put(
		join(codexDir, "attempts", "old.json"),
		codexRecord("old", "terminal"),
	);
	await put(join(codexDir, "attempts", "old.events.jsonl"), "");
	await put(
		join(codexDir, "attempts", "active.json"),
		codexRecord("active", "consumed"),
	);
	const ctx = { cwd, env: { ...process.env, AGENT_WORKFLOW_HOME: home } };
	const dry = await api.pruneAction(ctx, {});
	const codex = dry.data.adapterState.find(
		(entry) => entry.executor === "codex",
	);
	assert.equal(codex.prunedRecords, 1);
	assert.equal(codex.dryRun, true);
	assert.match(dry.text, /codex: 1 of 2 record\(s\) would be removed/);
	assert.ok(existsSync(join(codexDir, "attempts", "old.json")));
	const done = await api.pruneAction(ctx, { yes: true });
	assert.match(done.text, /codex: 1 of 2 record\(s\) removed/);
	assert.match(done.text, /1 launched attempt\(s\) kept as tombstones/);
	assert.deepEqual((await readdir(join(codexDir, "attempts"))).sort(), [
		"active.json",
		"old.json",
	]);
});

test("periodic prune on submit: at most once per interval per state dir", async () => {
	const stateDir = await dir("periodic");
	const a = join(stateDir, "attempts");
	await put(join(a, "one.json"), codexRecord("one", "terminal"));
	const classify = codexState.classifyCodexAttemptRecord;
	retention.schedulePeriodicAdapterStatePrune({
		stateDir,
		classify,
		attemptDigestLength: 32,
	});
	const tombstoned = async (name) =>
		JSON.parse(await readFile(join(a, name), "utf8")).schema ===
		"agent-workflow-attempt-tombstone-v1";
	for (let i = 0; i < 100 && !(await tombstoned("one.json")); i += 1)
		await new Promise((done) => setTimeout(done, 20));
	assert.equal(await tombstoned("one.json"), true);
	assert.ok(existsSync(join(stateDir, ".prune-stamp")));
	await put(join(a, "two.json"), codexRecord("two", "terminal"));
	retention.schedulePeriodicAdapterStatePrune({
		stateDir,
		classify,
		attemptDigestLength: 32,
	});
	await new Promise((done) => setTimeout(done, 200));
	assert.equal(
		await tombstoned("two.json"),
		false,
		"within the interval nothing is pruned",
	);
});
