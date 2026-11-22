// test-tier: integration
// Provider pause (circuit breaker), engine level: the real terminal-result materializer and launch
// gate run against an injected runtime API that reports scripted overload failures. "Time" is moved
// by rewriting the persisted pause state (the state file is the clock-dependent part), so nothing
// here waits. The full-run scenario with the fixture executor is core-provider-pause-run.test.mjs.
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import { stateDir } from "../helpers/state-dir.mjs";
import {
	assert,
	createPendingSingleTaskRun,
	dirname,
	existsSync,
	formatRun,
	join,
	launchWorkerTask,
	makeProject,
	mkdirSync,
	readRunRecord,
	refreshRunFromWorkerArtifacts,
	rmSync,
	setTaskRuntimeApiForTests as setRawApi,
	setWorkerLaunchControlsForTests,
	test,
	writeFileSync,
	writeRunRecord,
} from "../helpers/unit-test-support.mjs";
import { readFileSync } from "node:fs";
import { fromStatePath } from "../../dist/core/store.js";
import { cleanupWorkerRun } from "../../dist/core/task-cancellation.js";

const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);
const pause = await import("../../dist/core/provider-pause.js");
const CAP_ENV = pause.PROVIDER_PAUSE_MAX_MINUTES_ENV;
const MODEL = "ovl/model-1";
const KEY = "ovl";
const OVERLOAD = "Provider request failed: HTTP 503 The model is overloaded.";
const SOCKET =
	"Error: socket hang up (ECONNRESET) while streaming the response";
const stateFile = () =>
	join(process.env.AGENT_WORKFLOW_HOME, "provider-pause.json");
const readState = () => {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8"))[KEY];
	} catch {
		return undefined;
	}
};
const rewriteState = (mutate) => {
	const all = JSON.parse(readFileSync(stateFile(), "utf8"));
	mutate(all[KEY]);
	writeFileSync(stateFile(), JSON.stringify(all));
};

let counter = 0;
function useCap(value) {
	const previous = process.env[CAP_ENV];
	if (value === undefined) delete process.env[CAP_ENV];
	else process.env[CAP_ENV] = value;
	return () => {
		if (previous === undefined) delete process.env[CAP_ENV];
		else process.env[CAP_ENV] = previous;
	};
}

async function withPause(cap, body) {
	const restore = useCap(cap);
	await pause.removeProviderPauseStateForTests();
	setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	const cwd = makeProject();
	try {
		await body(cwd);
	} finally {
		restore();
		setTaskRuntimeApiForTests(undefined);
		await pause.removeProviderPauseStateForTests();
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
}

/** A pending single-task run of provider KEY (its own run id, so its own probe holder). */
async function pending(cwd, options = {}) {
	counter += 1;
	return createPendingSingleTaskRun(cwd, {
		model: MODEL,
		specName: `pause-${counter}`,
		...options,
	});
}

/**
 * The attempt of `item` (a pending run, or one that `launch` started) ends failed with `text`;
 * refresh materializes it.
 */
async function failAttempt(
	cwd,
	item,
	{ text, failureKind = "transient", launchRetry } = {},
) {
	counter += 1;
	const { run, task } = item;
	const launched = task.workerHandle !== undefined;
	const runId = task.workerHandle?.runId ?? `run_pause_${counter}`;
	const attemptId = task.workerHandle?.attemptId ?? `attempt_pause_${counter}`;
	// A launched task keeps its handle and its artifacts live under its own runsDir.
	const artifactCwd = launched
		? fromStatePath(cwd, task.workerFiles.runsDir)
		: cwd;
	const dirName = `.fake-pause-worker-${counter}`;
	const dir = join(artifactCwd, dirName);
	if (!launched) {
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.workerHandle = {
			runId,
			attemptId,
			cwd,
			runsDir: `.agent-workflow/worker-runs/${runId}`,
			display: `worker run ${runId}/${attemptId}`,
		};
	}
	if (launchRetry) task.launchRetry = launchRetry;
	const metadata = {
		contextLengthExceeded: false,
		stopReason: "error",
		...(text === undefined ? {} : { streamErrors: [text] }),
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "output.log"), "");
	writeFileSync(join(dir, "stderr.log"), "");
	writeFileSync(
		join(dir, "result.json"),
		JSON.stringify({
			status: "failed",
			failureKind,
			exitCode: 0,
			completedAt: new Date().toISOString(),
			startedAt: task.startedAt,
			errorMessage: "agent-workflow run failed: model",
			metadata,
		}),
	);
	const logs = ["output", "stderr", "result"].map((type) => ({
		type,
		path: `${dirName}/${type === "result" ? "result.json" : `${type}.log`}`,
		artifactCwd,
	}));
	setTaskRuntimeApiForTests({
		async runWorker() {
			throw new Error("not expected");
		},
		async reconcileWorkerRun() {
			return {};
		},
		async getWorkerStatus() {
			return {
				runId,
				attemptId,
				executorId: "headless",
				status: "failed",
				failureKind,
				startedAt: task.startedAt,
				completedAt: new Date().toISOString(),
				logs,
				metadata,
				attempts: [{ attemptId, status: "failed", pid: 99999999 }],
			};
		},
		async interruptWorker() {
			return {};
		},
	});
	await writeRunRecord(cwd, run);
	const refreshed = await refreshRunFromWorkerArtifacts(
		cwd,
		await readRunRecord(cwd, run.runId),
	);
	item.run = refreshed;
	item.task = refreshed.tasks[0];
	return item.task;
}

