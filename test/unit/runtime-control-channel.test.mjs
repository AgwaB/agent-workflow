// New in agent-workflow (WP2b): the durable control channel — a file mailbox in
// <attemptDir>/control/ served by the process that executes the attempt (here: real detached
// durable workers running the fake executor fixture). Approvals allow/deny/timeout with the
// audit of who decided; an answer from a fresh process after the launching process exited;
// cancel turn vs owned; duplicate / out-of-order / unknown / invalid requests; requests after
// terminal; the SIGTERM fallback when the worker does not ack.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	listPendingApprovals,
	readApprovalAudit,
	readRunEvents,
	requestCancel,
	respondApproval,
	runSubagent,
	waitForSubagent,
} from "../../dist/runtime/index.js";
import {
	fixtureDescriptor,
	readEffectLog,
} from "../fixtures/runtime/fake-executor-module.mjs";

const runtimeUrl = new URL("../../dist/runtime/index.js", import.meta.url).href;
let root;
let counter = 0;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "aw-control-"));
	process.env.AGENT_WORKFLOW_RUN_INDEX_DIR = join(root, "run-index");
	process.env.AGENT_WORKFLOW_HEARTBEAT_MS = "50";
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

function fresh(label) {
	counter += 1;
	return {
		cwd: join(root, `${label}-${counter}`),
		effectLog: join(root, `${label}-${counter}.effects.jsonl`),
	};
}

function attemptDir(cwd, run) {
	return join(
		cwd,
		".agent-workflow/runs",
		run.runId,
		"attempts",
		run.attemptId,
	);
}

const APPROVAL_SCRIPT = [
	{ type: "started", sessionId: "control-session" },
	{
		approval: {
			type: "approval_request",
			requestId: "exec-1",
			kind: "execute",
			detail: "run the tests",
		},
		ifAllowed: [
			{ type: "tool_call", name: "bash", kind: "execute", status: "completed" },
			{ type: "completed", finalText: "allowed" },
		],
		ifDenied: [{ type: "completed", finalText: "denied" }],
	},
];

const SLOW_SCRIPT = [
	{ type: "started", sessionId: null },
	...Array.from({ length: 40 }, (_, index) => ({
		type: "message_delta",
		text: `${index} `,
	})),
	{ type: "completed", finalText: "slow done" },
];

async function waitFor(predicate, timeoutMs = 20_000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`${label} not reached`);
}

async function waitTerminal(cwd, run) {
	const waited = await waitForSubagent({
		cwd,
		runId: run.runId,
		attemptId: run.attemptId,
		timeoutMs: 30_000,
		pollIntervalMs: 25,
	});
	assert.equal(waited.status, "completed", JSON.stringify(waited));
	// The finalizer publishes after the registry commit; wait so fixture cleanup never races it.
	await waitFor(
		async () =>
			(await readRunEvents({ cwd, runId: run.runId }, Infinity)).some(
				(event) => event.type === `run.${waited.snapshot.status}`,
			),
		30_000,
		"terminal run event",
	);
	return waited.snapshot;
}

async function result(cwd, run) {
	return JSON.parse(
		await readFile(join(attemptDir(cwd, run), "result.json"), "utf8"),
	);
}

async function startApprovalRun(label, policy) {
	const { cwd, effectLog } = fresh(label);
	await mkdir(cwd, { recursive: true });
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({ effectLog, script: APPROVAL_SCRIPT }),
		task: "needs approval",
		async: true,
		approvalPolicy: policy,
	});
	return {
		cwd,
		effectLog,
		run,
		ref: { cwd, runId: run.runId, attemptId: run.attemptId },
	};
}

