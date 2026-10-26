// New in agent-workflow (WP4c-2): the core workflow_artifact tool must not follow a planted symlink
// (or hard link) at the read-ledger path. Before the fix the append followed the link, so evidence
// rows landed outside the workflow run directory. Also covers the ledger-row hook for the MCP server.
import assert from "node:assert/strict";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	appendWorkflowArtifactReadLedger,
	handleWorkflowArtifactToolCall,
	readWorkflowArtifactReadLedger,
} from "../../dist/core/workflow-artifact-tool.js";
import { artifactReadFixture } from "../helpers/workflow-artifact-fixture.mjs";

async function outsideDir(t) {
	const dir = await mkdtemp(join(tmpdir(), "aw-ledger-outside-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("a symlinked read ledger is refused and nothing is written outside the run", async (t) => {
	const fixture = await artifactReadFixture(t);
	const outside = join(await outsideDir(t), "victim.jsonl");
	writeFileSync(outside, "original\n");
	symlinkSync(outside, fixture.config.ledgerPath);

	await assert.rejects(fixture.read(), /read ledger must not be a symlink/);
	assert.equal(readFileSync(outside, "utf8"), "original\n");
	assert.equal(lstatSync(fixture.config.ledgerPath).isSymbolicLink(), true);
});

test("a dangling ledger symlink does not create its target outside the run", async (t) => {
	const fixture = await artifactReadFixture(t);
	const outside = join(await outsideDir(t), "created.jsonl");
	symlinkSync(outside, fixture.config.ledgerPath);

	await assert.rejects(fixture.read(), /read ledger must not be a symlink/);
	assert.equal(existsSync(outside), false);
});

test("a symlinked ledger directory is refused", async (t) => {
	const fixture = await artifactReadFixture(t);
	const outside = await outsideDir(t);
	const linkedDir = join(fixture.consumer, "linked");
	symlinkSync(outside, linkedDir);
	await assert.rejects(
		handleWorkflowArtifactToolCall(
			{ action: "read", source: "producer", artifact: "control" },
			{ ...fixture.config, ledgerPath: join(linkedDir, "read-ledger.jsonl") },
		),
		/read ledger directory must not be a symlink/,
	);
	assert.equal(existsSync(join(outside, "read-ledger.jsonl")), false);
});

test("a hard-linked or non-regular ledger is refused", async (t) => {
	const fixture = await artifactReadFixture(t);
	const outside = join(await outsideDir(t), "victim.jsonl");
	writeFileSync(outside, "original\n");
	try {
		linkSync(outside, fixture.config.ledgerPath);
	} catch (error) {
		// Cross-device tmp dirs cannot hard-link; the symlink cases above still apply.
		if (error.code === "EXDEV") return t.skip("tmpdir spans devices");
		throw error;
	}
	await assert.rejects(fixture.read(), /read ledger must not be hard-linked/);
	assert.equal(readFileSync(outside, "utf8"), "original\n");

	const dirFixture = await artifactReadFixture(t);
	mkdirSync(dirFixture.config.ledgerPath);
	await assert.rejects(dirFixture.read(), /read ledger is not a regular file/);
});

test("a symlinked ledger is not read as evidence", async (t) => {
	const fixture = await artifactReadFixture(t);
	await fixture.read();
	const outside = join(await outsideDir(t), "forged.jsonl");
	writeFileSync(outside, readFileSync(fixture.config.ledgerPath));
	const linked = join(fixture.consumer, "linked-ledger.jsonl");
	symlinkSync(outside, linked);
	await assert.rejects(
		readWorkflowArtifactReadLedger(linked),
		/read ledger must not be a symlink/,
	);
	assert.equal(
		(await readWorkflowArtifactReadLedger(fixture.config.ledgerPath)).length,
		1,
	);
});

test("regular ledgers still append one complete row per call", async (t) => {
	const fixture = await artifactReadFixture(t);
	await Promise.all([fixture.read(), fixture.read(), fixture.read()]);
	const rows = await readWorkflowArtifactReadLedger(fixture.config.ledgerPath);
	assert.equal(rows.length, 3);
	assert.equal(lstatSync(fixture.config.ledgerPath).mode & 0o777, 0o600);
	await appendWorkflowArtifactReadLedger(fixture.config.ledgerPath, rows[0]);
	assert.equal(
		(await readWorkflowArtifactReadLedger(fixture.config.ledgerPath)).length,
		4,
	);
});

test("the tool call emits the ledger row it wrote (MCP hook)", async (t) => {
	const fixture = await artifactReadFixture(t);
	const emitted = [];
	const result = await handleWorkflowArtifactToolCall(
		{ action: "read", source: "producer", artifact: "control" },
		fixture.config,
		{ onLedgerRecord: (record) => emitted.push(record) },
	);
	const rows = await readWorkflowArtifactReadLedger(fixture.config.ledgerPath);
	assert.deepEqual(emitted, rows);
	assert.equal(rows.length, 1);
	assert.deepEqual(Object.keys(result).sort(), ["content", "details"]);
});

test("appendLedger: false emits the row without writing it", async (t) => {
	const fixture = await artifactReadFixture(t);
	const emitted = [];
	const hook = {
		appendLedger: false,
		onLedgerRecord: (record) => emitted.push(record),
	};
	await handleWorkflowArtifactToolCall(
		{ action: "read", source: "producer", artifact: "control" },
		fixture.config,
		hook,
	);
	assert.equal(existsSync(fixture.config.ledgerPath), false);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].source, "producer");
	assert.equal(emitted[0].artifact, "control");
	await handleWorkflowArtifactToolCall(
		{ action: "list" },
		fixture.config,
		hook,
	);
	assert.equal(emitted.length, 1);
});
