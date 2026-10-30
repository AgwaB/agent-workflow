// WP43b: MCP URL consent keeps dashboard credentials out of model-visible tool results.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { registerWorkflowExecutor } from "../../dist/core/index.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import { startDashboardServer } from "../../dist/hosts/dashboard/server.js";
import {
	readDashboardDiscovery,
	mintLaunchUrl,
} from "../../dist/hosts/dashboard/discovery.js";
import {
	clientSupportsUrlElicitation,
	CONFIRMED_CHANGES,
} from "../../dist/mcp/host-server/index.js";
import { WORKFLOW_DASHBOARD_TOOL } from "../../dist/mcp/visible-names.js";
import { inProcessHostServer } from "../helpers/mcp-host-client.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

const clients = [],
	dashboards = [],
	roots = [],
	unregister = [];
setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
after(async () => {
	for (const client of clients) await client.close();
	for (const dashboard of dashboards) await dashboard.close();
	for (const undo of unregister) undo();
	for (const root of roots)
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
});
async function project({ start = true } = {}) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "aw-wp43b-mcp-")));
	roots.push(cwd);
	const env = {
		...process.env,
		AGENT_WORKFLOW_HOME: join(cwd, "home"),
		AGENT_WORKFLOW_ROLE: "supervisor",
	};
	const dashboard = start
		? await startDashboardServer({ cwd, env, discovery: true })
		: undefined;
	if (dashboard) dashboards.push(dashboard);
	return { cwd, env, dashboard };
}
async function connect(
	p,
	{
		capabilities = { elicitation: { form: {}, url: {} } },
		protocol = "2025-11-25",
		...options
	} = {},
) {
	const client = await inProcessHostServer({
		root: p.cwd,
		env: p.env,
		...options,
	});
	clients.push(client);
	const init = await client.initialize(protocol, capabilities);
	assert.equal(init.error, undefined);
	return client;
}
function noSecrets(result, dashboard, url) {
	const serialized = JSON.stringify(result);
	for (const secret of [
		dashboard.token,
		dashboard.launchKey,
		url,
		url && new URL(url).searchParams.get("token"),
	].filter(Boolean))
		assert.ok(
			!serialized.includes(secret),
			"tool result must not contain credentials or a launch URL",
		);
	assert.doesNotMatch(serialized, /token=|launchKey|sessionToken/);
}
const requests = (client) =>
	client.messages.filter((message) => message.method === "elicitation/create");

test("URL capability requires 2025-11-25 and explicit URL mode; dashboard is not a confirmed run change", {
	timeout: 15_000,
}, () => {
	assert.equal(WORKFLOW_DASHBOARD_TOOL, "workflow_dashboard");
	assert.ok(
		!CONFIRMED_CHANGES.some((change) =>
			change.includes(WORKFLOW_DASHBOARD_TOOL),
		),
	);
	for (const version of ["2024-11-05", "2025-03-26", "2025-06-18"])
		assert.equal(
			clientSupportsUrlElicitation(version, { elicitation: { url: {} } }),
			false,
		);
	for (const capabilities of [
		{},
		{ elicitation: {} },
		{ elicitation: { form: {} } },
	])
		assert.equal(
			clientSupportsUrlElicitation("2025-11-25", capabilities),
			false,
		);
	assert.equal(
		clientSupportsUrlElicitation("2025-11-25", { elicitation: { url: {} } }),
		true,
	);
});

test("URL accept: client bootstraps the real server once to the selected run; result has no secrets", {
	timeout: 15_000,
}, async () => {
	const p = await project();
	const run = "workflow_dashboard-test_1";
	let url, response;
	const client = await connect(p, {
		onRequest: async (message) => {
			url = message.params.url;
			response = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(2000),
			});
			await response.arrayBuffer();
			return { action: "accept" };
		},
	});
	const result = await client.call(WORKFLOW_DASHBOARD_TOOL, { run });
	assert.equal(result.isError, false);
	assert.equal(result.content[0].text, "Opened the dashboard in your browser.");
	assert.deepEqual(result.structuredContent, {
		running: true,
		port: p.dashboard.port,
		opened: true,
		method: "url-elicitation",
	});
	assert.equal(requests(client).length, 1);
	const { params } = requests(client)[0];
	assert.deepEqual(Object.keys(params).sort(), [
		"elicitationId",
		"message",
		"mode",
		"url",
	]);
	assert.equal(params.mode, "url");
	assert.match(params.elicitationId, /^[0-9a-f-]{36}$/);
	assert.equal(
		params.message,
		`Open the agent-workflow dashboard for ${basename(p.cwd)}?`,
	);
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), `/?run=${run}`);
	assert.match(response.headers.get("set-cookie"), /HttpOnly/);
	const replay = await fetch(url, {
		redirect: "manual",
		signal: AbortSignal.timeout(2000),
	});
	assert.equal(replay.status, 401);
	await replay.arrayBuffer();
	noSecrets(result, p.dashboard, url);
	// MCP 2025-11-25: once the browser signed in (token consumed) the server tells the client the
	// out-of-band step is complete, so it stops "waiting for completion".
	const complete = client.messages.find(
		(m) => m.method === "notifications/elicitation/complete",
	);
	assert.ok(complete, "notifications/elicitation/complete was sent");
	assert.equal(complete.params.elicitationId, params.elicitationId);
	assert.equal("id" in complete, false, "a notification, not a request");
});