for (const decision of ["allow", "deny"]) {
	test(`approval ${decision} answered through the mailbox by a host → applied, acked, audited (by host)`, async () => {
		const { cwd, run, ref } = await startApprovalRun(`approval-${decision}`, {
			interactive: true,
			timeoutMs: 20_000,
		});
		const pending = await waitFor(async () => {
			const list = await listPendingApprovals(ref);
			return list.length > 0 ? list : undefined;
		});
		assert.equal(pending.length, 1);
		assert.equal(pending[0].requestId, "exec-1");
		assert.equal(pending[0].kind, "execute");
		assert.equal(pending[0].detail, "run the tests");
		assert.ok(Date.parse(pending[0].deadlineAt) > Date.now());
		const answered = await respondApproval(ref, "exec-1", decision);
		assert.equal(answered.status, "acked", JSON.stringify(answered));
		assert.equal(answered.result, "accepted");
		assert.equal(answered.ack.by, "worker");
		// A second answer for the same request is too_late.
		const again = await respondApproval(ref, "exec-1", "allow");
		assert.equal(again.status, "acked");
		assert.equal(again.result, "too_late");
		const snapshot = await waitTerminal(cwd, run);
		assert.equal(snapshot.status, "completed");
		assert.equal(
			await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
			decision === "allow" ? "allowed" : "denied",
		);
		const final = await result(cwd, run);
		assert.deepEqual(final.metadata.executor.approvals, [
			{
				requestId: "exec-1",
				kind: "execute",
				decision,
				by: "host",
				response: "accepted",
			},
		]);
		const audit = await readApprovalAudit(attemptDir(cwd, run));
		const decided = audit.filter((record) => record.phase === "decided");
		assert.equal(decided.length, 1);
		assert.equal(decided[0].by, "host");
		assert.equal(decided[0].decision, decision);
		assert.equal(decided[0].seq, answered.seq);
		assert.deepEqual(await listPendingApprovals(ref), []);
		// The mailbox was closed before the terminal result; every request is acked.
		const control = await readdir(join(attemptDir(cwd, run), "control"));
		assert.ok(control.includes("closed.json"));
		for (const name of control.filter((entry) => /^\d+-.+\.json$/u.test(entry)))
			assert.ok(control.includes(`${name.slice(0, 6)}.ack.json`), name);
	});
}

test("approval timeout: nobody answers → deny by default-timeout (fail-closed), late answer too_late", async () => {
	const { cwd, run, ref } = await startApprovalRun("approval-timeout", {
		interactive: true,
		timeoutMs: 400,
	});
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "completed");
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
		"denied",
	);
	const final = await result(cwd, run);
	assert.equal(final.metadata.executor.approvals[0].decision, "deny");
	assert.equal(final.metadata.executor.approvals[0].by, "default-timeout");
	const decided = (await readApprovalAudit(attemptDir(cwd, run))).filter(
		(record) => record.phase === "decided",
	);
	assert.equal(decided[0].by, "default-timeout");
	assert.match(decided[0].reason, /timeoutMs \(400 ms\)/u);
	const late = await respondApproval(ref, "exec-1", "allow");
	assert.equal(late.status, "acked");
	assert.equal(late.result, "too_late");
	assert.equal(
		late.ack.by,
		"requester",
		"the closed mailbox is answered by the requester",
	);
});

test("non-interactive policy: decided by engine-policy without waiting (D2)", async () => {
	const { cwd, run } = await startApprovalRun("approval-policy", {
		interactive: false,
		allowKinds: ["execute"],
	});
	await waitTerminal(cwd, run);
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
		"allowed",
	);
	const final = await result(cwd, run);
	assert.equal(final.metadata.executor.approvals[0].by, "engine-policy");
	assert.equal(final.metadata.executor.approvals[0].decision, "allow");
});

