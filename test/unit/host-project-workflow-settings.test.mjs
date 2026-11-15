// test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
	readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, after } from "node:test";
import * as api from "../../dist/hosts/api.js";
import * as actions from "../../dist/hosts/project-workflow-settings-actions.js";
import * as settings from "../../dist/hosts/project-workflow-settings.js";
import { runWorkflowSpec, waitForRun } from "../../dist/core/engine.js";
import { stateBase } from "../../dist/core/state-location.js";
import { setWorkerLaunchControlsForTests } from "../../dist/core/launch-slots.js";
before(() =>
	setWorkerLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 }),
);
after(() => setWorkerLaunchControlsForTests({}));
import { registerWorkflowExecutor } from "../../dist/core/executor-registry.js";
import {
	readRunRecord,
	flushPendingIndexUpdatesForTests,
} from "../../dist/core/store.js";
import { runAgentWorkflowCli } from "../../dist/hosts/cli/index.js";
import { createAgentWorkflowPiExtension } from "../../dist/hosts/pi/extension.js";
import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";
import { drainWorkflowProject } from "../helpers/workflow-fixture-lifecycle.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "aw-host-local-")));
	const cwd = join(root, "project");
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(root, "home"),
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
	};
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await mkdir(join(cwd, ".agent-workflow/workflows"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads\ntools: read\n---\nRead.\n",
	);
	const spec = {
		schemaVersion: 1,
		name: "local-host",
		routing: {
			useWhen: ["Use for reading local facts"],
			outputs: ["A facts report"],
		},
		defaults: { agent: "reader", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				{
					id: "read",
					type: "single",
					prompt: "Read.",
					model: "authored",
					effort: "low",
				},
			],
		},
	};
	const path = join(cwd, ".agent-workflow/workflows/local-host.json");
	await writeFile(path, JSON.stringify(spec));
	const undo = registerWorkflowExecutor(
		workflowFixtureDescriptor({
			id: "host-local",
			autoRecommend: "local-host",
			effectLog: join(root, "effects"),
		}),
	);
	const ctx = { cwd, env, host: "cli", defaultExecutor: "host-local" };
	t.after(async () => {
		await drainWorkflowProject(cwd);
		await flushPendingIndexUpdatesForTests();
		undo();
		if (!process.exitCode) await rm(root, { recursive: true, force: true });
	});
	const save = async (intent, ref = path) => {
		const { settings: current } =
			await actions.readProjectWorkflowSettingsAction(ctx, ref);
		return actions.saveProjectWorkflowSettingsAction(
			ctx,
			ref,
			intent,
			tokens(current),
		);
	};
	return { root, cwd, ctx, env, spec, path, save };
}
const tokens = ({
	storeEpoch,
	revision,
	definitionFingerprint,
	resolutionToken,
}) => ({ storeEpoch, revision, definitionFingerprint, resolutionToken });
const local = {
	defaults: { executor: "host-local", model: "local-model", effort: "high" },
};

async function wait(ctx, runId) {
	let result;
	do result = await api.waitAction(ctx, { runId, timeoutMs: 10000 });
	while (result.data.stillRunning);
	assert.equal(result.outcome, "completed", result.text);
	return readRunRecord(ctx.cwd, runId);
}

test("read, draft preview and common Check use compiler provenance without state creation", async (t) => {
	const p = await fixture(t);
	const got = await actions.readProjectWorkflowSettingsAction(p.ctx, p.path);
	assert.equal(got.settings.present, false);
	const preview = await actions.previewProjectWorkflowSettingsAction(
		p.ctx,
		p.path,
		local,
		tokens(got.settings),
	);
	assert.equal(
		preview.baseline.data.configuration.slots.read.model.value,
		"authored",
	);
	assert.equal(
		preview.check.data.configuration.slots.read.model.value,
		"local-model",
	);
	assert.equal(
		preview.check.data.configuration.slots.read.model.source,
		"project-default",
	);
	assert.equal(
		preview.check.data.configuration.slots.read.effort.requested,
		"high",
	);
	assert.equal(
		existsSync(p.env.AGENT_WORKFLOW_HOME),
		false,
		"all inspection is noncreating",
	);
	assert.equal(
		existsSync(stateBase(p.cwd)),
		false,
		"preflight creates neither run nor claim directories",
	);
	assert.equal(existsSync(join(p.root, "effects")), false);
	await p.save(local);
	const check = await api.checkWorkflowAction(p.ctx, {
		workflow: "local-host",
	});
	assert.deepEqual(
		check.data.configuration.slots,
		preview.check.data.configuration.slots,
	);
	const changed = await api.checkWorkflowAction(p.ctx, {
		workflow: p.path,
		model: "run-flag",
	});
	assert.equal(changed.data.configuration.slots.read.model.value, "run-flag");
});

