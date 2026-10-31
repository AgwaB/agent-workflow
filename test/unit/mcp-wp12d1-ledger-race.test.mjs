// New in agent-workflow (WP12d-1, stage-1 review #8): the MCP server's read-ledger write cannot be
// redirected outside the run directory by swapping the ledger (hard link) or one of its directories
// (symlink) between the server's path check and the open. The swaps are injected in-process by
// wrapping `node:fs/promises` `open`/`mkdir` (syncBuiltinESMExports), at the exact point the
// review's reproduction used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createArtifactToolService } from "../../dist/mcp/artifact-server/service.js";
import { createRunFixture } from "../fixtures/mcp/helpers.mjs";

const READ = { action: "read", source: "producer", artifact: "analysis" };

/** Run `swap` once, right before the first `fs.promises[name]` call on `path`. */
function interceptOnce(name, path, swap) {
	const original = fs[name];
	let fired = false;
	fs[name] = async (target, ...rest) => {
		if (!fired && resolve(String(target)) === resolve(path)) {
			fired = true;
			await swap();
		}
		return original(target, ...rest);
	};
	syncBuiltinESMExports();
	return {
		get fired() {
			return fired;
		},
		restore() {
			fs[name] = original;
			syncBuiltinESMExports();
		},
	};
}

async function setup(t) {
	const fixture = await createRunFixture();
	const outside = await fs.mkdtemp(join(fixture.cwd, "..", "aw-mcp-race-out-"));
	t.after(() =>
		fs.rm(fixture.cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	t.after(() =>
		fs.rm(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		}),
	);
	const service = await createArtifactToolService({
		configPath: fixture.configPath,
	});
	t.after(() => service.close());
	return { fixture, outside, service };
}

async function readIfPresent(path) {
	try {
		return await fs.readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

test("a ledger replaced by a hard link right before the open is not written", async (t) => {
	const { fixture, outside, service } = await setup(t);
	const target = join(outside, "evidence.jsonl");
	await fs.writeFile(target, "");
	await fs.writeFile(fixture.ledgerPath, "");
	const hook = interceptOnce("open", fixture.ledgerPath, async () => {
		await fs.rm(fixture.ledgerPath);
		await fs.link(target, fixture.ledgerPath);
	});
	let result;
	try {
		result = await service.call(READ);
	} finally {
		hook.restore();
	}
	assert.equal(hook.fired, true);
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.match(result.content[0].text, /hard-linked/);
	assert.equal(await fs.readFile(target, "utf8"), "");
});

test("a ledger directory replaced by a symlink right before the open is not written", async (t) => {
	const { fixture, outside, service } = await setup(t);
	const outsideTask = join(outside, "task");
	await fs.mkdir(outsideTask);
	const hook = interceptOnce("open", fixture.ledgerPath, async () => {
		await fs.rename(fixture.taskDir, `${fixture.taskDir}.moved`);
		await fs.symlink(outsideTask, fixture.taskDir);
	});
	let result;
	try {
		result = await service.call(READ);
	} finally {
		hook.restore();
	}
	assert.equal(hook.fired, true);
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.equal(
		(await readIfPresent(join(outsideTask, "read-ledger.jsonl"))) ?? "",
		"",
	);
});

test("an ancestor directory replaced by a symlink after the server's check is not written", async (t) => {
	const { fixture, outside, service } = await setup(t);
	const tasksDir = join(fixture.runDir, "tasks");
	const outsideTasks = join(outside, "tasks");
	const outsideTask = join(outsideTasks, fixture.config.taskId);
	await fs.mkdir(outsideTask, { recursive: true });
	// The swap lands between the server's containment check and the ledger open: at the
	// `mkdir` of the ledger directory that precedes the open.
	const hook = interceptOnce("mkdir", fixture.taskDir, async () => {
		await fs.rename(tasksDir, `${tasksDir}.moved`);
		await fs.symlink(outsideTasks, tasksDir);
	});
	let result;
	try {
		result = await service.call(READ);
	} finally {
		hook.restore();
	}
	assert.equal(hook.fired, true);
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.match(result.content[0].text, /inside the workflow run directory/);
	assert.equal(
		(await readIfPresent(join(outsideTask, "read-ledger.jsonl"))) ?? "",
		"",
	);
});

test("without interference the row reaches the real ledger", async (t) => {
	const { fixture, service } = await setup(t);
	const result = await service.call(READ);
	assert.equal(result.isError, false);
	const rows = (await fs.readFile(fixture.ledgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "producer");
	assert.equal(rows[0].artifact, "analysis");
	assert.equal((await fs.stat(fixture.ledgerPath)).mode & 0o777, 0o600);
});
