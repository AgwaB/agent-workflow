import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../dist/sdk/index.js";
import {
	collectEvents,
	createFakeExecutor,
	createFakeStore,
	createTracedAuthorityGate,
	FakeCrashError,
	fakeSubmitRequest,
	verifyFencing,
} from "../../dist/sdk/testing/index.js";

test("authority gate: single decision, one-time consume", async () => {
	const gate = sdk.createAuthorityGate({ attemptKey: "k", grantId: "g" });
	assert.equal(gate.state(), "pending");
	assert.deepEqual(await gate.authority.consume(), { kind: "released", attemptKey: "k", grantId: "g" });
	await assert.rejects(gate.authority.consume(), (error) => sdk.isSdkError(error, "AUTHORITY_ALREADY_CONSUMED"));
	assert.equal(gate.revoke("stop"), "too_late");
	assert.equal(gate.state(), "released");

	const revoked = sdk.createAuthorityGate({ attemptKey: "r" });
	assert.equal(revoked.revoke("lease lost"), "revoked");
	assert.deepEqual(await revoked.authority.consume(), { kind: "revoked", attemptKey: "r", reason: "lease lost" });
	assert.throws(() => sdk.requireReleased({ kind: "revoked", attemptKey: "r", reason: "x" }), (error) => sdk.isSdkError(error, "AUTHORITY_REVOKED"));
	assert.throws(() => sdk.createAuthorityGate({ attemptKey: "" }), (error) => sdk.isSdkError(error, "INVALID_REQUEST"));
});

test("fencing 1/3: stop before consume → no effect, reconcile absent", async () => {
	const store = createFakeStore();
	const executor = createFakeExecutor({ store });
	const gate = createTracedAuthorityGate(store, "stop-first");
	gate.revoke("user stop");
	await assert.rejects(executor.submit(fakeSubmitRequest(gate)), (error) => sdk.isSdkError(error, "AUTHORITY_REVOKED"));
	assert.equal(executor.effectCount("stop-first"), 0);
	assert.deepEqual(await executor.reconcile("stop-first"), { absent: true });
	await assert.rejects(executor.submit(fakeSubmitRequest(gate)), (error) => sdk.isSdkError(error, "AUTHORITY_REVOKED"));
	assert.deepEqual(verifyFencing(store.trace), []);
});

test("fencing 2/3: crash after consume → reconcile unknown, restart never launches again", async () => {
	const store = createFakeStore();
	const crashing = createFakeExecutor({ store, faults: { crashAfterConsume: true } });
	const gate = createTracedAuthorityGate(store, "crash");
	await assert.rejects(crashing.submit(fakeSubmitRequest(gate)), FakeCrashError);
	assert.equal(gate.revoke("stop"), "too_late", "consumed authority cannot be revoked");

	const restarted = createFakeExecutor({ store });
	const reconciled = await restarted.reconcile("crash");
	assert.ok(sdk.isReconcileUnknown(reconciled), "unknown → stop and ask, no automatic retry");
	await assert.rejects(restarted.submit(fakeSubmitRequest(gate)), (error) => sdk.isSdkError(error, "AUTHORITY_ALREADY_CONSUMED"));
	const freshGate = createTracedAuthorityGate(store, "crash");
	await assert.rejects(restarted.submit(fakeSubmitRequest(freshGate)), (error) => sdk.isSdkError(error, "AUTHORITY_ALREADY_CONSUMED"));
	assert.equal(restarted.effectCount("crash"), 0);
	assert.deepEqual(verifyFencing(store.trace), []);
});

test("fencing 3/3: spawn without consume is detected by verifyFencing", async () => {
	const store = createFakeStore();
	const buggy = createFakeExecutor({ store, faults: { skipConsume: true } });
	const ref = await buggy.submit(fakeSubmitRequest(createTracedAuthorityGate(store, "no-consume")));
	await collectEvents(buggy.observe(ref));
	assert.deepEqual(verifyFencing(store.trace), ["effect for no-consume without released authority"]);
	assert.deepEqual(verifyFencing([...store.trace, { type: "consume", attemptKey: "d", outcome: "released" }, { type: "effect", attemptKey: "d", executorId: "x" }, { type: "effect", attemptKey: "d", executorId: "x" }]).slice(1), [
		"duplicate effect for d",
	]);
});

test("submit is idempotent per attemptKey and survives a restart (found)", async () => {
	const store = createFakeStore();
	const executor = createFakeExecutor({ store });
	const gate = createTracedAuthorityGate(store, "idem");
	const request = fakeSubmitRequest(gate);
	const refs = await Promise.all([executor.submit(request), executor.submit(request)]);
	assert.deepEqual(refs[0], refs[1], "concurrent submits share one launch");
	const again = await executor.submit(request);
	assert.deepEqual(again, refs[0]);
	assert.equal(executor.effectCount("idem"), 1);
	const restarted = createFakeExecutor({ store });
	assert.deepEqual(await restarted.reconcile("idem"), { found: refs[0] });
	assert.deepEqual(await restarted.reconcile("never-seen"), { absent: true });
	const events = await collectEvents(restarted.observe(refs[0]));
	assert.deepEqual(sdk.validateEventSequence(events), []);
	assert.deepEqual(verifyFencing(store.trace), []);
});

