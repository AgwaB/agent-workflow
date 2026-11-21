// Provider pause: the deterministic state machine (injected clock), overload classification, the
// persisted home-wide state, and the health/stall reading of a paused run.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { diagnoseWorkflowRunHealth } from "../../dist/core/workflow-progress-health.js";
import { formatRunStallWarning } from "../../dist/core/engine-format.js";
import { providerOverloadSignal } from "../../dist/core/retry-policy.js";
import * as pause from "../../dist/core/provider-pause.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-21T10:00:00Z");
const overload = (state, at, holder = "r/t1", hintMs) =>
	pause.applyProviderOverload(state, at, { holder, hintMs });

test("waits are 5 min doubling per consecutive open, capped at 60 min", () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 9].map((n) => pause.providerPauseWaitMs(n) / MIN),
		[5, 10, 20, 40, 60, 60, 60],
	);
});

test("overload classification: 429/502/503/524/529/overloaded/saturated/busy/rate limit; not mid-stream", () => {
	const signal = (text, failureKind = "transient") =>
		providerOverloadSignal({ failureKind, errorMessage: text, stderrText: "" });
	for (const text of [
		"HTTP 429 Too Many Requests",
		"502 Bad Gateway",
		"HTTP 503 Service Unavailable",
		"524 A timeout occurred (cloudflare)",
		"status 529",
		"Overloaded",
		"The server is saturated, retry later",
		"The model is busy. Retry shortly.",
		"rate limit exceeded",
		"too many requests",
	])
		assert.equal(signal(text).overload, true, text);
	// The executor's own class needs no text.
	assert.equal(signal("", "rate_limit").overload, true);
	for (const text of [
		"socket hang up",
		"read ECONNRESET",
		"terminated",
		"stream ended prematurely (other side closed)",
		"fetch failed: connection closed mid-stream",
		"model returned invalid JSON in stream chunk 5029",
	])
		assert.equal(signal(text, "transient").overload, false, text);
	// Other failure kinds never count, whatever the text says.
	for (const kind of [
		"timeout",
		"permanent_model_failure",
		"context_or_request_too_large",
	])
		assert.equal(signal("HTTP 503 overloaded", kind).overload, false, kind);
	// A real quota reset hint is carried; a transient hint is bounded by the 5-minute default.
	assert.equal(
		providerOverloadSignal({
			failureKind: "rate_limit",
			errorMessage: "HTTP 429 Retry-After: 1800",
			stderrText: "",
		}).hintMs,
		1_800_000,
	);
	assert.equal(
		providerOverloadSignal({
			failureKind: "transient",
			errorMessage: "503 overloaded, Retry-After: 1800",
			stderrText: "",
		}).hintMs,
		5 * MIN,
	);
});

test("overload classification: real provider texts count, bare numbers and permanent model failures do not", () => {
	const signal = (text, failureKind = "transient") =>
		providerOverloadSignal({ failureKind, errorMessage: text, stderrText: "" });
	// Texts of the DeepSeek study (deepseek-repeat-20261121) and the usual status forms.
	for (const text of [
		'503: {"message":"The service is busy right now. Please try again in a moment.","type":"server_error"}',
		"503 upstream_saturated",
		'502 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/"}',
		"524 A timeout occurred",
		"Error 524",
		"error: 529 Overloaded",
		'{"status":503,"error":"unavailable"}',
		"HTTP/1.1 503 Service Unavailable",
		"429 session_limit_reached: 5 requests in use",
		"upstream busy",
	])
		assert.equal(signal(text).overload, true, text);
	// A number alone is no evidence, whatever the failure kind (transient or not).
	for (const text of [
		"TypeError at src/x.ts:503",
		"Error in src/core/x.ts:529:12",
		"prompt is 429 tokens long",
		"the file has 502 lines",
		"maximum context length is 8192 tokens, you requested 5029",
		"model returned invalid JSON in stream chunk 5029",
		"socket closed after 524 bytes",
		"read ECONNRESET (mid-stream, 503 chunks received)",
		"context length exceeded: 429 tokens over the limit",
	]) {
		assert.equal(signal(text).overload, false, text);
		assert.equal(signal(text, "model").overload, false, `model: ${text}`);
	}
	// A permanent `model` failure is never overload, even with overload words.
	assert.equal(signal("HTTP 503 overloaded", "model").overload, false);
	assert.equal(signal("429 Too Many Requests", "model").overload, false);
});