let launches = [];
function launchApi() {
	launches = [];
	return launches;
}

/** Launches `item` through the real launch gate with a stub runtime that records the launch. */
function launch(cwd, item) {
	setTaskRuntimeApiForTests({
		async runWorker(options) {
			launches.push(options);
			return {
				runId: `run_launch_${launches.length}`,
				attemptId: `attempt_launch_${launches.length}`,
				status: "running",
			};
		},
		async getWorkerStatus() {
			return null;
		},
		async reconcileWorkerRun() {
			return {};
		},
		async interruptWorker() {
			return {};
		},
	});
	return launchWorkerTask(cwd, item.run, item.task, item.compiled.tasks[0]);
}

/** Three overload failures of three runs open the pause (the third is the opener). */
async function openPause(cwd) {
	const items = [];
	for (let i = 0; i < 3; i += 1) {
		const item = await pending(cwd);
		await failAttempt(cwd, item, { text: OVERLOAD });
		items.push(item);
	}
	return items;
}

test("the third overload failure within the window opens the pause and is not counted", async () => {
	await withPause("120", async (cwd) => {
		const [first, second, third] = await openPause(cwd);
		// Failures 1 and 2: today's accounting (a retry attempt is spent).
		for (const item of [first, second]) {
			assert.equal(item.task.status, "pending");
			assert.equal(item.task.launchRetry?.attempts, 1);
			assert.equal(item.task.providerPauseRefunds, undefined);
		}
		// Failure 3 opens the pause and is refunded: pending, waiting, no attempt spent.
		assert.equal(third.task.status, "pending");
		assert.equal(third.task.statusDetail, "provider_pause");
		// The relaunch needs a new attempt identity, so the counter moves but the budget grows
		// with it: 5 retries are still left.
		assert.equal(third.task.launchRetry.reason, "provider_pause");
		assert.equal(
			third.task.launchRetry.maxAttempts - third.task.launchRetry.attempts,
			5,
		);
		assert.equal(third.task.providerPauseRefunds, 1);
		assert.match(
			third.task.lastMessage,
			/provider ovl overloaded: paused until \d\d:\d\dZ, attempt not counted/,
		);
		assert.ok(
			existsSync(
				join(
					stateDir(cwd),
					dirname(third.task.files.result),
					"result.provider-pause-1.json",
				),
			),
			"the refunded attempt keeps its result for diagnosis",
		);
		const state = readState();
		assert.equal(state.opens, 1);
		assert.equal(state.waitMs, 5 * 60_000);
		assert.ok(state.openUntilMs > Date.now() + 4 * 60_000);
		assert.equal(third.run.providerPause[KEY].opens, 1);
		assert.ok(third.run.providerPause[KEY].pausedSince);
	});
});

test("a run counts one pause once while another of its tasks holds the probe", async () => {
	await withPause("120", async (cwd) => {
		const [, , third] = await openPause(cwd);
		const { run } = third;
		assert.equal(run.providerPause[KEY].opens, 1);
		rewriteState((state) => {
			state.openUntilMs = Date.now() - 1_000;
		});
		const prober = { ...third.task, taskId: "task-probe" };
		const waiter = { ...third.task, taskId: "task-wait" };
		// One task of the run takes the probe; another sees the busy lease and keeps waiting.
		assert.equal(
			(await pause.providerPauseLaunchGate(run, prober, KEY, { acquire: true }))
				.kind,
			"go",
		);
		assert.equal(
			(await pause.providerPauseLaunchGate(run, waiter, KEY, { acquire: true }))
				.kind,
			"wait",
		);
		// Still the first pause (2026-11-22 e2e: opens read 4 for 2 pauses).
		assert.equal(run.providerPause[KEY].opens, 1);
	});
});