test("CLI, MCP, Pi and common named launch consume project capture; history never rereads", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	const out = [],
		err = [];
	const code = await runAgentWorkflowCli(
		["run", p.path, "CLI local", "--json"],
		{
			cwd: p.cwd,
			env: p.env,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			isTTY: false,
		},
	);
	assert.equal(code, 0, err.join(""));
	const ids = [JSON.parse(out.join("")).data.runId];
	const client = await inProcessHostServer({ root: p.cwd, env: p.env });
	t.after(() => client.close());
	await client.initialize("2025-06-18");
	const mcp = await client.call("workflow_run", {
		workflow: p.path,
		task: "MCP local",
		detach: false,
	});
	assert.equal(mcp.isError, false, mcp.content[0].text);
	ids.push(mcp.structuredContent.data.runId);
	const tools = new Map();
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand() {},
		on() {},
		registerMessageRenderer() {},
		appendEntry() {},
	};
	createAgentWorkflowPiExtension({ api, env: p.env })(pi);
	const piResult = await tools
		.get("aw_run")
		.execute(
			"r",
			{ workflow: p.path, task: "Pi local" },
			undefined,
			undefined,
			{
				cwd: p.cwd,
				hasUI: false,
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [] },
			},
		);
	assert.equal(piResult.details.outcome, "running", piResult.content[0].text);
	ids.push(piResult.details.runId);
	const common = await api.runWorkflowAction(p.ctx, {
		workflow: "local-host",
		task: "Common local",
	});
	assert.equal(common.outcome, "running", common.text);
	ids.push(common.data.runId);
	await p.save({});
	for (const id of ids) {
		const record = await wait(p.ctx, id);
		assert.equal(record.configuration.slots.read.model.value, "local-model");
		assert.equal(
			record.configuration.capture.intent.defaults.model,
			"local-model",
		);
	}
});

test("aliases/path share source, projects isolate and malformed whole store fails closed", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	const a = await actions.readProjectWorkflowSettingsAction(
		p.ctx,
		"local-host",
	);
	const b = await actions.readProjectWorkflowSettingsAction(p.ctx, p.path);
	assert.equal(a.settings.key, b.settings.key);
	const other = join(p.root, "other");
	await mkdir(other);
	const isolated = await actions.readProjectWorkflowSettingsAction(
		{ ...p.ctx, cwd: other },
		p.path,
	);
	assert.equal(isolated.settings.present, false);
	const storePath = settings.projectWorkflowSettingsPath(p.cwd, { env: p.env });
	await writeFile(storePath, "{bad");
	for (const action of [api.checkWorkflowAction, api.runWorkflowAction])
		await assert.rejects(
			action(p.ctx, { workflow: p.path, task: "blocked" }),
			/settings|JSON|parse/i,
		);
	assert.equal(await readFile(storePath, "utf8"), "{bad");
	assert.equal(existsSync(join(p.root, "effects")), false);
});

test("capture including absence is frozen before declared chooser and duplicate identity", async (t) => {
	const p = await fixture(t);
	p.spec.executionProfiles = { one: {}, two: {} };
	await writeFile(p.path, JSON.stringify(p.spec));
	await p.save(local);
	const launched = await api.runWorkflowAction(p.ctx, {
		workflow: p.path,
		task: "chooser snapshot",
		selectProfile: async (_title, options) => {
			await p.save({ defaults: { executor: "host-local", model: "later" } });
			return options[0];
		},
	});
	assert.equal(launched.outcome, "running", launched.text);
	const record = await wait(p.ctx, launched.data.runId);
	assert.equal(
		record.configuration.capture.intent.defaults.model,
		"local-model",
	);
	await p.save({});
	const absent = await api.runWorkflowAction(p.ctx, {
		workflow: p.path,
		task: "empty snapshot",
		selectProfile: async (_title, options) => {
			await p.save(local);
			return options[0];
		},
	});
	assert.equal(absent.outcome, "running", absent.text);
	const legacy = await wait(p.ctx, absent.data.runId);
	assert.equal(
		legacy.configuration,
		undefined,
		"empty capture preserves legacy shape even after chooser edits",
	);
});

test("save validates real slots, supports removing retained orphan intent and CAS", async (t) => {
	const p = await fixture(t);
	const { settings: before } = await actions.readProjectWorkflowSettingsAction(
		p.ctx,
		p.path,
	);
	await assert.rejects(
		actions.saveProjectWorkflowSettingsAction(
			p.ctx,
			p.path,
			{ slots: { orphan: { executor: "host-local", model: "bad" } } },
			tokens(before),
		),
		/unknown|slot|target/i,
	);
	await p.save({ slots: { read: { executor: "host-local", model: "old" } } });
	p.spec.artifactGraph.stages[0].id = "renamed";
	await writeFile(p.path, JSON.stringify(p.spec));
	const orphan = await actions.readProjectWorkflowSettingsAction(p.ctx, p.path);
	assert.equal(orphan.settings.intent.slots.read.model, "old");
	await p.save({});
	await assert.rejects(
		actions.saveProjectWorkflowSettingsAction(
			p.ctx,
			p.path,
			local,
			tokens(before),
		),
		(error) => error.code === "PROJECT_WORKFLOW_SETTINGS_CONFLICT",
	);
	assert.equal(existsSync(join(p.root, "effects")), false);
});