test("opens at the third overload within 5 minutes; that failure is refunded, the first two are not", () => {
	let r = overload(undefined, T0);
	assert.equal(r.refund, false);
	r = overload(r.state, T0 + MIN);
	assert.equal(r.refund, false);
	assert.equal(r.state.openUntilMs, undefined);
	r = overload(r.state, T0 + 4 * MIN);
	assert.equal(r.refund, true);
	assert.equal(r.state.opens, 1);
	assert.equal(r.state.openUntilMs, T0 + 4 * MIN + 5 * MIN);
});

test("failures more than 5 minutes apart do not add up", () => {
	let r = overload(undefined, T0);
	r = overload(r.state, T0 + 3 * MIN);
	r = overload(r.state, T0 + 6 * MIN); // the first aged out: window holds 2
	assert.equal(r.refund, false);
	assert.equal(r.state.openUntilMs, undefined);
});

test("failures while the pause is open are refunded and do not reopen it; a longer hint extends it", () => {
	let r = overload(overload(overload(undefined, T0).state, T0).state, T0);
	const openUntil = r.state.openUntilMs;
	const during = overload(r.state, T0 + MIN, "r/other");
	assert.equal(during.refund, true);
	assert.equal(during.state.opens, 1);
	assert.equal(during.state.openUntilMs, openUntil);
	const hinted = overload(r.state, T0 + MIN, "r/other", 30 * MIN);
	assert.equal(hinted.state.openUntilMs, T0 + MIN + 30 * MIN);
});

test("launch gate: wait until openUntil, then exactly one probe lease", () => {
	const open = overload(
		overload(overload(undefined, T0).state, T0).state,
		T0,
	).state;
	const before = pause.evaluateProviderPauseLaunch(open, T0 + MIN, "r/a");
	assert.equal(before.kind, "wait");
	assert.equal(before.retryAfterMs, 4 * MIN);
	const first = pause.evaluateProviderPauseLaunch(open, T0 + 5 * MIN, "r/a");
	assert.equal(first.kind, "probe");
	assert.equal(first.state.probe.holder, "r/a");
	assert.equal(
		first.state.probe.leaseUntilMs,
		T0 + 10 * MIN,
		"lease = the wait",
	);
	const second = pause.evaluateProviderPauseLaunch(
		first.state,
		T0 + 5 * MIN + 1,
		"r/b",
	);
	assert.equal(second.kind, "wait");
	// The holder itself may continue; a stale lease passes on.
	assert.equal(
		pause.evaluateProviderPauseLaunch(first.state, T0 + 6 * MIN, "r/a").kind,
		"probe",
	);
	assert.equal(
		pause.evaluateProviderPauseLaunch(first.state, T0 + 10 * MIN + 1, "r/b")
			.kind,
		"probe",
	);
	// A short wait still leases at least 30 s.
	const short = pause.evaluateProviderPauseLaunch(
		{ failuresAtMs: [], opens: 1, openUntilMs: T0, waitMs: 1000 },
		T0,
		"r/a",
	);
	assert.equal(short.state.probe.leaseUntilMs, T0 + 30_000);
	// Without recording a lease the early check only says "go".
	const check = pause.evaluateProviderPauseLaunch(open, T0 + 5 * MIN, "r/a", {
		acquire: false,
	});
	assert.equal(check.kind, "go");
});

