// test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DashboardCalculations } from "../../dist/hosts/dashboard/calculations.js";
import { managementProject } from "../helpers/dashboard-management.mjs";

test("cold calculation returns pending without awaiting a probe and preserves refusal", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const jobs = new DashboardCalculations(() => 0);
	const pending = jobs.start(async () => {
		await gate;
		return {
			check: {
				ok: false,
				data: { refusal: { code: "CAPABILITY_UNSUPPORTED" } },
			},
		};
	});
	assert.equal(pending.status, 202);
	assert.equal(jobs.read(pending.value.calculationId).status, 202);
	release();
	await gate;
	await new Promise(setImmediate);
	const completed = jobs.read(pending.value.calculationId);
	assert.equal(completed.status, 200);
	assert.equal(completed.value.check.ok, false);
	assert.equal(
		completed.value.check.data.refusal.code,
		"CAPABILITY_UNSUPPORTED",
	);
});

test("calculation errors and capacity are explicit, expired results are never fresh", async () => {
	let now = 0;
	const jobs = new DashboardCalculations(() => now);
	const failed = jobs.start(async () => {
		throw Object.assign(new Error("definition changed"), { status: 409 });
	});
	await new Promise(setImmediate);
	assert.deepEqual(jobs.read(failed.value.calculationId), {
		status: 409,
		value: { error: "definition changed" },
	});
	now = 60_001;
	assert.equal(jobs.read(failed.value.calculationId).status, 404);
	for (let i = 0; i < 8; i++) jobs.start(() => new Promise(() => {}));
	assert.throws(() => jobs.start(async () => ({})), /queue is full/);
});

test("HTTP editor detail is lean without changing legacy callers; async preview never claims pending is a pass", async (t) => {
	const p = await managementProject(t);
	const catalog = (await p.http(`${p.base}/workflows`)).data.data.workflows;
	const entry = catalog.find((entry) => entry.name === "manage");
	const route = `${p.base}/workflows/${entry.workflowKey}`;
	const full = await p.http(route);
	const lean = await p.http(`${route}?view=editor`);
	assert.equal(full.status, 200);
	assert.equal(lean.status, 200);
	assert.ok(full.data.spec.data.spec.includes("Read facts."));
	assert.ok(full.data.roles);
	assert.equal(Object.hasOwn(lean.data, "spec"), false);
	assert.equal(Object.hasOwn(lean.data, "roles"), false);
	assert.deepEqual(lean.data.graph, full.data.graph);
	assert.deepEqual(lean.data.validation, full.data.validation);
	const settings = (await p.http(`${route}/settings`)).data.settings;
	const { storeEpoch, revision, definitionFingerprint, resolutionToken } =
		settings;
	const body = {
		intent: {},
		expected: { storeEpoch, revision, definitionFingerprint, resolutionToken },
	};
	const receipt = await p.http(`${route}/settings/preview`, {
		method: "POST",
		body,
		headers: { Prefer: "respond-async" },
	});
	assert.equal(receipt.status, 202);
	assert.equal(receipt.data.pending, true);
	assert.equal(Object.hasOwn(receipt.data, "check"), false);
	let reply = receipt;
	for (let i = 0; i < 200 && reply.status === 202; i++)
		reply = await p.http(receipt.data.poll);
	assert.equal(reply.status, 200);
	assert.ok(reply.data.check.data.configuration);
	const legacy = await p.http(`${route}/settings/preview`, {
		method: "POST",
		body,
	});
	assert.equal(legacy.status, 200);
	assert.equal(reply.data.check.ok, legacy.data.check.ok);
	assert.deepEqual(
		reply.data.check.data.refusal,
		legacy.data.check.data.refusal,
	);
});

test("warmExecutorProbes probes executors once in the background; off by default", async (t) => {
	const { managementProject } = await import(
		"../helpers/dashboard-management.mjs"
	);
	const cold = await managementProject(t);
	// The warm-up is scheduled on a timer; give the off case the same turns the on case needs.
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(
		await cold.probeCount(),
		0,
		"no probe without warmExecutorProbes",
	);
	const warm = await managementProject(t, { warmExecutorProbes: true });
	const until = Date.now() + 10_000;
	while ((await warm.probeCount()) === 0 && Date.now() < until)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(
		(await warm.probeCount()) > 0,
		"warm-up probed without any request",
	);
});