test("an answer from a fresh process after the launching process exited", async () => {
	const { cwd, effectLog } = fresh("detached-answer");
	await mkdir(cwd, { recursive: true });
	const launcher = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { runSubagent } = await import(${JSON.stringify(runtimeUrl)});
const run = await runSubagent(${JSON.stringify({
				cwd,
				executor: fixtureDescriptor({ effectLog, script: APPROVAL_SCRIPT }),
				task: "needs approval after the launcher is gone",
				async: true,
				approvalPolicy: { interactive: true, timeoutMs: 20_000 },
			})});
process.stdout.write(JSON.stringify({ runId: run.runId, attemptId: run.attemptId, pid: process.pid }));`,
		],
		{ stdio: ["ignore", "pipe", "inherit"], env: process.env },
	);
	let stdout = "";
	launcher.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const [code] = await once(launcher, "exit");
	assert.equal(code, 0);
	const run = JSON.parse(stdout);
	assert.throws(() => process.kill(run.pid, 0), "the launcher is gone");
	const answerer = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { listPendingApprovals, respondApproval } = await import(${JSON.stringify(runtimeUrl)});
const ref = ${JSON.stringify({ cwd, runId: run.runId, attemptId: run.attemptId })};
let pending = [];
for (let i = 0; i < 1000 && pending.length === 0; i += 1) {
	pending = await listPendingApprovals(ref);
	if (pending.length === 0) await new Promise((r) => setTimeout(r, 20));
}
const answer = await respondApproval(ref, pending[0].requestId, "allow");
process.stdout.write(JSON.stringify({ pending, answer, pid: process.pid }));`,
		],
		{ stdio: ["ignore", "pipe", "inherit"], env: process.env },
	);
	let answerOut = "";
	answerer.stdout.on("data", (chunk) => {
		answerOut += chunk;
	});
	const [answerCode] = await once(answerer, "exit");
	assert.equal(answerCode, 0);
	const { pending, answer, pid } = JSON.parse(answerOut);
	assert.equal(pending[0].requestId, "exec-1");
	assert.equal(answer.status, "acked");
	assert.equal(answer.result, "accepted");
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "completed");
	assert.equal(
		await readFile(join(attemptDir(cwd, run), "output.log"), "utf8"),
		"allowed",
	);
	const request = JSON.parse(
		await readFile(
			join(
				attemptDir(cwd, run),
				"control",
				`${String(answer.seq).padStart(6, "0")}-approval_response.json`,
			),
			"utf8",
		),
	);
	assert.equal(
		request.requester.pid,
		pid,
		"the answer came from the fresh process",
	);
	const effects = readEffectLog(effectLog);
	assert.notEqual(
		effects.find((entry) => entry.type === "effect").pid,
		run.pid,
		"the executor ran in the detached worker",
	);
});

async function startSlowRun(label) {
	const { cwd, effectLog } = fresh(label);
	await mkdir(cwd, { recursive: true });
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor({
			effectLog,
			script: SLOW_SCRIPT,
			stepDelayMs: 150,
		}),
		task: "slow",
		async: true,
	});
	const ref = { cwd, runId: run.runId, attemptId: run.attemptId };
	await waitFor(async () => {
		try {
			return (
				await readFile(join(attemptDir(cwd, run), "exec-events.jsonl"), "utf8")
			).includes("message_delta");
		} catch {
			return false;
		}
	});
	return { cwd, effectLog, run, ref };
}

test("cancel(turn) is forwarded to the executor; the runtime does not stop the attempt itself", async () => {
	const { cwd, effectLog, run, ref } = await startSlowRun("cancel-turn");
	const cancelled = await requestCancel(ref, "turn");
	assert.equal(cancelled.via, "mailbox", JSON.stringify(cancelled));
	assert.equal(cancelled.result, "cancelled");
	const snapshot = await waitTerminal(cwd, run);
	// The fake ends a cancelled turn with failed/cancelled: the executor's own outcome.
	assert.equal(snapshot.status, "cancelled");
	assert.equal(snapshot.failureKind, "cancelled");
	const final = await result(cwd, run);
	assert.equal(
		final.metadata.executor.cancelResult,
		undefined,
		"no runtime cancel(owned)",
	);
	assert.deepEqual(
		readEffectLog(effectLog)
			.filter((entry) => entry.type === "cancel")
			.map((entry) => entry.scope),
		["turn"],
	);
});

