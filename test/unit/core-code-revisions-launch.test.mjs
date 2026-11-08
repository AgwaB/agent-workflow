// agent-workflow 2026-11-08 (X1): a launched run persists its code revisions; a nested run keeps
// the launch's view instead of reading the repository again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withMaterializedRawHost } from "../helpers/raw-host-fixture.mjs";
import {
	makeProject,
	readRunRecord,
	runWorkflowSpec,
	setTaskRuntimeApiForTests as setRawApi,
	workflowSpec,
	writeAgent,
} from "../helpers/unit-test-support.mjs";

const setTaskRuntimeApiForTests = withMaterializedRawHost(setRawApi);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cleanEnv = () => {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("GIT_")) delete env[key];
	return env;
};
const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		env: cleanEnv(),
		encoding: "utf8",
	}).trim();

test("a launched run records code revisions and a nested run reuses them", async (t) => {
	const cwd = makeProject();
	t.after(() => {
		setTaskRuntimeApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	});
	writeAgent(cwd, "unit-scout", "read");
	writeFileSync(
		join(cwd, "workflow.json"),
		JSON.stringify(workflowSpec("unit-scout")),
	);
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", "fixture");
	setTaskRuntimeApiForTests({
		async runWorker() {
			return {
				runId: "run_code_rev",
				attemptId: "attempt_code_rev",
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

	const run = await runWorkflowSpec("workflow.json", cwd, {
		task: "Check revisions",
	});
	const revisions = run.codeRevisions;
	assert.ok(revisions, "run.codeRevisions");
	assert.equal(revisions.target.repository, true);
	assert.equal(revisions.target.head, git(cwd, "rev-parse", "HEAD"));
	assert.equal(revisions.target.branch, "main");
	assert.equal(typeof revisions.target.statusSha256, "string");
	const version = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	).version;
	assert.equal(revisions.engine.version, version);
	assert.deepEqual(
		(await readRunRecord(cwd, run.runId)).codeRevisions,
		revisions,
	);

	writeFileSync(join(cwd, "later.txt"), "changed after launch\n");
	const nested = await runWorkflowSpec("workflow.json", cwd, {
		task: "Nested",
		parentRunId: run.runId,
	});
	assert.deepEqual(nested.codeRevisions, revisions);
});