test("probe success closes the pause and resets the escalation; probe overload reopens with 2x", () => {
	let state = overload(
		overload(overload(undefined, T0).state, T0).state,
		T0,
	).state;
	let now = T0 + 5 * MIN;
	state = pause.evaluateProviderPauseLaunch(state, now, "r/a").state;
	// Probe overload: reopen with the next wait, lease gone, refund.
	const failed = overload(state, now + 1000, "r/a");
	assert.equal(failed.refund, true);
	assert.equal(failed.state.opens, 2);
	assert.equal(failed.state.openUntilMs, now + 1000 + 10 * MIN);
	assert.equal(failed.state.probe, undefined);
	// An overload of a non-holder after openUntil is refunded but does not reopen.
	const half = pause.evaluateProviderPauseLaunch(
		failed.state,
		failed.state.openUntilMs,
		"r/b",
	).state;
	const stray = overload(half, failed.state.openUntilMs + 10, "r/c");
	assert.equal(stray.refund, true);
	assert.equal(stray.state.opens, 2);
	// Non-holder outcomes change nothing; the holder's success closes.
	assert.equal(pause.applyProviderPauseOutcome(half, "r/c", "success"), half);
	assert.equal(
		pause.applyProviderPauseOutcome(half, "r/b", "success"),
		undefined,
	);
	// A released lease keeps the pause half-open for the next probe.
	const released = pause.applyProviderPauseOutcome(half, "r/b", "release");
	assert.equal(released.probe, undefined);
	assert.equal(released.openUntilMs, half.openUntilMs);
	// After a close the escalation starts from 5 min again.
	let again;
	for (let i = 0; i < 3; i += 1) again = overload(again?.state, now + 20 * MIN);
	assert.equal(again.state.opens, 1);
	assert.equal(again.state.waitMs, 5 * MIN);
});

test("cap env: default 120 min, 0 = off, invalid falls back to the default", () => {
	const ms = (value) =>
		pause.providerPauseMaxMs(
			value === undefined
				? {}
				: { [pause.PROVIDER_PAUSE_MAX_MINUTES_ENV]: value },
		);
	assert.equal(ms(undefined), 120 * MIN);
	assert.equal(ms(""), 120 * MIN);
	assert.equal(ms("0"), 0);
	assert.equal(ms("30"), 30 * MIN);
	assert.equal(ms("-1"), 120 * MIN);
	assert.equal(ms("x"), 120 * MIN);
});

test("cap: paused time of all keys, including a pause in progress, counts against the run", () => {
	const run = {
		providerPause: {
			a: { opens: 1, pausedMs: 100 * MIN },
			b: {
				opens: 1,
				pausedMs: 10 * MIN,
				pausedSince: new Date(T0 - 9 * MIN).toISOString(),
			},
		},
	};
	assert.equal(pause.providerPauseCapReached(run, T0, 120 * MIN), false); // 100+10+9
	assert.equal(
		pause.providerPauseCapReached(run, T0 + 2 * MIN, 120 * MIN),
		true,
	); // 121
	assert.equal(
		pause.providerPauseCapReached(run, T0 + 2 * MIN, 0),
		false,
		"off",
	);
});