test("cancel(owned) takes the runtime stop path: cancel(owned) → cancelled/user_cancelled", async () => {
	const { cwd, effectLog, run, ref } = await startSlowRun("cancel-owned");
	const cancelled = await requestCancel(ref, "owned");
	assert.equal(cancelled.via, "mailbox", JSON.stringify(cancelled));
	assert.equal(cancelled.result, "cancelled");
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "cancelled");
	assert.equal(snapshot.failureKind, "user_cancelled");
	const final = await result(cwd, run);
	assert.equal(final.metadata.executor.cancelResult, "cancelled");
	assert.equal(final.metadata.outputPartial, true);
	assert.deepEqual(
		readEffectLog(effectLog)
			.filter((entry) => entry.type === "cancel")
			.map((entry) => entry.scope),
		["owned"],
	);
	// After terminal: the closed mailbox answers no_active (no SIGTERM fallback needed).
	const late = await requestCancel(ref, "owned");
	assert.equal(late.via, "mailbox");
	assert.equal(late.result, "no_active");
});

async function rawRequest(dir, seq, type, body) {
	const name = `${String(seq).padStart(6, "0")}-${type}.json`;
	const temp = join(dir, `.raw-${seq}-${type}.tmp`);
	await writeFile(
		temp,
		JSON.stringify({
			schema: "agent-workflow-control-request-v1",
			seq,
			type,
			requestedAt: new Date().toISOString(),
			requester: { pid: process.pid, host: "test" },
			...body,
		}),
	);
	await rename(temp, join(dir, name));
	return name;
}

async function ack(dir, seq) {
	return await waitFor(
		async () => {
			try {
				return JSON.parse(
					await readFile(
						join(dir, `${String(seq).padStart(6, "0")}.ack.json`),
						"utf8",
					),
				);
			} catch {
				return undefined;
			}
		},
		20_000,
		`ack ${seq}`,
	);
}

test("mailbox ordering: applied once in seq order; out-of-order, duplicate, unknown and invalid requests are rejected and recorded", async () => {
	const { cwd, effectLog, run, ref } = await startSlowRun("ordering");
	const dir = join(attemptDir(cwd, run), "control");
	await mkdir(dir, { recursive: true });
	await rawRequest(dir, 5, "approval_response", {
		requestId: "nope",
		decision: "allow",
	});
	const applied = await ack(dir, 5);
	assert.deepEqual(
		[applied.ok, applied.result, applied.by],
		[true, "unknown_request", "worker"],
	);
	// seq 3 after seq 5 was applied: rejected, and the cancel is NOT applied.
	await rawRequest(dir, 3, "cancel", { scope: "owned" });
	const outOfOrder = await ack(dir, 3);
	assert.deepEqual([outOfOrder.ok, outOfOrder.error], [false, "out_of_order"]);
	// Two requests with one seq.
	await rawRequest(dir, 7, "approval_response", {
		requestId: "a",
		decision: "allow",
	});
	await rawRequest(dir, 7, "mystery", {});
	const duplicate = await ack(dir, 7);
	if (duplicate.ok === false) assert.equal(duplicate.error, "duplicate_seq");
	await waitFor(async () => {
		if (duplicate.ok === false) return true;
		// The worker applied the first before the second landed: the second is recorded.
		try {
			return (await readFile(join(dir, "rejected.jsonl"), "utf8")).includes(
				"duplicate_seq",
			);
		} catch {
			return false;
		}
	});
	// Unknown type and invalid body.
	await rawRequest(dir, 9, "mystery", {});
	assert.deepEqual(
		[(await ack(dir, 9)).ok, (await ack(dir, 9)).error],
		[false, "unknown_type"],
	);
	await rawRequest(dir, 10, "cancel", { scope: "everything" });
	assert.deepEqual(
		[(await ack(dir, 10)).ok, (await ack(dir, 10)).error],
		[false, "invalid_request"],
	);
	// Nothing above cancelled the run; a proper request still works (seq allocated after 10).
	assert.equal(
		readEffectLog(effectLog).some((entry) => entry.type === "cancel"),
		false,
	);
	const cancelled = await requestCancel(ref, "owned");
	assert.equal(cancelled.via, "mailbox");
	assert.ok(cancelled.seq > 10);
	assert.equal(cancelled.result, "cancelled");
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.failureKind, "user_cancelled");
	// Exactly one cancel reached the executor.
	assert.equal(
		readEffectLog(effectLog).filter((entry) => entry.type === "cancel").length,
		1,
	);
});