for (const action of ["decline", "cancel", "error"]) {
	test(`URL ${action}: no fallback open and no secret echoed by the client`, {
		timeout: 15_000,
	}, async () => {
		const p = await project();
		let url;
		const client = await connect(p, {
			host: "claude-code",
			onRequest: (message) => {
				url = message.params.url;
				return action === "error"
					? {
							error: {
								code: -32603,
								message: `${url} ${p.dashboard.token} ${p.dashboard.launchKey}`,
							},
						}
					: { action };
			},
		});
		const result = await client.call(WORKFLOW_DASHBOARD_TOOL);
		assert.equal(result.isError, false);
		assert.deepEqual(result.structuredContent, {
			running: true,
			port: p.dashboard.port,
			opened: false,
			method: "url-elicitation",
		});
		assert.equal(result.content[0].text.split("\n").length, 1);
		assert.equal(requests(client).length, 1);
		noSecrets(result, p.dashboard, url);
		noSecrets(client.logs, p.dashboard, url);
		// It remains unused: neither the server nor a fallback opener consumed it.
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(2000),
		});
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "/");
		await response.arrayBuffer();
	});
}

for (const config of [
	{ capabilities: { elicitation: { form: {} } }, host: "codex" },
	{ capabilities: { elicitation: { url: {} } }, protocol: "2025-06-18" },
	{ capabilities: {} },
]) {
	test(`instructions only: ${JSON.stringify(config)}`, {
		timeout: 15_000,
	}, async () => {
		const p = await project();
		const client = await connect(p, config);
		const result = await client.call(WORKFLOW_DASHBOARD_TOOL);
		assert.equal(result.isError, false);
		assert.deepEqual(result.structuredContent, {
			running: true,
			port: p.dashboard.port,
			opened: false,
			method: "instructions",
		});
		assert.equal(
			result.content[0].text,
			`Dashboard is running on 127.0.0.1:${p.dashboard.port}; open it from a terminal with \`agent-workflow dashboard --open\` (project ${p.cwd})`,
		);
		assert.equal(requests(client).length, 0);
		assert.doesNotMatch(JSON.stringify(result), /https?:\/\//);
		noSecrets(result, p.dashboard);
	});
}

test("invalid ids, unknown arguments and restricted roles refuse before starting a dashboard", {
	timeout: 15_000,
}, async () => {
	const p = await project({ start: false });
	const client = await connect(p);
	for (const run of [
		"workflow_",
		"workflow_x/../y",
		" workflow_x",
		"workflow_x\n",
		"x",
		1,
		null,
	]) {
		const result = await client.call(WORKFLOW_DASHBOARD_TOOL, { run });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /run must/);
	}
	assert.equal(
		(await client.call(WORKFLOW_DASHBOARD_TOOL, { unexpected: true })).isError,
		true,
	);
	for (const role of ["worker", "disabled"]) {
		const restricted = await connect(p, {
			env: { ...p.env, AGENT_WORKFLOW_ROLE: role },
		});
		const result = await restricted.call(WORKFLOW_DASHBOARD_TOOL);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not allowed/);
		assert.equal(requests(restricted).length, 0);
	}
	assert.equal(await readDashboardDiscovery(p.cwd), undefined);
	assert.equal(requests(client).length, 0);
});

test("launch mint failure is an error without credentials or elicitation", {
	timeout: 15_000,
}, async () => {
	const p = await project();
	for (let n = 0; n < 16; n++) await mintLaunchUrl(p.dashboard);
	const client = await connect(p);
	const result = await client.call(WORKFLOW_DASHBOARD_TOOL);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Could not mint dashboard launch URL/);
	noSecrets(result, p.dashboard);
	assert.equal(requests(client).length, 0);
});

test("real workflow_run preserves the token-free dashboard link only while a dashboard runs", {
	timeout: 15_000,
}, async () => {
	const p = await project();
	await mkdir(join(p.cwd, ".agent-workflow/agents"), { recursive: true });
	await writeFile(
		join(p.cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nYou read and report.\n",
	);
	await writeFile(
		join(p.cwd, "wf.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "mcp-dashboard-fixture",
			defaults: { agent: "reader", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
			},
		}),
	);
	const executor = "wp43b-mcp-fixture";
	unregister.push(
		registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: executor,
				effectLog: join(p.cwd, "effects.jsonl"),
			}),
		),
	);
	const client = await connect(p, { capabilities: {} });
	for (const running of [true, false]) {
		if (!running) await p.dashboard.close();
		const result = await client.call("workflow_run", {
			workflow: "wf.json",
			task: `Dashboard running: ${running}`,
			executor,
			detach: false,
		});
		assert.equal(result.isError, false, result.content[0].text);
		const { runId, dashboard } = result.structuredContent.data;
		assert.ok(runId);
		if (running) {
			const url = `http://127.0.0.1:${p.dashboard.port}/?run=${runId}`;
			assert.ok(result.content[0].text.includes(`Dashboard: ${url}`));
			assert.deepEqual(dashboard, { url, port: p.dashboard.port });
		} else {
			assert.doesNotMatch(result.content[0].text, /Dashboard:/);
			assert.equal(dashboard, undefined);
		}
		noSecrets(result, p.dashboard);
		const waited = await client.call("workflow_wait", {
			runId,
			timeoutMs: 5000,
		});
		assert.equal(waited.structuredContent.data.terminal, true);
	}
});