test("CAS-only revisions and empty intent do not split duplicate identity; corrupting during guard cannot reread", async (t) => {
	for (const intent of [local, {}]) {
		const p = await fixture(t);
		p.spec.executionProfiles = { one: {}, two: {} };
		await writeFile(p.path, JSON.stringify(p.spec));
		await p.save(intent);
		let opened, release;
		const ready = new Promise((resolve) => {
			opened = resolve;
		});
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const first = api.runWorkflowAction(p.ctx, {
			workflow: p.path,
			task: "same identity",
			selectProfile: async (_title, options) => {
				opened();
				await gate;
				return options[0];
			},
		});
		await ready;
		await p.save(intent);
		const duplicate = await api.runWorkflowAction(p.ctx, {
			workflow: p.path,
			task: "same identity",
		});
		assert.equal(
			duplicate.data.refusal?.code,
			"DUPLICATE_LAUNCH_IN_PROGRESS",
			duplicate.text,
		);
		await writeFile(
			settings.projectWorkflowSettingsPath(p.cwd, { env: p.env }),
			"{corrupted-after-capture",
		);
		release();
		const launched = await first;
		assert.equal(launched.outcome, "running", launched.text);
		const record = await wait(p.ctx, launched.data.runId);
		if (intent.defaults)
			assert.equal(
				record.configuration.capture.intent.defaults.model,
				"local-model",
			);
		else assert.equal(record.configuration, undefined);
	}
});

test("spec-less direct dynamic Check ignores even a malformed project-local store", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	await writeFile(
		settings.projectWorkflowSettingsPath(p.cwd, { env: p.env }),
		"{bad",
	);
	const checked = await api.runDynamicAction(p.ctx, {
		task: "direct",
		preflightOnly: true,
		executor: "host-local",
	});
	assert.equal(checked.outcome, "success", checked.text);
	assert.equal(checked.data.configuration.capture, undefined);
	assert.equal(existsSync(join(p.root, "effects")), false);
});

test("named auto launches the selected catalog identity, not a temporary routing name", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	const selected = await api.autoAction(p.ctx, {
		task: "Read local facts and report",
	});
	assert.equal(selected.data.phase, "launched", selected.text);
	assert.equal(selected.data.selected.kind, "named-workflow");
	const record = await wait(p.ctx, selected.data.launch.runId);
	const { settings: current } = await actions.readProjectWorkflowSettingsAction(
		p.ctx,
		p.path,
	);
	assert.equal(record.configuration.capture.key, current.key);
	assert.equal(record.configuration.slots.read.model.value, "local-model");
});

test("separate native child Runs keep baseline inheritance without loading root local settings", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	const launched = await api.runWorkflowAction(p.ctx, {
		workflow: p.path,
		task: "parent",
	});
	const parent = await wait(p.ctx, launched.data.runId);
	await writeFile(
		settings.projectWorkflowSettingsPath(p.cwd, { env: p.env }),
		"{bad",
	);
	const child = await runWorkflowSpec(p.path, p.cwd, {
		task: "child",
		parentRunId: parent.runId,
		projectWorkflowSettings: parent.configuration.capture,
	});
	const terminal = await waitForRun(p.cwd, child.runId, { timeoutMs: 10000 });
	assert.equal(terminal.status, "completed");
	assert.equal(terminal.configuration, undefined);
	assert.equal(terminal.executor.id, "host-local");
	assert.equal(terminal.tasks[0].runtime.model, "authored");
});

test("trusted keyed actions can inspect and clear orphan entries without definition paths", async (t) => {
	const p = await fixture(t);
	await p.save(local);
	const { settings: before } = await actions.readProjectWorkflowSettingsAction(
		p.ctx,
		p.path,
	);
	await rm(p.path);
	const listed = await actions.listProjectWorkflowSettings(p.cwd, {
		env: p.env,
	});
	assert.equal(
		listed.workflows[before.key].intent.defaults.model,
		"local-model",
	);
	const orphan = await actions.readProjectWorkflowSettingsEntry(
		p.cwd,
		before.key,
		{ env: p.env },
	);
	const cleared = await actions.clearProjectWorkflowSettingsEntry(
		p.cwd,
		before.key,
		{ storeEpoch: orphan.storeEpoch, revision: orphan.revision },
		"reset",
		{ env: p.env },
	);
	assert.notEqual(cleared.revision, orphan.revision);
	assert.deepEqual(
		(
			await actions.readProjectWorkflowSettingsEntry(p.cwd, before.key, {
				env: p.env,
			})
		).entry.intent,
		{},
	);
});