test("requests to an attempt that never served its mailbox are answered once it is terminal", async () => {
	const { cwd, effectLog } = fresh("never-served");
	await mkdir(cwd, { recursive: true });
	const run = await runSubagent({
		cwd,
		executor: fixtureDescriptor(
			{ effectLog },
			{ module: "/nonexistent/aw-missing-executor.mjs" },
		),
		task: "never",
		async: true,
	});
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.failureKind, "guard_failure");
	const ref = { cwd, runId: run.runId, attemptId: run.attemptId };
	const cancelled = await requestCancel(ref, "owned", { ackTimeoutMs: 5_000 });
	assert.equal(cancelled.via, "mailbox");
	assert.equal(cancelled.result, "no_active");
	assert.equal(cancelled.ack.by, "requester");
	const answered = await respondApproval(ref, "whatever", "allow");
	assert.equal(answered.result, "too_late");
});

test("SIGTERM fallback: a worker that does not ack in time is interrupted", async () => {
	const { cwd, effectLog } = fresh("fallback");
	await mkdir(cwd, { recursive: true });
	// The worker sleeps before execution (interruptible): its mailbox is not served yet.
	process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS = "30000";
	let run;
	try {
		run = await runSubagent({
			cwd,
			executor: fixtureDescriptor({ effectLog }),
			task: "slow start",
			async: true,
		});
	} finally {
		delete process.env.AGENT_WORKFLOW_DURABLE_WORKER_START_DELAY_MS;
	}
	const ref = { cwd, runId: run.runId, attemptId: run.attemptId };
	// Signal only once the worker runs JavaScript: its own registry writes move heartbeatAt past
	// the launcher's (a SIGTERM before node runs the first statement kills it by default).
	const heartbeat = async () =>
		JSON.parse(
			await readFile(
				join(cwd, ".agent-workflow/runs", run.runId, "run.json"),
				"utf8",
			),
		).attempts[0]?.heartbeatAt;
	const launched = await heartbeat();
	await waitFor(async () => (await heartbeat()) !== launched);
	const cancelled = await requestCancel(ref, "owned", {
		ackTimeoutMs: 300,
		escalateAfterMs: 10_000,
		killAfterMs: 20_000,
	});
	assert.equal(cancelled.via, "signal", JSON.stringify(cancelled));
	assert.equal(cancelled.interrupt.status, "interrupt-requested");
	const snapshot = await waitTerminal(cwd, run);
	assert.equal(snapshot.status, "cancelled");
	assert.equal(snapshot.failureKind, "user_cancelled");
	assert.deepEqual(readEffectLog(effectLog), [], "nothing launched");
	// The unacked request was answered by the closing sweep before the terminal result.
	const ackFile = JSON.parse(
		await readFile(
			join(
				attemptDir(cwd, run),
				"control",
				`${String(cancelled.seq).padStart(6, "0")}.ack.json`,
			),
			"utf8",
		),
	);
	assert.equal(ackFile.by, "closed");
	assert.equal(ackFile.result, "no_active");
});
