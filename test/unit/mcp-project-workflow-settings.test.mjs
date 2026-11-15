import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import { projectId } from "../../dist/core/state-location.js";
import { projectWorkflowSettingsKey } from "../../dist/core/workflow-specs.js";
import {
	PROJECT_WORKFLOW_SETTINGS_SCHEMA,
	projectWorkflowSettingsPath,
	listProjectWorkflowSettings,
} from "../../dist/hosts/project-workflow-settings.js";

const TOOL = "workflow_project_settings";
async function fixture(t, seed = true) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "aw-mcp-local-recovery-")),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(root, "home") };
	const identity = { scope: "project-private", relativeSpec: "missing.json" };
	const key = projectWorkflowSettingsKey(identity);
	const intent = {
		defaults: { executor: "unknown", model: "keep" },
		slots: {
			removed: { executor: "unknown", model: "delete" },
			sibling: { executor: "pi", effort: "low" },
		},
	};
	const file = projectWorkflowSettingsPath(cwd, { env });
	if (seed) {
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(
			file,
			JSON.stringify({
				schema: PROJECT_WORKFLOW_SETTINGS_SCHEMA,
				storeEpoch: "epoch",
				workflows: {
					[key]: {
						identity,
						revision: "revision",
						definitionFingerprint: "a".repeat(64),
						intent,
					},
				},
			}),
			{ mode: 0o600 },
		);
	}
	const clients = [];
	// LIFO cleanup closes fake transports before removing their physical fixture.
	t.after(async () => {
		for (const client of clients) await client.close();
	});
	const connect = async (answer, capabilities = { elicitation: {} }) => {
		const requests = [];
		const client = await inProcessHostServer({
			root: cwd,
			env,
			onRequest: async (m) => {
				requests.push(m);
				return typeof answer === "function" ? answer(m) : answer;
			},
		});
		clients.push(client);
		await client.initialize("2025-06-18", capabilities);
		return { client, requests };
	};
	return {
		cwd,
		env,
		key,
		file,
		intent,
		connect,
		request: {
			op: "clear-binding",
			projectId: projectId(cwd),
			key,
			storeEpoch: "epoch",
			revision: "revision",
			binding: "slot",
			slot: "removed",
		},
	};
}

test("MCP local settings reads register separately and create nothing; unknown/client authority fields reject", async (t) => {
	const f = await fixture(t, false);
	const { client, requests } = await f.connect({ action: "accept" });
	const tools = await client.request("tools/list", {});
	const tool = tools.result.tools.find((v) => v.name === TOOL);
	assert.ok(tool);
	assert.equal(tool.inputSchema.additionalProperties, false);
	assert.ok(tools.result.tools.some((v) => v.name === "workflow_profile"));
	const listed = await client.call(TOOL, { op: "list" });
	assert.equal(listed.isError, false);
	assert.deepEqual(listed.structuredContent.data.affected.workflows, {});
	assert.equal(
		(await client.call(TOOL, { op: "show", key: f.key })).structuredContent.data
			.affected.revision,
		"absent",
	);
	assert.equal(requests.length, 0);
	for (const args of [
		{ ...f.request, confirm: true },
		{ op: "list", path: f.cwd },
		{ op: "list", projectId: "spoof" },
		{ op: "show", key: "../../outside" },
		{ op: "list", cwd: dirname(f.cwd) },
		{ ...f.request, intent: {} },
	]) {
		const result = await client.call(TOOL, args);
		assert.equal(result.isError, true, JSON.stringify(args));
	}
	await assert.rejects(stat(f.env.AGENT_WORKFLOW_HOME), { code: "ENOENT" });
});

test("MCP no-confirmation, decline, cancel and failed elicitation never mutate", async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.file);
	for (const [answer, capabilities, expected] of [
		[{ action: "accept" }, {}, "unsupported"],
		[{ action: "decline" }, { elicitation: {} }, "declined"],
		[{ action: "cancel" }, { elicitation: {} }, "cancelled"],
		[
			{ error: { code: -32603, message: "fixture error" } },
			{ elicitation: {} },
			"cancelled",
		],
	]) {
		const { client } = await f.connect(answer, capabilities);
		const result = await client.call(TOOL, f.request);
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.data.confirmation, expected);
		assert.equal(result.structuredContent.data.changed, false);
		assert.match(
			result.structuredContent.data.command,
			/project-settings.*clear-binding/,
		);
		assert.match(result.structuredContent.data.command, /--confirm-project/);
		assert.deepEqual(await readFile(f.file), before);
	}
});