test("persisted state is shared across callers of the same home, and closes on probe success", async () => {
	const restoreCap = process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV];
	process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV] = "120";
	await pause.removeProviderPauseStateForTests();
	const file = join(process.env.AGENT_WORKFLOW_HOME, "provider-pause.json");
	const task = (id) => ({ taskId: id });
	const runA = { runId: "run-a" };
	const runB = { runId: "run-b" };
	try {
		const outcomes = [];
		for (const [run, id] of [
			[runA, "t1"],
			[runB, "t1"],
			[runB, "t2"],
		])
			outcomes.push(
				await pause.providerPauseObserveTerminal({
					run: { ...run, tasks: [] },
					task: task(id),
					key: "prov",
					outcome: "overload",
				}),
			);
		assert.deepEqual(
			outcomes.map((o) => o.refund),
			[false, false, true],
		);
		const onDisk = JSON.parse(readFileSync(file, "utf8")).prov;
		assert.equal(onDisk.opens, 1);
		assert.ok(onDisk.openUntilMs > Date.now() + 4 * MIN);
		// Another caller (another run) sees the same wait.
		const gate = await pause.providerPauseLaunchGate(
			{ runId: "run-c", tasks: [] },
			task("t9"),
			"prov",
			{ acquire: true },
		);
		assert.equal(gate.kind, "wait");
		// Other providers are unaffected.
		assert.equal(
			(
				await pause.providerPauseLaunchGate(
					{ runId: "run-c", tasks: [] },
					task("t9"),
					"other",
					{ acquire: true },
				)
			).kind,
			"go",
		);
		// Expire, lease, succeed.
		const aged = JSON.parse(readFileSync(file, "utf8"));
		aged.prov.openUntilMs = Date.now() - 1000;
		(await import("node:fs")).writeFileSync(file, JSON.stringify(aged));
		const runC = { runId: "run-c", tasks: [] };
		assert.equal(
			(
				await pause.providerPauseLaunchGate(runC, task("t9"), "prov", {
					acquire: true,
				})
			).kind,
			"go",
		);
		assert.equal(
			JSON.parse(readFileSync(file, "utf8")).prov.probe.holder,
			"run-c/t9",
		);
		assert.equal(
			(
				await pause.providerPauseLaunchGate(
					{ runId: "run-d", tasks: [] },
					task("t1"),
					"prov",
					{ acquire: true },
				)
			).kind,
			"wait",
		);
		await pause.providerPauseObserveTerminal({
			run: runC,
			task: task("t9"),
			key: "prov",
			outcome: "success",
		});
		assert.equal(JSON.parse(readFileSync(file, "utf8")).prov, undefined);
	} finally {
		if (restoreCap === undefined)
			delete process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV];
		else process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV] = restoreCap;
		await pause.removeProviderPauseStateForTests();
		assert.equal(existsSync(file), false);
	}
});

const pausedRun = (overrides = {}) => ({
	runId: "run-x",
	status: "running",
	createdAt: new Date(T0 - 3 * 3_600_000).toISOString(),
	updatedAt: new Date(T0 - 3 * 3_600_000).toISOString(),
	taskSummary: {
		pending: 2,
		running: 0,
		blocked: 0,
		completed: 1,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 3,
	},
	tasks: [],
	...overrides,
});

test("progress health: a paused run is waiting, not a stuck scheduler", () => {
	const paused = pausedRun({
		providerPause: {
			prov: {
				opens: 1,
				pausedMs: 0,
				pausedSince: new Date(T0 - 3_000_000).toISOString(),
				openUntil: new Date(T0 + MIN).toISOString(),
				pause: 1,
			},
		},
	});
	const health = diagnoseWorkflowRunHealth(paused, { nowMs: T0 });
	assert.equal(health.state, "pending");
	assert.equal(health.suggestion, "wait");
	// Same quiet run without a pause is stuck (so the test would catch a missing exemption).
	assert.equal(
		diagnoseWorkflowRunHealth(pausedRun(), { nowMs: T0 }).state,
		"likely-stuck",
	);
	// Once the cap is reached the exemption ends.
	const capped = pausedRun({
		providerPause: { prov: { ...paused.providerPause.prov, capReached: true } },
	});
	assert.equal(
		diagnoseWorkflowRunHealth(capped, { nowMs: T0 }).state,
		"likely-stuck",
	);
});

test("stall warning: no 'no task progress' alarm while the run is paused", () => {
	const supervisor = {
		updatedAt: new Date(T0 - 1000).toISOString(),
		lastTaskTransitionAt: new Date(T0 - 3 * 3_600_000).toISOString(),
		taskStatusCounts: { pending: 2 },
	};
	const quiet = pausedRun({ tasks: [] });
	assert.match(
		formatRunStallWarning(quiet, supervisor, T0) ?? "",
		/no task progress/,
	);
	const paused = pausedRun({
		providerPause: {
			prov: {
				opens: 1,
				pausedMs: 0,
				pausedSince: new Date(T0 - 3_000_000).toISOString(),
				openUntil: new Date(T0 + MIN).toISOString(),
				pause: 1,
			},
		},
	});
	// The pause is only shown while the feature is on (the unit runner switches it off).
	const restore = process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV];
	process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV] = "120";
	try {
		assert.equal(formatRunStallWarning(paused, supervisor, T0), undefined);
	} finally {
		if (restore === undefined)
			delete process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV];
		else process.env[pause.PROVIDER_PAUSE_MAX_MINUTES_ENV] = restore;
	}
});