test("two overload failures, or failures more than 5 minutes apart, do not open it", async () => {
	await withPause("120", async (cwd) => {
		for (let i = 0; i < 2; i += 1) {
			const item = await pending(cwd);
			await failAttempt(cwd, item, { text: OVERLOAD });
		}
		assert.equal(readState().openUntilMs, undefined);
		// The two recorded failures age out of the 5-minute window before the third arrives.
		rewriteState((state) => {
			state.failuresAtMs = state.failuresAtMs.map((at) => at - 6 * 60_000);
		});
		const third = await pending(cwd);
		await failAttempt(cwd, third, { text: OVERLOAD });
		assert.equal(
			third.task.launchRetry?.attempts,
			1,
			"the old accounting applies",
		);
		assert.equal(readState().openUntilMs, undefined);
	});
});

test("an overload failure while the pause is open spends no attempt, even on the last one", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		const late = await pending(cwd);
		await failAttempt(cwd, late, {
			text: OVERLOAD,
			launchRetry: { attempts: 5, maxAttempts: 5, reason: "model" },
		});
		// Today this would be attempt 6 of 5: failed ("model_exhausted").
		assert.equal(late.task.status, "pending");
		assert.equal(late.task.statusDetail, "provider_pause");
		assert.equal(late.task.launchRetry.reason, "provider_pause");
		assert.equal(
			late.task.launchRetry.maxAttempts - late.task.launchRetry.attempts,
			0,
			"budget left is what it was (none), not exhausted",
		);
		assert.equal(late.task.providerPauseRefunds, 1);
	});
});

test("a rate_limit failure counts as overload without any text", async () => {
	await withPause("120", async (cwd) => {
		for (let i = 0; i < 3; i += 1) {
			const item = await pending(cwd);
			await failAttempt(cwd, item, { failureKind: "rate_limit" });
			if (i === 2) assert.equal(item.task.statusDetail, "provider_pause");
		}
	});
});

test("while the pause is open no task of the provider launches; other providers do", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const waiting = await pending(cwd);
		const result = await launch(cwd, waiting);
		assert.equal(result.kind, "capacity");
		assert.match(
			result.message,
			/provider ovl overloaded: paused until \d\d:\d\dZ; waiting before launching/,
		);
		assert.ok(result.retryAfterMs > 0);
		assert.equal(waiting.task.statusDetail, "provider_pause");
		assert.equal(launches.length, 0);
		const other = await pending(cwd, { model: "other/model-2" });
		assert.equal((await launch(cwd, other)).kind, "launched");
		assert.equal(launches.length, 1);
	});
});

test("after openUntil exactly one task probes; the others keep waiting", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const a = await pending(cwd);
		const b = await pending(cwd);
		rewriteState((state) => {
			state.openUntilMs = Date.now() - 1_000;
		});
		assert.equal((await launch(cwd, a)).kind, "launched");
		const blocked = await launch(cwd, b);
		assert.equal(blocked.kind, "capacity");
		assert.match(blocked.message, /paused, waiting for the probe/);
		assert.equal(launches.length, 1);
		const lease = readState().probe;
		assert.equal(lease.holder, `${a.run.runId}/${a.task.taskId}`);
		assert.ok(
			lease.leaseUntilMs >= Date.now() + 29_000,
			"lease is at least 30 s (and the last wait)",
		);
		// A lease that timed out passes to the next task.
		rewriteState((state) => {
			state.probe.leaseUntilMs = Date.now() - 1;
		});
		const afterTimeout = await launch(cwd, b);
		assert.equal(afterTimeout.kind, "launched");
		assert.equal(launches.length, 2);
	});
});

