import { setImmediate as nextTurn } from "node:timers/promises";
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import {
	assert,
	existsSync,
	flushPendingIndexUpdatesForTests,
	launchWorkerTask,
	makeProject,
	makeWorkerLaunchFixture,
	rmSync,
	setTaskRuntimeApiForTests as setRawApi,
	setWorkerLaunchControlsForTests,
	test,
	writeAgent,
} from "../helpers/unit-test-support.mjs";
import { workerLaunchSlotStateForTests } from "../../dist/core/task-observability.js";

const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);

// Bound missing lifecycle events, not slot release latency. Teardown is joined,
// never timeout-raced, and Node's test runner still fails on unhandled rejections.
async function wait(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("observer test lifecycle watchdog")),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

for (const abortBeforeThrow of [false, true]) {
	test(`launch queue observer ${abortBeforeThrow ? "abort-then-throw" : "throw"} joins its waiter without releasing the held owner`, (t) => {
		const body = (async () => {
			const cwd = makeProject();
			const oldLaunchLimit = process.env.AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES;
			const oldLiveLimit = process.env.AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
			process.env.AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES = "1";
			delete process.env.AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
			const cleanup = new AbortController();
			const observerAbort = new AbortController();
			const ownerEntered = Promise.withResolvers();
			const releaseOwner = Promise.withResolvers();
			const pending = [];
			let settled = 0;
			const track = (promise) => {
				pending.push(promise);
				void promise.then(
					() => {
						settled += 1;
					},
					() => {
						settled += 1;
					},
				);
				return promise;
			};
			const launch = (suffix, signal) => {
				const fixture = makeWorkerLaunchFixture(cwd, suffix);
				return track(
					launchWorkerTask(
						cwd,
						fixture.run,
						fixture.task,
						fixture.compiledTask,
						signal,
						cleanup.signal,
					),
				);
			};
			const observerError = new assert.AssertionError({
				message: "queue observer assertion",
			});
			let observations = 0;
			let actions = 0;
			let launches = 0;
			setWorkerLaunchControlsForTests({
				releaseDelayMs: 0,
				retryJitterMs: 0,
				beforeRunWorker: () => {
					actions += 1;
				},
				onLaunchSlotQueued: () => {
					observations += 1;
					assert.deepEqual(workerLaunchSlotStateForTests(), {
						active: 1,
						queued: 1,
					});
					if (abortBeforeThrow)
						observerAbort.abort(new Error("observer cleanup abort"));
					throw observerError;
				},
			});
			try {
				assert.deepEqual(workerLaunchSlotStateForTests(), {
					active: 0,
					queued: 0,
				});
				writeAgent(cwd, "unit-scout", "read");
				setTaskRuntimeApiForTests({
					runWorker() {
						return track(
							(async () => {
								const id = ++launches;
								if (id === 1) {
									ownerEntered.resolve();
									await releaseOwner.promise;
								}
								return {
									runId: `run_observer_${id}`,
									attemptId: `attempt_observer_${id}`,
									status: "running",
								};
							})(),
						);
					},
				});
				const owner = launch("observer_owner");
				await wait(Promise.race([ownerEntered.promise, owner]));
				assert.equal(launches, 1);
				assert.equal(actions, 1);
				const rejected = launch("observer_rejected", observerAbort.signal);
				// The exact thrown assertion must win over either abort reason.
				await wait(
					assert.rejects(rejected, (error) => error === observerError),
				);
				assert.equal(observations, 1);
				const heldState = workerLaunchSlotStateForTests();
				assert.equal(launches, 1);
				assert.equal(actions, 1);
				releaseOwner.resolve();
				assert.deepEqual(await wait(owner), { kind: "launched" });
				const joinedState = workerLaunchSlotStateForTests();
				t.diagnostic(
					`held=${JSON.stringify(heldState)} owner-joined=${JSON.stringify(joinedState)}`,
				);
				// Flush an event-loop turn so abandoned promise rejection is reported
				// within this test as well as by the runner's post-test guard.
				await nextTurn();
				assert.deepEqual(heldState, { active: 1, queued: 0 });
				assert.deepEqual(joinedState, { active: 0, queued: 0 });
				assert.deepEqual(await wait(launch("observer_successor")), {
					kind: "launched",
				});
				assert.equal(launches, 2);
				assert.equal(actions, 2);
				assert.equal(observations, 1);
				assert.deepEqual(workerLaunchSlotStateForTests(), {
					active: 0,
					queued: 0,
				});
			} finally {
				cleanup.abort(new Error("observer test cleanup"));
				releaseOwner.resolve();
				for (let i = 0; i < pending.length; i++)
					await Promise.allSettled([pending[i]]);
				await flushPendingIndexUpdatesForTests();
				await nextTurn();
				assert.equal(settled, pending.length);
				assert.ok(existsSync(cwd));
				console.log(`DRAIN_BEFORE_DELETE ${settled}/${pending.length}`);
				setTaskRuntimeApiForTests(undefined);
				setWorkerLaunchControlsForTests({
					releaseDelayMs: 0,
					retryJitterMs: 0,
				});
				if (oldLaunchLimit === undefined)
					delete process.env.AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES;
				else
					process.env.AGENT_WORKFLOW_MAX_CONCURRENT_LAUNCHES = oldLaunchLimit;
				if (oldLiveLimit === undefined)
					delete process.env.AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
				else process.env.AGENT_WORKFLOW_MAX_LIVE_MODEL_WORKERS = oldLiveLimit;
				rmSync(cwd, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 10,
				});
			}
		})();
		// An unhandled rejection can make the runner finish a failing test
		// early. Its after hook must still join the body before suite teardown.
		t.after(async () => {
			await Promise.allSettled([body]);
		});
		return body;
	});
}
