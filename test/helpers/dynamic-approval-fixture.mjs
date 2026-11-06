import { stateDir } from "./state-dir.mjs";
// New in agent-workflow (WP29): a project whose workflow runs one executor-fixture stage (`prep`) and
// then a dynamic controller with `dynamic.permissions.approval: "ask"` (`adaptive`). The controller
// is a local helper module (no model call) that appends one line to `controller.log` per run, so
// tests see whether it ran; the fixture's effect log shows every executor submit (no relaunch of
// completed work).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	readFixtureLog,
	workflowFixtureDescriptor,
} from "./workflow-executor-fixture.mjs";

export const APPROVAL_SPEC = {
	schemaVersion: 1,
	name: "wp29-dynamic-approval",
	defaults: { agent: "reader", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "prep", type: "single", prompt: "Collect facts." },
			{
				id: "adaptive",
				type: "dynamic",
				dynamic: {
					uses: "./helpers/controller.mjs",
					permissions: { approval: "ask" },
				},
			},
		],
	},
};

export const CONTROLLER = "adaptive.controller";
export const APPROVAL_TITLE = "Run dynamic workflow controller?";

/**
 * Create the project under `root` and register its executor through `register` (the test's
 * `core.registerWorkflowExecutor`, whose undo the caller keeps).
 */
export async function approvalProject(root, name, register) {
	const cwd = join(root, name);
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await mkdir(join(cwd, "helpers"), { recursive: true });
	const controllerLog = join(cwd, "controller.log");
	await writeFile(
		join(cwd, "helpers", "controller.mjs"),
		`import { appendFileSync } from "node:fs";\nexport default async function controller() {\n\tappendFileSync(${JSON.stringify(controllerLog)}, "ran\\n");\n\treturn { control: { schema: "dynamic-controller-result-v1", summary: "approved" }, analysis: "approved", refs: [] };\n}\n`,
	);
	await writeFile(join(cwd, "wf.json"), `${JSON.stringify(APPROVAL_SPEC)}\n`);
	const executor = `test-wp29-${name}`;
	const effectLog = join(cwd, "effects.jsonl");
	register(workflowFixtureDescriptor({ id: executor, effectLog }));
	const env = { ...process.env };
	return {
		cwd,
		env,
		executor,
		/** How often the controller helper ran. */
		controllerRuns: async () =>
			(await readFile(controllerLog, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean).length,
		/** Executor submits (a relaunch of `prep` would add one). */
		submits: () =>
			readFixtureLog(effectLog).filter((entry) => entry.type === "submit")
				.length,
	};
}

/** The controller task of a run record. */
export function controllerTask(run) {
	return run.tasks.find((task) => task.specId === CONTROLLER);
}

/** The run's `approval.*` dynamic events. */
export async function approvalEvents(cwd, runId) {
	const text = await readFile(
		join(
			stateDir(cwd),
			".agent-workflow",
			"workflows",
			runId,
			"dynamic",
			"events.jsonl",
		),
		"utf8",
	).catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((event) => event.type.startsWith("approval."));
}