test("probe success closes the pause, resets the escalation and releases every waiting task", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const probe = await pending(cwd);
		const waiting = await pending(cwd);
		rewriteState((state) => {
			state.openUntilMs = Date.now() - 1_000;
			state.opens = 2;
		});
		assert.equal((await launch(cwd, probe)).kind, "launched");
		assert.equal((await launch(cwd, waiting)).kind, "capacity");
		// The probe ends with a failure that is not overload: any non-overload outcome closes.
		await failAttempt(cwd, probe, { text: SOCKET });
		assert.equal(readState(), undefined, "closed, escalation reset");
		assert.equal((await launch(cwd, waiting)).kind, "launched");
		assert.equal(launches.length, 2);
		assert.equal(waiting.run.providerPause?.[KEY]?.pausedSince, undefined);
		// Next time the pause starts from the first wait again.
		for (let i = 0; i < 3; i += 1)
			await failAttempt(cwd, await pending(cwd), { text: OVERLOAD });
		assert.equal(readState().opens, 1);
		assert.equal(readState().waitMs, 5 * 60_000);
	});
});

test("a probe whose holder cannot report an outcome never holds the provider: stop, launch error, non-overload failure", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const expire = () =>
			rewriteState((state) => {
				state.openUntilMs = Date.now() - 1_000;
			});
		const holderOf = (item) => `${item.run.runId}/${item.task.taskId}`;
		expire();
		// 1. The probe task's run is stopped (stop, interrupt, driver lost and resume all clean up the
		// run): its lease goes back at once, not after the lease timeout.
		const stopped = await pending(cwd);
		const waiting = await pending(cwd);
		assert.equal((await launch(cwd, stopped)).kind, "launched");
		assert.equal(readState().probe.holder, holderOf(stopped));
		assert.equal((await launch(cwd, waiting)).kind, "capacity");
		stopped.task.status = "interrupted";
		await cleanupWorkerRun(cwd, stopped.run);
		assert.equal(readState().probe, undefined, "lease released by the stop");
		assert.equal(
			readState().openUntilMs !== undefined,
			true,
			"the pause stays half-open for the next probe",
		);
		assert.equal((await launch(cwd, waiting)).kind, "launched");
		assert.equal(readState().probe.holder, holderOf(waiting));
		// 2. The probe's launch throws: no worker exists, the lease is returned.
		const failing = await pending(cwd);
		rewriteState((state) => {
			state.probe.leaseUntilMs = Date.now() - 1;
		});
		setTaskRuntimeApiForTests({
			async runWorker() {
				throw new Error("executor launch exploded");
			},
			async getWorkerStatus() {
				return null;
			},
			async reconcileWorkerRun() {
				return {};
			},
			async interruptWorker() {
				return {};
			},
		});
		await assert.rejects(
			launchWorkerTask(
				cwd,
				failing.run,
				failing.task,
				failing.compiled.tasks[0],
			),
			/exploded/,
		);
		assert.equal(failing.task.status, "pending");
		assert.equal(
			readState().probe,
			undefined,
			"lease released by the launch error",
		);
		// 3. The probe ends with a failure that is not overload (permanent, kind != overload):
		// the provider answered, so the pause closes instead of waiting for the lease.
		const answered = await pending(cwd);
		assert.equal((await launch(cwd, answered)).kind, "launched");
		await failAttempt(cwd, answered, {
			failureKind: "permanent_model_failure",
			text: "invalid request: prompt is 429 tokens too long",
		});
		assert.equal(readState(), undefined, "closed by the non-overload outcome");
	});
});

test("probe overload reopens the pause with the next longer wait and spends no attempt", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const probe = await pending(cwd);
		rewriteState((state) => {
			state.openUntilMs = Date.now() - 1_000;
		});
		assert.equal((await launch(cwd, probe)).kind, "launched");
		await failAttempt(cwd, probe, {
			text: OVERLOAD,
			launchRetry: { attempts: 5, maxAttempts: 5, reason: "model" },
		});
		assert.equal(probe.task.status, "pending");
		assert.equal(
			probe.task.launchRetry.maxAttempts - probe.task.launchRetry.attempts,
			0,
		);
		const state = readState();
		assert.equal(state.opens, 2);
		assert.equal(state.waitMs, 10 * 60_000);
		assert.equal(state.probe, undefined);
		assert.ok(state.openUntilMs > Date.now() + 9 * 60_000);
		// Third reopen: 20 minutes; the wait is capped at 60.
		for (const expected of [20, 40, 60, 60]) {
			rewriteState((current) => {
				current.openUntilMs = Date.now() - 1_000;
			});
			const next = await pending(cwd);
			assert.equal((await launch(cwd, next)).kind, "launched");
			await failAttempt(cwd, next, { text: OVERLOAD });
			assert.equal(readState().waitMs, expected * 60_000);
		}
	});
});

