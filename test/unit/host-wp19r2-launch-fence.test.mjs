import { stateDir } from "../helpers/state-dir.mjs";
// New in agent-workflow (WP19 round 2, re-review N1): the duplicate-launch lease fences execution,
// not only the claim file. Reviewer scenario: launch A is paused during profile selection, its
// lease expires (missed renewals / a suspended process), launch B arrives, then A resumes. Before
// the fix both started a run. Now an alive owner's expired claim is not taken over, and a launch
// whose claim was taken over anyway (owner believed dead) starts nothing at the execution-start
// fence. The workflow executor fixture makes no model or agent-CLI calls.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const api = await import("../../dist/hosts/api.js");
const core = await import("../../dist/core/index.js");
const guard = await import("../../dist/hosts/launch-guard.js");
const slots = await import("../../dist/core/launch-slots.js");

const DEAD_PID = 2 ** 22 + 4_321;
const SPEC = {
	schemaVersion: 1,
	name: "wp19r2-fence",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	executionProfiles: { fast: {} },
	artifactGraph: {
		stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
	},
};

before(() => {
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});

function defer() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

async function project(t) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-wp19r2-fence-")));
	const launched = [];
	const id = `wp19r2-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const undo = core.registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id,
			stepDelayMs: 3_000,
			effectLog: join(cwd, "effects.jsonl"),
		}),
	);
	const ctx = {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: join(cwd, "home") },
		host: "pi",
		defaultExecutor: id,
	};
	t.after(async () => {
		for (const runId of launched)
			await api.stopAction(ctx, { runId }).catch(() => undefined);
		undo();
		await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	});
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	await writeFile(join(cwd, "wf.json"), JSON.stringify(SPEC));
	const launch = async (extra) => {
		const result = await api.runWorkflowAction(ctx, {
			workflow: "wf.json",
			task: "same task",
			...extra,
		});
		if (result.data.runId) launched.push(result.data.runId);
		return result;
	};
	const runDirs = async () =>
		(
			await readdir(join(stateDir(cwd), ".agent-workflow", "workflows")).catch(
				() => [],
			)
		).filter((name) => name.startsWith("workflow_"));
	return { cwd, launch, runDirs };
}

/** Launch A, paused inside profile selection (after it claimed the fingerprint). */
async function pausedLaunch(launch) {
	const entered = defer();
	const resume = defer();
	const promise = launch({
		selectProfile: async () => {
			entered.resolve();
			await resume.promise;
			return "Profile: fast";
		},
	});
	await entered.promise;
	return { promise, resume: resume.resolve };
}

async function editClaim(cwd, edit) {
	const dir = guard.launchGuardDir(cwd);
	const [name] = (await readdir(dir)).filter((file) => file.endsWith(".json"));
	const path = join(dir, name);
	const claim = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify(edit(claim)));
}

test("N1: paused launch whose lease expired, then resumed → exactly one run", async (t) => {
	const { cwd, launch, runDirs } = await project(t);
	const a = await pausedLaunch(launch);
	// Reachable when this live process was suspended / its renewals failed for > 60 s.
	await editClaim(cwd, (claim) => ({
		...claim,
		leaseExpiresAt: new Date(Date.now() - 120_000).toISOString(),
	}));
	const second = launch({ selectProfile: async () => "Profile: fast" });
	await new Promise((done) => setTimeout(done, 400));
	a.resume();
	const [first, other] = await Promise.all([a.promise, second]);
	const ids = new Set(
		[first.data.runId, other.data.runId].filter((id) => id !== undefined),
	);
	assert.equal(ids.size, 1, `${first.outcome}/${other.outcome}: two runs`);
	assert.equal((await runDirs()).length, 1);
	assert.equal(first.outcome, "running", first.text);
	assert.equal(other.outcome, "existing", other.text);
});

test("N1: a launch whose claim was taken over starts nothing at the start fence", async (t) => {
	const { cwd, launch, runDirs } = await project(t);
	const a = await pausedLaunch(launch);
	// The owner looks dead (pid gone), so B takes the claim over and starts its run.
	await editClaim(cwd, (claim) => ({ ...claim, pid: DEAD_PID }));
	const second = await launch({ selectProfile: async () => "Profile: fast" });
	assert.equal(second.outcome, "running", second.text);
	a.resume();
	const first = await a.promise;
	assert.equal(
		(await runDirs()).length,
		1,
		"the displaced launch started a run",
	);
	assert.equal(first.outcome, "existing", first.text);
	assert.equal(first.data.runId, second.data.runId);
});