test("MCP consent discloses exact project/key/value; selected clear preserves unrelated bindings", async (t) => {
	const f = await fixture(t);
	const shared = join(f.env.AGENT_WORKFLOW_HOME, "shared-sentinel");
	await writeFile(shared, "shared bytes");
	const { client, requests } = await f.connect({
		action: "accept",
		content: {},
	});
	const result = await client.call(TOOL, f.request);
	assert.equal(result.isError, false);
	assert.equal(requests.length, 1);
	const message = requests[0].params.message;
	for (const text of [
		f.request.projectId,
		f.key,
		"removed",
		"delete",
		"unknown",
	])
		assert.ok(message.includes(text), text);
	const listed = await listProjectWorkflowSettings(f.cwd, { env: f.env });
	assert.deepEqual(listed.workflows[f.key].intent, {
		defaults: f.intent.defaults,
		slots: { sibling: f.intent.slots.sibling },
	});
	assert.equal(await readFile(shared, "utf8"), "shared bytes");
	const bytes = await readFile(f.file);
	assert.equal((await client.call(TOOL, f.request)).isError, true);
	assert.equal(requests.length, 1, "stale request refused before confirmation");
	assert.deepEqual(await readFile(f.file), bytes);
	const { slot: _slot, ...defaultsRequest } = f.request;
	const cleared = await client.call(TOOL, {
		...defaultsRequest,
		binding: "defaults",
		revision: listed.workflows[f.key].revision,
	});
	assert.equal(cleared.isError, false);
	assert.deepEqual(
		(await listProjectWorkflowSettings(f.cwd, { env: f.env })).workflows[f.key]
			.intent,
		{ slots: { sibling: f.intent.slots.sibling } },
	);
});

test("MCP concurrent edit during confirmation conflicts instead of overwriting", async (t) => {
	const f = await fixture(t);
	let concurrent;
	const { client } = await f.connect(async () => {
		const data = JSON.parse(await readFile(f.file, "utf8"));
		data.workflows[f.key].revision = "new-revision";
		data.workflows[f.key].intent.defaults.model = "concurrent";
		concurrent = JSON.stringify(data);
		await writeFile(f.file, concurrent);
		return { action: "accept" };
	});
	assert.equal((await client.call(TOOL, f.request)).isError, true);
	assert.equal(await readFile(f.file, "utf8"), concurrent);
});

test("MCP reset/purge/whole clear and malformed recovery all require consent and fresh tokens", async (t) => {
	const f = await fixture(t);
	const { client, requests } = await f.connect({ action: "accept" });
	const read = async () =>
		(await client.call(TOOL, { op: "show", key: f.key })).structuredContent.data
			.affected;
	const scope = { projectId: f.request.projectId };
	assert.equal(
		(
			await client.call(TOOL, {
				op: "reset",
				...scope,
				key: f.key,
				storeEpoch: "epoch",
				revision: "revision",
			})
		).isError,
		false,
	);
	const current = await read();
	assert.deepEqual(current.entry.intent, {});
	assert.equal(
		(
			await client.call(TOOL, {
				op: "purge",
				...scope,
				key: f.key,
				storeEpoch: current.storeEpoch,
				revision: current.revision,
			})
		).isError,
		false,
	);
	const listed = (await client.call(TOOL, { op: "list" })).structuredContent
		.data.affected;
	assert.notEqual(listed.storeEpoch, current.storeEpoch);
	assert.equal(
		(
			await client.call(TOOL, {
				op: "clear-project",
				...scope,
				storeEpoch: listed.storeEpoch,
				rawDigest: listed.rawDigest,
			})
		).isError,
		false,
	);
	const raw = Buffer.from("{ broken MCP fixture\n");
	await writeFile(f.file, raw);
	assert.equal((await client.call(TOOL, { op: "list" })).isError, true);
	const inspected = (await client.call(TOOL, { op: "inspect-recovery" }))
		.structuredContent.data.affected;
	assert.equal(inspected.malformed, true);
	assert.equal(
		(
			await client.call(TOOL, {
				op: "recover",
				...scope,
				rawDigest: "0".repeat(64),
			})
		).isError,
		true,
	);
	assert.deepEqual(await readFile(f.file), raw);
	const result = await client.call(TOOL, {
		op: "recover",
		...scope,
		rawDigest: inspected.rawDigest,
	});
	assert.equal(result.isError, false);
	assert.deepEqual(
		await readFile(result.structuredContent.data.changed.backupPath),
		raw,
	);
	assert.equal(requests.length, 4);
	assert.match(requests[3].params.message, /malformed/);
});

test("MCP whole-project clear/recovery and entry reset/purge cannot bypass declined consent", async (t) => {
	const f = await fixture(t);
	const { client } = await f.connect({ action: "decline" });
	const listed = await listProjectWorkflowSettings(f.cwd, { env: f.env });
	const scope = { projectId: f.request.projectId };
	const bytes = await readFile(f.file);
	for (const op of ["reset", "purge"]) {
		const result = await client.call(TOOL, {
			op,
			...scope,
			key: f.key,
			storeEpoch: "epoch",
			revision: "revision",
		});
		assert.equal(result.structuredContent.data.confirmation, "declined");
		assert.deepEqual(await readFile(f.file), bytes);
	}
	const clear = await client.call(TOOL, {
		op: "clear-project",
		...scope,
		storeEpoch: listed.storeEpoch,
		rawDigest: listed.rawDigest,
	});
	assert.equal(clear.structuredContent.data.confirmation, "declined");
	assert.deepEqual(await readFile(f.file), bytes);
	const raw = Buffer.from("{ broken, retain me }");
	await writeFile(f.file, raw);
	const inspected = (await client.call(TOOL, { op: "inspect-recovery" }))
		.structuredContent.data.affected;
	const recover = await client.call(TOOL, {
		op: "recover",
		...scope,
		rawDigest: inspected.rawDigest,
	});
	assert.equal(recover.structuredContent.data.confirmation, "declined");
	assert.deepEqual(await readFile(f.file), raw);
});