test("a longer provider reset hint on a real rate limit extends the pause", async () => {
	await withPause("120", async (cwd) => {
		for (let i = 0; i < 2; i += 1)
			await failAttempt(cwd, await pending(cwd), { text: OVERLOAD });
		await failAttempt(cwd, await pending(cwd), {
			failureKind: "rate_limit",
			text: "HTTP 429 rate_limit_error. Retry-After: 1800",
		});
		assert.equal(readState().waitMs, 1800_000);
	});
});

test("cap reached: the run waits no longer and failures are counted as before", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const item = await pending(cwd);
		// The run has already paused for its whole allowance.
		item.run.providerPause = { [KEY]: { opens: 1, pausedMs: 120 * 60_000 } };
		const launched = await launch(cwd, item);
		assert.equal(
			launched.kind,
			"launched",
			"a capped run no longer waits for the pause",
		);
		assert.equal(item.run.providerPause[KEY].capReached, true);
		await failAttempt(cwd, item, {
			text: OVERLOAD,
			launchRetry: { attempts: 5, maxAttempts: 5, reason: "model" },
		});
		assert.equal(item.task.status, "failed", "old exhaustion");
		assert.equal(item.task.launchRetry.attempts, 6);
		assert.equal(item.task.providerPauseRefunds, undefined);
	});
});

test("the cap counts time spent paused, including the pause in progress", async () => {
	await withPause("120", async (cwd) => {
		await openPause(cwd);
		launchApi();
		const item = await pending(cwd);
		assert.equal((await launch(cwd, item)).kind, "capacity");
		assert.equal(item.run.providerPause[KEY].capReached, undefined);
		// 119 min already used + the pause in progress pushes the run over 120 min.
		item.run.providerPause[KEY].pausedMs = 119 * 60_000;
		item.run.providerPause[KEY].pausedSince = new Date(
			Date.now() - 2 * 60_000,
		).toISOString();
		assert.equal((await launch(cwd, item)).kind, "launched");
		assert.equal(item.run.providerPause[KEY].capReached, true);
	});
});

test("time a run spends stopped does not drain the cap; resume starts a fresh interval", async () => {
	await withPause("120", async (cwd) => {
		const [, , third] = await openPause(cwd);
		const { run } = third;
		// Paused at 10:00, the scheduler was last seen waiting at 10:01, the run was stopped
		// overnight and is resumed 9 hours later.
		const now = Date.now();
		const since = now - 9 * 3_600_000;
		const entry = run.providerPause[KEY];
		entry.pausedSince = new Date(since).toISOString();
		entry.pausedSeenAt = new Date(since + 60_000).toISOString();
		run.status = "interrupted";
		assert.equal(
			pause.providerPauseCapReached(run, now),
			false,
			"a stopped run counts its open interval only up to the last wait",
		);
		run.status = "running";
		pause.closeProviderPauseForResume(run);
		assert.equal(entry.pausedMs, 60_000, "only the minute it really waited");
		assert.equal(entry.pausedSince, undefined);
		assert.equal(pause.providerPauseCapReached(run, now), false);
		// The resumed run waits again: a fresh interval, still far from the cap.
		launchApi();
		const resumed = await launch(cwd, third);
		assert.equal(resumed.kind, "capacity");
		assert.ok(
			Date.parse(entry.pausedSince) >= now - 1_000,
			"the new interval starts at the resume",
		);
		assert.equal(entry.capReached, undefined);
		assert.equal(entry.pausedMs, 60_000);
	});
});

test("a waiting run refreshes its wait heartbeat and asks to be written once a minute", async () => {
	await withPause("120", async (cwd) => {
		const [, , third] = await openPause(cwd);
		launchApi();
		const key = pause;
		const gate = (at) =>
			key.providerPauseLaunchGate(
				third.run,
				third.task,
				KEY,
				{ acquire: false },
				at,
			);
		// The opener was seen waiting just now; two minutes later the heartbeat is due.
		const t0 = Date.now() + 120_000;
		const first = await gate(t0);
		assert.equal(first.kind, "wait");
		assert.equal(first.persist, true, "the first wait after a gap is written");
		assert.equal((await gate(t0 + 5_000)).persist, false);
		assert.equal((await gate(t0 + 30_000)).persist, false);
		const due = await gate(t0 + 61_000);
		assert.equal(due.persist, true, "the heartbeat is due");
		assert.equal(
			third.run.providerPause[KEY].pausedSeenAt,
			new Date(t0 + 61_000).toISOString(),
		);
	});
});

