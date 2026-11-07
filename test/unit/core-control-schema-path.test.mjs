import { stateDir } from "../helpers/state-dir.mjs";
import { drainWorkflowProject } from "../helpers/workflow-fixture-lifecycle.mjs";
// New in agent-workflow (WP12a, live bundle 3 open problem 3): the compiler's output protocol tells
// the worker to validate its control against "the workflow-local control schema file:
// ./schemas/…", a path relative to the workflow bundle that does not resolve from the worker's
// cwd (the project): Pi and Codex spec-review workers reported ENOENT as a needsHuman row. The
// task prompt sent to the executor now names the run's copy of the schema by absolute path; the
// canonical task.md (launch provenance digests it) keeps the compiled text.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";
import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

let root;
const unregister = [];

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wp12a-schema-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
});
after(async () => {
	await drainWorkflowProject(join(root, "project"));
	for (const undo of unregister.splice(0)) undo();
	slots.setWorkerLaunchControlsForTests({});
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("the executor prompt names the control schema by a path that resolves from the worker cwd", async () => {
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const bundle = join(root, "bundle");
	await mkdir(join(bundle, "schemas"), { recursive: true });
	await writeFile(
		join(bundle, "schemas", "a-control.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["schema", "digest"],
			properties: { schema: { type: "string" }, digest: { type: "string" } },
		}),
	);
	const specPath = join(bundle, "spec.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "wp12a-schema",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{
						id: "a",
						type: "single",
						prompt: "Collect facts.",
						output: { controlSchema: "./schemas/a-control.schema.json" },
					},
				],
			},
		}),
	);
	const effectLog = join(root, "effects.jsonl");
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "wf-wp12a-schema",
				effectLog,
				logPrompt: true,
			}),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "schema path",
		executor: "wf-wp12a-schema",
	});
	const run = await engine.waitForRun(cwd, started.runId, 60_000);
	assert.equal(run.status, "completed", JSON.stringify(run.tasks, null, 2));

	const [submit] = readFixtureLog(effectLog).filter((e) => e.type === "submit");
	const match = /workflow-local control schema file: (\S+)/.exec(submit.prompt);
	assert.ok(match, submit.prompt);
	const schemaPath = match[1];
	assert.ok(isAbsolute(schemaPath), schemaPath);
	assert.ok(existsSync(schemaPath), `${schemaPath} does not resolve`);
	assert.match(schemaPath, /\/bundle\/schemas\/a-control\.schema\.json$/);
	assert.doesNotMatch(submit.prompt, /\.\/schemas\//);
	assert.equal(
		JSON.parse(readFileSync(schemaPath, "utf8")).required.join(","),
		"schema,digest",
	);

	// The canonical prompt file keeps the compiled (bundle-relative) text.
	const task = run.tasks.find((item) => item.files?.taskPrompt);
	const canonical = await readFile(
		join(stateDir(cwd), task.files.taskPrompt),
		"utf8",
	);
	assert.match(
		canonical,
		/workflow-local control schema file: \.\/schemas\/a-control\.schema\.json/,
	);
});
