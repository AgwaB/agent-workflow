// test-tier: integration
// agent-workflow 2026-11-23 (skill-helper-api): the "Support helpers" block of skills/workflow-guide/SKILL.md lists
// the `context.*` members, the `sourceStatuses` row fields and the source keys a support helper sees, so authors need
// not read docs/usage.md. This test parses that block and runs a real support stage (fake executor, no model) that
// records what it was given, so the block cannot drift from the helper runtime.
import assert from "node:assert/strict";
import {
	readFile,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const core = await import("../../dist/core/index.js");
const engine = await import("../../dist/core/engine.js");
const slots = await import("../../dist/core/launch-slots.js");

const SKILL = new URL("../../skills/workflow-guide/SKILL.md", import.meta.url);
const PLUGIN_SKILL = new URL(
	"../../plugins/agent-workflow/skills/workflow-guide/SKILL.md",
	import.meta.url,
);

async function helperBlock(url) {
	const text = await readFile(url, "utf8");
	const start = text.indexOf("\n## Support helpers\n");
	assert.notEqual(start, -1, "the skill has a Support helpers section");
	const end = text.indexOf("\n## ", start + 1);
	return text.slice(start, end);
}

/** Backticked plain identifiers of one bullet (`cwd`, `stateCwd`, …), minus words that are not members. */
function identifiers(bullet, notMembers = []) {
	return [...bullet.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/gu)]
		.map((match) => match[1])
		.filter((name) => !notMembers.includes(name));
}

function bullet(block, startsWith) {
	const found = block.split("\n").find((line) => line.startsWith(startsWith));
	assert.ok(found, `the block has a bullet starting ${startsWith}`);
	return found;
}

let root;
let probe;
const unregister = [];
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-helper-api-")));
	slots.setWorkerLaunchControlsForTests({
		releaseDelayMs: 0,
		retryJitterMs: 0,
	});
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await mkdir(join(cwd, "schemas"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow", "agents", "reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou report.\n",
	);
	const record = join(root, "probe.json");
	await writeFile(
		join(cwd, "helpers", "probe.mjs"),
		`import { writeFileSync } from "node:fs";
export default async function probe({ sources, options, context }) {
	writeFileSync(${JSON.stringify(record)}, JSON.stringify({
		arguments: Object.keys(arguments[0]),
		options,
		sourceKeys: Object.keys(sources),
		context: Object.fromEntries(Object.entries(context).map(([key, value]) => [key, typeof value])),
		rows: context.sourceStatuses,
	}));
	return { schema: "probe-v1", digest: "probed", markdown: "# Probe", extra: true };
}
`,
	);
	await writeFile(
		join(cwd, "schemas", "closed.json"),
		JSON.stringify({
			type: "object",
			required: ["schema", "digest"],
			properties: {
				schema: { const: "probe-v1" },
				digest: { type: "string", maxLength: 100 },
			},
			additionalProperties: false,
		}),
	);
	const specPath = join(cwd, "workflow.json");
	await writeFile(
		specPath,
		JSON.stringify({
			schemaVersion: 1,
			name: "helper-api",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{ id: "plan", type: "single", after: [], prompt: "Plan the items." },
					{ id: "bad", type: "single", after: [], prompt: "Fail." },
					{
						id: "work",
						type: "foreach",
						from: { source: "plan", path: "$.items" },
						each: { prompt: "Work ${item}.", itemIdentityPath: "$.id" },
					},
					{
						id: "probe",
						from: ["plan", "work", "bad"],
						sourcePolicy: "partial",
						support: { uses: "./helpers/probe.mjs", options: { marker: 1 } },
						output: { controlSchema: "./schemas/closed.json" },
					},
				],
			},
		}),
	);
	const id = "wf-helper-api";
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id,
				effectLog: join(root, "effects.jsonl"),
				// task-1 = plan, task-2 = bad (declared order)
				failures: {
					"task-2": [{ class: "permanent", message: "the model refused" }],
				},
				controlSequence: {
					"task-1": [
						{
							schema: "plan-v1",
							digest: "two",
							items: [{ id: "a" }, { id: "b" }],
						},
					],
				},
			}),
		),
	);
	const started = await engine.runWorkflowSpec(specPath, cwd, {
		task: "t",
		executor: id,
	});
	const run = await engine.waitForRun(cwd, started.runId, 90_000);
	const task = run.tasks.find((candidate) => candidate.stageId === "probe");
	probe = {
		run,
		task,
		record: await readFile(record, "utf8").then(JSON.parse, () => undefined),
	};
});
after(async () => {
	for (const undo of unregister.splice(0)) undo();
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("the Support helpers block names the arguments, context members and row fields the runtime provides", async () => {
	assert.ok(probe.record, "the probe helper ran");
	for (const url of [SKILL, PLUGIN_SKILL]) {
		const block = await helperBlock(url);
		assert.match(
			block,
			/async function helper\(\{ sources, options, context \}\)/u,
		);
		for (const name of ["sources", "options", "context"]) {
			assert.ok(
				probe.record.arguments.includes(name),
				`helper argument ${name}`,
			);
		}

		const members = identifiers(bullet(block, "- Other `context` members:"), [
			"AbortSignal",
			"context",
		]);
		assert.ok(members.length >= 8, `members parsed: ${members.join(",")}`);
		for (const member of [
			"cwd",
			"stateCwd",
			"runId",
			"taskId",
			"stageId",
			"specPath",
			"signal",
			"evidence",
		]) {
			assert.ok(members.includes(member), `the block names context.${member}`);
		}
		for (const member of [...members, "sourceStatuses"]) {
			assert.ok(
				member in probe.record.context,
				`context.${member} exists in the helper runtime`,
			);
		}

		const rowLine = bullet(block, "- `context.sourceStatuses`:");
		const rowFields = identifiers(rowLine.split("Collect items")[0], [
			"sources",
		]);
		assert.ok(
			rowFields.length >= 6,
			`row fields parsed: ${rowFields.join(",")}`,
		);
		const seen = new Set(probe.record.rows.flatMap((row) => Object.keys(row)));
		for (const field of rowFields)
			assert.ok(seen.has(field), `a sourceStatuses row carries ${field}`);

		const sourceLine = bullet(block, "- `sources`:");
		assert.match(sourceLine, /first item, which takes the bare stage id/u);
	}
});

test("sources are keyed as the block says: bare stage id for single and first foreach item, then <stage>.<item>; failed sources absent", () => {
	assert.equal(
		probe.task.status,
		"failed",
		"the closed schema rejects the undeclared keys the helper returned",
	);
	const keys = probe.record.sourceKeys;
	assert.ok(keys.includes("plan"), keys.join());
	assert.ok(keys.includes("work"), keys.join());
	assert.ok(
		keys.some((key) => key.startsWith("work.")),
		keys.join(),
	);
	assert.equal(
		keys.includes("bad"),
		false,
		"a failed source is absent from sources",
	);
	const rows = probe.record.rows;
	const bad = rows.find((row) => row.stageId === "bad");
	assert.equal(bad.status, "failed");
	assert.ok(
		typeof bad.errorType === "string" && typeof bad.lastMessage === "string",
	);
	const items = rows.filter(
		(row) => row.stageId === "work" && row.itemIdentity !== undefined,
	);
	assert.deepEqual(items.map((row) => row.itemIdentity).sort(), ["a", "b"]);
	for (const row of items)
		assert.ok(row.source in Object.fromEntries(keys.map((key) => [key, 1])));
	assert.deepEqual(probe.record.options, { marker: 1 });
});