test("refunded attempts do not inflate the rate-limit backoff or the (n/max) text", async () => {
	await withPause("120", async (cwd) => {
		const plain = await pending(cwd);
		await failAttempt(cwd, plain, {
			failureKind: "rate_limit",
			text: "HTTP 429 rate limit",
		});
		const baseline = plain.task.launchRetry.retryAfterMs;
		assert.ok(baseline > 0, "a rate limit without a hint backs off");
		assert.match(plain.task.lastMessage, /\(1\/5\)/);
		await pause.removeProviderPauseStateForTests();
		// Three refunds already moved the attempt counter and the maximum by 3 each.
		const refunded = await pending(cwd);
		refunded.task.providerPauseRefunds = 3;
		await failAttempt(cwd, refunded, {
			failureKind: "rate_limit",
			text: "HTTP 429 rate limit",
			launchRetry: { attempts: 3, maxAttempts: 8, reason: "provider_pause" },
		});
		assert.equal(
			refunded.task.launchRetry.retryAfterMs,
			baseline,
			"the backoff exponent counts only the attempts really spent",
		);
		assert.equal(
			refunded.task.launchRetry.attempts,
			4,
			"attempt identity still moves",
		);
		assert.match(refunded.task.lastMessage, /\(1\/5\)/);
	});
});

test("off switch: AGENT_WORKFLOW_PROVIDER_PAUSE_MAX_MINUTES=0 keeps today's behavior exactly", async () => {
	await withPause("0", async (cwd) => {
		const items = [];
		for (let i = 0; i < 4; i += 1) {
			const item = await pending(cwd);
			await failAttempt(cwd, item, { text: OVERLOAD });
			items.push(item);
		}
		for (const item of items) {
			assert.equal(item.task.status, "pending");
			assert.equal(item.task.statusDetail, "retry_model_failure");
			assert.equal(
				item.task.launchRetry.attempts,
				1,
				"every failure spends an attempt",
			);
			assert.equal(item.task.providerPauseRefunds, undefined);
			assert.equal(item.run.providerPause, undefined);
		}
		assert.equal(
			existsSync(stateFile()),
			false,
			"no pause state is even written",
		);
		const exhausted = await pending(cwd);
		await failAttempt(cwd, exhausted, {
			text: OVERLOAD,
			launchRetry: { attempts: 5, maxAttempts: 5, reason: "model" },
		});
		assert.equal(exhausted.task.status, "failed");
		const fresh = await pending(cwd);
		launchApi();
		assert.equal((await launch(cwd, fresh)).kind, "launched");
		assert.equal(launches.length, 1);
	});
});

test("mid-stream and socket failures are not overload", async () => {
	await withPause("120", async (cwd) => {
		for (let i = 0; i < 6; i += 1) {
			const item = await pending(cwd);
			await failAttempt(cwd, item, { text: SOCKET, failureKind: "transient" });
			assert.equal(item.task.statusDetail, "retry_model_failure");
			assert.equal(item.task.launchRetry.attempts, 1);
		}
		assert.equal(existsSync(stateFile()), false);
	});
});

test("status shows one line while the run is paused, and a paused run is waiting, not stuck", async () => {
	await withPause("120", async (cwd) => {
		const [, , third] = await openPause(cwd);
		const { run } = third;
		run.status = "running";
		const line = pause.formatProviderPauseLine(run);
		assert.match(
			line,
			/^provider ovl overloaded: paused until \d\d:\d\dZ \(pause 1, 0 of 120 min\)$/,
		);
		const text = formatRun(run);
		assert.ok(text.includes(`⏳ ${line}`), text);
		// After the pause time is used up the line changes and keeps the budget visible.
		run.providerPause[KEY].pausedSince = new Date(
			Date.now() - 7 * 60_000,
		).toISOString();
		run.providerPause[KEY].openUntil = new Date(
			Date.now() - 60_000,
		).toISOString();
		assert.match(
			pause.formatProviderPauseLine(run),
			/paused, waiting for the probe \(pause 1, 7 of 120 min\)/,
		);
		// Resumed or capped runs show nothing.
		run.providerPause[KEY].capReached = true;
		assert.equal(pause.formatProviderPauseLine(run), undefined);
		run.providerPause[KEY].capReached = undefined;
		run.status = "completed";
		assert.equal(pause.formatProviderPauseLine(run), undefined);
	});
});
