// agent-workflow 2026-11-01 (live finding): the experimental web quote check is decided once, at
// launch, and recorded as run.evidenceRefetch. In a live Claude run the stage ran in a process
// without the environment variable (the waiting CLI had taken over supervision) and reported "off"
// although the run was launched with AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH=1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	createWorkflowRunRecord,
	scheduleRun,
	writeStaticRunArtifacts,
} from "../helpers/unit-test-support.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const store = await import("../../dist/core/store.js");
const { compileWorkflow } = await import("../../dist/core/compiler.js");
const slots = await import("../../dist/core/launch-slots.js");
const { EVIDENCE_REFETCH_ENV } = await import(
	"../../dist/core/evidence-web-quotes.js"
);

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-evidence-flag-")));
	slots.setSubagentLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "codex",
				effectLog: join(root, "effects.jsonl"),
				probe: { installed: true, cliVersion: "1.0.0", auth: "ok" },
			}),
		),
	);
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	slots.setSubagentLaunchControlsForTests({});
	delete process.env[EVIDENCE_REFETCH_ENV];
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(
		join(cwd, "helpers/probe.mjs"),
		`export default async function probe({ context }) {
	return { schema: "probe-v1", digest: "probe", refetchEnabled: context.evidence?.refetchEnabled === true };
}
`,
	);
	await writeFile(
		join(cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "evidence-flag",
			artifactGraph: {
				stages: [{ id: "probe", support: { uses: "./helpers/probe.mjs" } }],
			},
		}),
	);
	return cwd;
}

function probeOutput(cwd, run) {
	const task = run.tasks.find((candidate) => candidate.stageId === "probe");
	return JSON.parse(
		readFileSync(
			join(
				cwd,
				".agent-workflow/workflows",
				run.runId,
				"tasks",
				task.taskId,
				"control.json",
			),
			"utf8",
		),
	);
}

test("the launch environment decides and is recorded on the run", async () => {
	for (const flag of [true, false]) {
		const cwd = await project();
		if (flag) process.env[EVIDENCE_REFETCH_ENV] = "1";
		else delete process.env[EVIDENCE_REFETCH_ENV];
		const started = await engine.runWorkflowSpec(join(cwd, "wf.json"), cwd, {
			task: "probe",
			executor: "codex",
		});
		const run = await engine.waitForRun(cwd, started.runId, 60_000);
		assert.equal(run.status, "completed");
		assert.equal(run.evidenceRefetch === true, flag);
		assert.equal(probeOutput(cwd, run).refetchEnabled, flag);
	}
});

test("a process driving the run later uses the recorded decision, not its own environment", async () => {
	for (const recorded of [true, false]) {
		const cwd = await project();
		// Launch-time decision recorded; this process's environment says the opposite.
		const spec = JSON.parse(readFileSync(join(cwd, "wf.json"), "utf8"));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "probe",
			specPath: "wf.json",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "wf.json"),
		);
		if (recorded) run.evidenceRefetch = true;
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await store.writeRunRecord(cwd, run);
		if (recorded) delete process.env[EVIDENCE_REFETCH_ENV];
		else process.env[EVIDENCE_REFETCH_ENV] = "1";
		await scheduleRun(cwd, run.runId);
		const finished = await engine.waitForRun(cwd, run.runId, 60_000);
		assert.equal(finished.status, "completed");
		assert.equal(probeOutput(cwd, finished).refetchEnabled, recorded);
	}
	delete process.env[EVIDENCE_REFETCH_ENV];
});
