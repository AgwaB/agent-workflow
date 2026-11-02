// 2026-11-02 (quality A/B rerun, B6): a stage that needs a tool its executor cannot provide here is
// refused before the run starts — it would otherwise run without the tool and return a weaker result
// (Pi workers without `fetch_content` left 7–9 research claims unverified). The executor's probe
// names the tool, why it is missing and the fix; `doctor --fix` applies the one fixable case (a Pi web
// tool turned off in pi-web-access's own config) only after the user agreed.
// No model or agent-CLI calls: fake probers and a temporary config directory.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	negotiateWorkflowRun,
	WorkflowCapabilityError,
} from "../../dist/core/capability-negotiation.js";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { workflowExecutorRegistration } from "../../dist/core/index.js";
import { PI_EXECUTOR_TOOL_MAPPING } from "../../dist/executors/pi/argv.js";
import {
	enablePiWebTool,
	piCapabilities,
	piWebAccessConfigPath,
	piWebToolUnavailableGuidance,
} from "../../dist/executors/pi/index.js";
import { applyDoctorFix, doctorFixes } from "../../dist/hosts/api.js";

const roots = [];
after(async () => {
	for (const dir of roots)
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
});
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "aw-unavailable-tools-"));
	roots.push(dir);
	return dir;
}

const spec = (tools) => ({
	schemaVersion: 1,
	name: "web-probe",
	description: "probe",
	defaults: { agent: "researcher", readOnly: true },
	artifactGraph: {
		stages: [
			{
				id: "search",
				type: "single",
				prompt: "Search.",
				tools: ["read", "web_search"],
			},
			{
				id: "verify",
				type: "single",
				prompt: "Verify.",
				tools,
				after: ["search"],
			},
		],
	},
});

function negotiate(compiled, unavailableTools) {
	return negotiateWorkflowRun({
		descriptor: workflowExecutorRegistration("pi").descriptor,
		compiled,
		policy: {
			interactive: false,
			allowUnverified: [],
			strict: [],
			allowReadOnlyDowngrade: true,
			permissionMode: "free",
		},
		prober: async () => ({
			probe: {
				installed: true,
				cliVersion: "1.1.0",
				auth: "ok",
				notes: [],
				// As the real Pi probe reports when pi-web-access is installed.
				capabilities: {
					webTools: {
						level: "native",
						source: "probed",
						detail: "search+fetch",
						safetyPolicy: "unknown",
					},
				},
				...(unavailableTools === undefined ? {} : { unavailableTools }),
			},
			capabilities: piCapabilities(),
			toolMapping: PI_EXECUTOR_TOOL_MAPPING,
		}),
	});
}

test("a stage needing a tool the probe reports unavailable refuses the run before it starts, with the fix", async () => {
	const cwd = await temp();
	const compiled = await compileWorkflow(
		spec(["read", "web_search", "fetch_content"]),
		{
			cwd,
			task: "probe",
			permissionMode: "free",
		},
	);
	const reason = piWebToolUnavailableGuidance(
		"fetch_content",
		"/home/u/.pi/agent/web-search.json",
	);
	await assert.rejects(
		() => negotiate(compiled, { fetch_content: reason }),
		(error) => {
			assert(error instanceof WorkflowCapabilityError);
			assert.equal(error.code, "CAPABILITY_REFUSED");
			assert.match(
				error.message,
				/the run was not started and no task was launched/,
			);
			assert.match(
				error.message,
				/✗ verify\.main: executor pi cannot provide fetch_content here: pi-web-access is installed but does not register fetch_content: its configuration turns it off \(`tools\.fetchContent\.enabled` in \/home\/u\/\.pi\/agent\/web-search\.json\)\. Turn it on with `agent-workflow doctor --fix`/,
			);
			// The stage that only searches is not named.
			assert.doesNotMatch(error.message, /search\.main/);
			return true;
		},
	);
	// Nothing unavailable, or the stage does not ask for the tool: the run is accepted.
	await negotiate(structuredClone(compiled), undefined);
	const searchOnly = await compileWorkflow(spec(["read", "web_search"]), {
		cwd,
		task: "probe",
		permissionMode: "free",
	});
	await negotiate(searchOnly, { fetch_content: reason });
});

test("doctor --fix: only a Pi web tool turned off in pi-web-access's config is fixable; the fix flips that key", async () => {
	const dir = await temp();
	const env = { PI_CODING_AGENT_DIR: dir };
	const path = piWebAccessConfigPath(env);
	assert.equal(path, join(dir, "web-search.json"));
	const config = {
		someProviderApiKey: "k-not-touched",
		tools: { fetchContent: { enabled: false }, webSearch: { enabled: true } },
		toolActivation: "auto",
	};
	await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });

	const data = {
		executors: [
			{ id: "pi", unavailableTools: { fetch_content: "off", other_tool: "x" } },
			{ id: "codex", unavailableTools: { fetch_content: "n/a" } },
		],
	};
	const fixes = doctorFixes(data, env);
	assert.deepEqual(fixes, [
		{
			executor: "pi",
			tool: "fetch_content",
			description: `Turn on fetch_content in pi-web-access (set tools.fetchContent.enabled to true in ${path})`,
		},
	]);
	const result = await applyDoctorFix(fixes[0], env);
	assert.deepEqual(result, {
		changed: true,
		path,
		setting: "tools.fetchContent.enabled",
	});
	const after = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(after, {
		...config,
		tools: { ...config.tools, fetchContent: { enabled: true } },
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	// Nothing left to flip: reported, file unchanged.
	const again = await enablePiWebTool("fetch_content", env);
	assert.equal(again.changed, false);
	assert.match(again.reason, /no `enabled: false` setting for fetch_content/);
	// web_search off through the legacy switch.
	await writeFile(path, JSON.stringify({ webSearch: { enabled: false } }));
	assert.deepEqual(await enablePiWebTool("web_search", env), {
		changed: true,
		path,
		setting: "webSearch.enabled",
	});
	// No config file: nothing is created.
	const empty = { PI_CODING_AGENT_DIR: await temp() };
	const missing = await enablePiWebTool("fetch_content", empty);
	assert.equal(missing.changed, false);
	assert.match(missing.reason, /cannot be read \(ENOENT\)/);
});
