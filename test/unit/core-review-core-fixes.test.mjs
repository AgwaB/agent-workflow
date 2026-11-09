// test-tier: integration
import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	validateJsonSchema,
	validateJsonSchemaSubset,
} from "../../dist/core/json-schema.js";
import { createAgentWorkflowPiExtension } from "../../dist/hosts/pi/extension.js";
import * as usage from "../../dist/core/workflow-parent-usage.js";
import * as store from "../../dist/core/store.js";

async function project(t) {
	const cwd = await mkdtemp(join(tmpdir(), "review-core-"));
	t.after(async () => {
		usage.resetParentUsageTrackingForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	return cwd;
}
async function setupUsage(t) {
	const cwd = await project(t),
		runId = "workflow_retry",
		owner = "owner";
	await mkdir(join(stateDir(cwd), ".agent-workflow/workflows"), {
		recursive: true,
	});
	await writeFile(
		join(stateDir(cwd), ".agent-workflow/workflows/index.json"),
		JSON.stringify({ schemaVersion: 1, runs: [{ runId, status: "running" }] }),
	);
	usage.beginParentUsageTracking(cwd, runId, owner);
	await usage.flushParentUsageTracking(cwd, owner);
	return { cwd, runId, owner };
}
const message = (n) => ({
	role: "assistant",
	timestamp: n,
	content: [{ type: "text", text: "PRIVATE RAW MESSAGE" }],
	usage: { totalTokens: n },
});

test("IR1-03 real lease timeout retains delta, flush retries, later messages and process replay count once", async (t) => {
	const { cwd, runId, owner } = await setupUsage(t);
	const lease = await store.acquireRunFileLease(cwd, runId, "parent-usage", 0);
	assert.ok(lease);
	const start = Date.now();
	try {
		await assert.rejects(
			usage.recordParentSessionUsage(cwd, message(10), owner),
			/busy/,
		);
	} finally {
		await lease.release();
	}
	assert.ok(Date.now() - start >= 4900);
	await usage.flushParentUsageTracking(cwd, owner);
	await usage.recordParentSessionUsage(cwd, message(20), owner);
	usage.resetParentUsageTrackingForTests();
	await usage.resumeParentUsageTracking(cwd, owner);
	await usage.recordParentSessionUsage(cwd, message(10), owner);
	await usage.recordParentSessionUsage(cwd, message(20), owner);
	const record = await usage.readParentUsage(cwd, runId);
	assert.equal(record.totalTokens, 30);
	assert.equal(record.assistantMessages, 2);
	assert.equal(record.messageIds.length, 2);
	assert.equal(record.lastWriteFailure.code, "parent_usage_write_failed");
	assert.ok(record.lastWriteFailure.at);
	assert.doesNotMatch(JSON.stringify(record), /PRIVATE RAW MESSAGE/);
});

test("IR1-03 ambiguous post-commit failure retries with durable receipt, including messages without timestamp", async (t) => {
	const { cwd, runId, owner } = await setupUsage(t);
	const original = fs.rename;
	let fail = true;
	t.mock.method(fs, "rename", async (...args) => {
		await original(...args);
		if (fail && String(args[1]).endsWith("parent-usage.json")) {
			fail = false;
			throw new Error("injected post-commit failure");
		}
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const msg = message(7);
	delete msg.timestamp;
	await assert.rejects(
		usage.recordParentSessionUsage(cwd, msg, owner),
		/post-commit/,
	);
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 7);
	fail = true;
	await assert.rejects(
		usage.flushParentUsageTracking(cwd, owner, true),
		/post-commit/,
	);
	await usage.flushParentUsageTracking(cwd, owner, true);
	const record = await usage.readParentUsage(cwd, runId);
	assert.equal(record.totalTokens, 7);
	assert.equal(record.assistantMessages, 1);
	assert.equal(record.messageIds.length, 1);
	assert.ok(record.lastWriteFailure);
});

test("IR1-03 fencing is rechecked immediately before atomic rename; queued usage survives lease loss", async (t) => {
	const { cwd, runId, owner } = await setupUsage(t);
	let stolen = false;
	store.setRunLeaseTestHooksForTests({
		onBeforeAtomicRename: async ({ file }) => {
			if (file.endsWith("parent-usage.json") && !stolen) {
				stolen = true;
				const files = await fs.readdir(store.workflowRunDir(cwd, runId));
				const lock = files.find(
					(name) =>
						name.includes("parent-usage") && name !== "parent-usage.json",
				);
				assert.ok(lock, files.join(","));
				// Replace the named lease token after the writer's first ownership assertion.
				const path = join(store.workflowRunDir(cwd, runId), lock);
				await writeFile(path, "foreign-token\n");
			}
		},
	});
	t.after(() => store.setRunLeaseTestHooksForTests({}));
	await assert.rejects(
		usage.recordParentSessionUsage(cwd, message(9), owner),
		/lease|owner/i,
	);
	assert.equal(
		(await usage.readParentUsage(cwd, runId)).totalTokens,
		undefined,
	);
	store.setRunLeaseTestHooksForTests({});
	// Remove the synthetic foreign lease only; no real process owns this fixture.
	for (const name of await fs.readdir(store.workflowRunDir(cwd, runId)))
		if (name.includes("parent-usage") && name !== "parent-usage.json")
			await rm(join(store.workflowRunDir(cwd, runId), name), { force: true });
	await usage.flushParentUsageTracking(cwd, owner, true);
	assert.equal((await usage.readParentUsage(cwd, runId)).totalTokens, 9);
});

test("IR1-03 message_end surfaces sanitized deferral and the next turn recovers both deltas", async (t) => {
	const { cwd, runId, owner } = await setupUsage(t);
	const handlers = {},
		notices = [];
	createAgentWorkflowPiExtension({
		env: { ...process.env, AGENT_WORKFLOW_ROLE: "supervisor" },
	})({
		on(name, handler) {
			handlers[name] = handler;
		},
		registerTool() {},
		registerCommand() {},
	});
	const ctx = {
		cwd,
		hasUI: true,
		mode: "rpc",
		sessionManager: { getSessionId: () => owner },
		ui: { notify: (text, level) => notices.push({ text, level }) },
	};
	const original = fs.rename;
	let fail = true;
	t.mock.method(fs, "rename", async (...args) => {
		if (fail && String(args[1]).endsWith("parent-usage.json")) {
			fail = false;
			throw new Error("PRIVATE RAW MESSAGE");
		}
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await handlers.message_end({ message: message(3) }, ctx);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].text, /deferred.*retry/);
	assert.doesNotMatch(notices[0].text, /PRIVATE/);
	assert.equal((await usage.readParentUsage(cwd, runId)).assistantMessages, 0);
	fail = true;
	await assert.rejects(
		usage.flushParentUsageTracking(cwd, owner, true),
		/PRIVATE/,
	);
	assert.equal((await usage.readParentUsage(cwd, runId)).assistantMessages, 0);
	await writeFile(
		join(stateDir(cwd), ".agent-workflow/workflows/index.json"),
		JSON.stringify({
			schemaVersion: 1,
			runs: [{ runId, status: "completed" }],
		}),
	);
	await handlers.message_end({ message: message(4) }, ctx);
	const record = await usage.readParentUsage(cwd, runId);
	assert.equal(record.totalTokens, 7);
	assert.equal(record.assistantMessages, 2);
	assert.ok(record.lastWriteFailure);
	assert.ok(record.completedAt);
});

test("IR1-04 schema nodes ignore polluted keywords and reject custom prototypes", () => {
	assert.equal(
		validateJsonSchemaSubset(Object.create({ type: "boolen" })).valid,
		false,
	);
	const pollution = {
		type: "string",
		enum: ["bad"],
		const: "bad",
		required: ["missing"],
		items: [false],
		properties: { x: false },
		additionalProperties: false,
		minItems: 99,
		maxItems: 0,
		minLength: 99,
		maxLength: 0,
		minimum: 99,
		maximum: 0,
		allOf: [false],
		anyOf: [false],
		oneOf: [false],
		pattern: ".",
	};
	const before = Object.getOwnPropertyDescriptors(Object.prototype);
	try {
		for (const [key, value] of Object.entries(pollution))
			Object.defineProperty(Object.prototype, key, {
				value,
				configurable: true,
				writable: true,
			});
		for (const value of [42, "ok", [], [1], {}, { x: 1 }, null, true])
			assert.equal(
				validateJsonSchema(value, {}).valid,
				true,
				JSON.stringify(value),
			);
		assert.equal(validateJsonSchemaSubset({}).valid, true);
	} finally {
		for (const key of Object.keys(pollution)) {
			if (Object.hasOwn(before, key))
				Object.defineProperty(Object.prototype, key, before[key]);
			else delete Object.prototype[key];
		}
	}
	const own = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
	assert.equal(
		validateJsonSchema(JSON.parse('{"a":1,"__proto__":{"polluted":true}}'), {
			const: own,
		}).valid,
		true,
	);
	assert.equal(
		validateJsonSchema(
			{ a: 1 },
			{ const: Object.assign(Object.create(null), { a: 1 }) },
		).valid,
		true,
	);
	assert.equal(
		validateJsonSchema(
			1,
			Object.assign(Object.create(null), { type: "integer" }),
		).valid,
		true,
	);
	assert.equal(
		validateJsonSchema(
			42,
			Object.defineProperty({}, "type", { value: "string" }),
		).valid,
		false,
	);
	assert.equal(
		validateJsonSchemaSubset(
			Object.defineProperty({}, "type", { value: "boolen" }),
		).valid,
		false,
	);
	assert.equal(
		validateJsonSchema(own, {
			properties: JSON.parse('{"__proto__":{"type":"object"}}'),
			required: ["__proto__"],
		}).valid,
		true,
	);
	assert.equal({}.polluted, undefined);
});

test("IR1-05 enum fingerprints retain strict JSON equality and scale to 16000 unique members", (t) => {
	const schema = {
		enum: Array.from({ length: 16000 }, (_, i) => `value-${i}`),
	};
	validateJsonSchemaSubset({ enum: ["a", "b"] });
	const smallStart = performance.now();
	assert.equal(
		validateJsonSchemaSubset({ enum: schema.enum.slice(0, 4000) }).valid,
		true,
	);
	const smallMs = performance.now() - smallStart;
	const start = performance.now();
	assert.equal(validateJsonSchemaSubset(schema).valid, true);
	const ms = performance.now() - start;
	t.diagnostic(
		JSON.stringify({
			smallMembers: 4000,
			smallMs,
			scale: ms / Math.max(smallMs, 0.001),
		}),
	);
	t.diagnostic(
		JSON.stringify({
			members: 16000,
			bytes: Buffer.byteLength(JSON.stringify(schema)),
			ms,
		}),
	);
	// 2026-11-10: the regression is counted, not timed (was "< 500 ms"): pairwise comparison reads the members
	// n²/2 times, fingerprinting reads each a few times.
	let reads = 0;
	const counted = new Proxy(schema.enum, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	assert.equal(validateJsonSchemaSubset({ enum: counted }).valid, true);
	t.diagnostic(JSON.stringify({ members: 16000, reads }));
	assert.ok(reads <= 16000 * 8, `${reads} member reads (quadratic regression)`);
	for (const values of [
		[
			{ a: 1, b: 2 },
			{ b: 2, a: 1 },
		],
		[0, -0],
		[JSON.parse('{"__proto__":1}'), JSON.parse('{"__proto__":1}')],
	])
		assert.equal(validateJsonSchemaSubset({ enum: values }).valid, false);
	assert.equal(
		validateJsonSchemaSubset({
			enum: [0, "0", false, null, [], {}, [1, 2], [2, 1], { a: 1 }, { a: "1" }],
		}).valid,
		true,
	);
	for (const value of [undefined, NaN, Infinity, () => {}, new Date()])
		assert.equal(validateJsonSchemaSubset({ enum: [value] }).valid, false);
});