test("observe yields a valid normalized stream; usage stays null-cost when unknown", async () => {
	const executor = createFakeExecutor();
	const ref = await executor.submit(fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: "obs" })));
	const events = await collectEvents(executor.observe(ref));
	assert.deepEqual(events.map((event) => event.type), ["started", "message_delta", "usage", "completed"]);
	assert.equal(events[2].cost, null);
	assert.deepEqual(await collectEvents(executor.observe(ref)), events, "observe is replayable");
	await assert.rejects(collectEvents(executor.observe({ ...ref, handle: "bogus" })), (error) => sdk.isSdkError(error, "UNKNOWN_EXEC_REF"));
	assert.throws(() => createFakeExecutor({ script: [{ type: "usage", input: 1, output: 1, cached: 0, cost: 0, source: "unknown" }] }), (error) =>
		sdk.isSdkError(error, "INVALID_EVENT"),
	);
});

const approvalScript = [
	{ type: "started", sessionId: null },
	{
		approval: { type: "approval_request", requestId: "req-1", kind: "execute", detail: "npm test" },
		ifAllowed: [{ type: "tool_call", name: "bash", kind: "execute", status: "completed" }, { type: "completed", finalText: "ran" }],
		ifDenied: [{ type: "tool_call", name: "bash", kind: "execute", status: "denied" }, { type: "completed", finalText: "skipped" }],
	},
];

async function runApproval(answer, policy) {
	const executor = createFakeExecutor({ script: approvalScript });
	const ref = await executor.submit(fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: `ap-${answer}` }), { approvalPolicy: policy }));
	const events = [];
	const results = [];
	for await (const event of executor.observe(ref)) {
		events.push(event);
		if (event.type === "approval_request" && answer !== "none") results.push(await executor.respond(ref, event.requestId, answer));
	}
	results.push(await executor.respond(ref, "req-1", "allow"), await executor.respond(ref, "other", "allow"));
	return { events, results };
}

test("approval channel: allow, deny, and fail-closed timeout", async () => {
	const allowed = await runApproval("allow", sdk.defaultApprovalPolicy());
	assert.equal(allowed.events.at(-1).finalText, "ran");
	assert.deepEqual(allowed.results, ["accepted", "too_late", "unknown_request"]);
	const denied = await runApproval("deny", sdk.defaultApprovalPolicy());
	assert.equal(denied.events.at(-2).status, "denied");
	const timedOut = await runApproval("none", sdk.defaultApprovalPolicy({ timeoutMs: 5 }));
	assert.equal(timedOut.events.at(-1).finalText, "skipped");
	assert.deepEqual(sdk.validateEventSequence(timedOut.events), []);
});

test("cancel results: cancelled, too_late, no_active, unsupported, forced", async () => {
	const slow = createFakeExecutor({ stepDelayMs: 20 });
	const ref = await slow.submit(fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: "c1" })));
	assert.equal(await slow.cancel(ref, "turn"), "cancelled");
	const events = await collectEvents(slow.observe(ref));
	assert.equal(events.at(-1).type, "failed", "the ACK is not termination evidence; the stream is");
	assert.equal(await slow.cancel(ref, "turn"), "too_late");
	assert.equal(await slow.cancel({ ...ref, attemptKey: "nope" }, "owned"), "no_active");

	const noCancel = createFakeExecutor({ capabilities: { cancel: { level: "none", source: "declared", detail: "kill" } }, stepDelayMs: 20 });
	const ref2 = await noCancel.submit(fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: "c2" })));
	assert.equal(await noCancel.cancel(ref2, "turn"), "unsupported");
	const desktopLike = createFakeExecutor({ cancelResult: "too_late" });
	const ref3 = await desktopLike.submit(fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: "c3" })));
	assert.equal(await desktopLike.cancel(ref3, "owned"), "too_late");
	await collectEvents(noCancel.observe(ref2));
	await collectEvents(desktopLike.observe(ref3));
});

test("probe reports readiness without model calls and capabilities validate", async () => {
	const executor = createFakeExecutor();
	assert.deepEqual(await executor.probe(), { installed: true, cliVersion: "fake-cli 1.0.0", auth: "ok" });
	sdk.assertCapabilities(executor.capabilities());
	await assert.rejects(
		executor.submit({ ...fakeSubmitRequest(sdk.createAuthorityGate({ attemptKey: "bad" })), cwd: "" }),
		(error) => sdk.isSdkError(error, "INVALID_REQUEST"),
	);
});
