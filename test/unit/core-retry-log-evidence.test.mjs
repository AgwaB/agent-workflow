// test-tier: integration
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import {
	assert,
	launchWorkerTask,
	makeProject,
	makeWorkerLaunchFixture,
	rmSync,
	setTaskRuntimeApiForTests as setRawApi,
	test,
	writeAgent,
} from "../helpers/unit-test-support.mjs";
import { copyLogOrEmpty } from "../../dist/core/task-artifacts.js";

const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);

test("launching a retry keeps the failed attempt's hard-linked original logs intact", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const fixture = makeWorkerLaunchFixture(cwd, "retry_evidence");
		const attemptDir = join(cwd, ".fake-attempt-1");
		mkdirSync(attemptDir, { recursive: true });
		const original = {
			"output.log": "partial answer\n",
			"stderr.log": "503 busy\n",
		};
		for (const [name, bytes] of Object.entries(original))
			writeFileSync(join(attemptDir, name), bytes);
		const snapshot = { logs: [{ artifactCwd: cwd }] };
		const { fromStatePath } = await import("../../dist/core/store.js");
		for (const name of Object.keys(original)) {
			const target = fromStatePath(
				cwd,
				name === "output.log"
					? fixture.task.files.output
					: fixture.task.files.stderr,
			);
			mkdirSync(dirname(target), { recursive: true });
			await copyLogOrEmpty(
				snapshot,
				{ path: `.fake-attempt-1/${name}`, artifactCwd: cwd },
				target,
				undefined,
			);
			// The real link path was taken: both names are one inode.
			assert.equal(statSync(target).ino, statSync(join(attemptDir, name)).ino);
		}
		setTaskRuntimeApiForTests({
			async runWorker() {
				return {
					runId: "run_retry",
					attemptId: "attempt_2",
					status: "running",
				};
			},
		});
		const launched = await launchWorkerTask(
			cwd,
			fixture.run,
			fixture.task,
			fixture.compiledTask,
		);
		assert.equal(launched.kind, "launched");
		for (const [name, bytes] of Object.entries(original)) {
			assert.equal(readFileSync(join(attemptDir, name), "utf8"), bytes);
			const target = fromStatePath(
				cwd,
				name === "output.log"
					? fixture.task.files.output
					: fixture.task.files.stderr,
			);
			assert.equal(readFileSync(target, "utf8"), "");
		}
	} finally {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});
