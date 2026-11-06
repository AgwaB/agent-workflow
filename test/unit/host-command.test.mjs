// Phase 4: the hook is a deterministic command boundary, not a model or shell interpreter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { registerWorkflowExecutor } from "../../dist/core/index.js";
import {
	listRunRecords,
	readRunRecord,
	writeRunRecord,
} from "../../dist/core/store.js";
import { projectId } from "../../dist/core/state-location.js";
import { setSubagentLaunchControlsForTests } from "../../dist/core/launch-slots.js";
import {
	handleHostCommand,
	parseHostCommand,
	recognizeHostCommand,
	runHostCommandHook,
} from "../../dist/hosts/host-command.js";
import { profileAction } from "../../dist/hosts/api.js";
import { runHostSessions } from "../../dist/hosts/notify-check.js";
import { dashboardProject } from "../helpers/dashboard-project.mjs";
import { drainWorkflowFixture } from "../helpers/workflow-fixture-lifecycle.mjs";
import {
	workflowFixtureDescriptor,
	readFixtureLog,
} from "../helpers/workflow-executor-fixture.mjs";
import { stateDir } from "../helpers/state-dir.mjs";
import * as plugins from "../../tools/release/plugins.mjs";

setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
const repo = resolve(import.meta.dirname, "../..");
const session = "aabbccdd-1122-3344-5566-aabbccddeeff";
let counter = 0;

for (const [host, forms, passing] of [
	[
		"claude-code",
		["/aw", "/agent-workflow:aw", " \t/aw", "\n/aw run wf one\ntwo"],
		["aw", "$aw", "/awesome", "/awful run wf t", "please /aw", "/aw:help"],
	],
	[
		"codex",
		[
			"$aw",
			"aw",
			" \t$aw",
			"aw dashboard",
			"aw run wf t",
			"aw dynamic t",
			"aw auto t",
			"aw stop abc",
			"$aw unknown",
			"\naw\nrun wf one\ntwo",
		],
		[
			"/aw",
			"awesome",
			"$awesome",
			"aw draw a box",
			"aw help",
			"please aw run wf t",
		],
	],
]) {
	test(`${host}: exact recognition, leading whitespace, JSON escapes and pass-through`, () => {
		for (const prompt of forms) {
			assert.ok(
				recognizeHostCommand(host, JSON.parse(JSON.stringify({ prompt }))),
				prompt,
			);
		}
		for (const prompt of passing)
			assert.equal(recognizeHostCommand(host, { prompt }), undefined, prompt);
		for (const input of [null, [], {}, { prompt: 123 }])
			assert.equal(recognizeHostCommand(host, input), undefined);
		const input = JSON.parse(
			'{"prompt":"' +
				(host === "codex" ? "$aw" : "/aw") +
				' run wf \\"quoted\\"\\nnext \\\\ path"}',
		);
		assert.equal(
			parseHostCommand(recognizeHostCommand(host, input).args).task,
			'"quoted"\nnext \\ path',
		);
	});
}

test("Claude expansion is limited to the aw slash command and preserves raw arguments", () => {
	for (const command_name of ["aw", "agent-workflow:aw"])
		assert.deepEqual(
			recognizeHostCommand("claude-code", {
				expansion_type: "slash_command",
				command_name,
				command_args: 'run wf "hello world"',
			}),
			{ args: 'run wf "hello world"', event: "expansion" },
		);
	for (const input of [
		{ expansion_type: "mcp_prompt", command_name: "aw" },
		{ expansion_type: "slash_command", command_name: "awesome" },
		{ expansion_type: "slash_command", command_name: "aw", command_args: [] },
	])
		assert.equal(recognizeHostCommand("claude-code", input), undefined);
	assert.equal(
		recognizeHostCommand("codex", {
			expansion_type: "slash_command",
			command_name: "aw",
		}),
		undefined,
	);
});

test("parser: actions, one quote pair, multiline tasks, no options, missing arguments and unknown action", () => {
	assert.deepEqual(parseHostCommand(""), { action: "help" });
	for (const task of ['"hello world"', "'hello world'", "hello world"])
		assert.deepEqual(parseHostCommand(`run wf ${task}`), {
			action: "run",
			workflow: "wf",
			task: "hello world",
		});
	assert.deepEqual(
		parseHostCommand('dynamic "say \\"hi\\"\nnext --force-new"'),
		{ action: "dynamic", task: 'say \\"hi\\"\nnext --force-new' },
	);
	assert.deepEqual(parseHostCommand("auto --yes --executor test-x"), {
		action: "auto",
		task: "--yes --executor test-x",
	});
	assert.deepEqual(parseHostCommand("dashboard workflow_abc"), {
		action: "dashboard",
		run: "workflow_abc",
	});
	assert.deepEqual(parseHostCommand("stop workflow_abc"), {
		action: "stop",
		run: "workflow_abc",
	});
	for (const text of [
		"run",
		"run wf",
		"run wf ''",
		"dynamic",
		"auto",
		"stop",
		"stop a b",
		"dashboard a b",
		"unknown",
	])
		assert.equal(parseHostCommand(text).action, "usage", text);
});

async function project(t, config = {}) {
	const fixture = await dashboardProject(t, "aw-host-command-");
	const { cwd } = fixture;
	const env = {
		...process.env,
		AGENT_WORKFLOW_ROLE: "supervisor",
		AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
		AGENT_WORKFLOW_HOST_WAKE: "0",
		BROWSER: "none",
	};
	await fixture.start({ discovery: true, env });
	await mkdir(join(cwd, ".agent-workflow/agents"), { recursive: true });
	await writeFile(
		join(cwd, ".agent-workflow/agents/reader.md"),
		"---\nname: reader\ndescription: reads and reports\ntools: read\n---\nRead and report.\n",
	);
	for (const name of ["hook-alpha", "hook-beta"]) {
		await mkdir(join(cwd, "workflows", name), { recursive: true });
		await writeFile(
			join(cwd, "workflows", name, "spec.json"),
			JSON.stringify({
				schemaVersion: 1,
				name,
				description: "Careful code review",
				routing: {
					useWhen: ["Use for a careful code review of a module."],
					outputs: ["A review report."],
				},
				defaults: { agent: "reader", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [{ id: "a", type: "single", prompt: "Collect facts." }],
				},
			}),
		);
	}
	const id = `test-host-command-${++counter}`;
	const effectLog = join(cwd, "effects.jsonl");
	fixture.dispose(
		registerWorkflowExecutor(
			workflowFixtureDescriptor(
				JSON.parse(
					JSON.stringify({
						id,
						effectLog,
						autoRecommend: "hook-alpha",
						stepDelayMs: 500,
						...config,
					}),
				),
			),
		),
	);
	// Hooks launch their own detached supervisors. Drain all of them before removing the project.
	fixture.dispose(async () => {
		for (const run of await listRunRecords(cwd))
			await drainWorkflowFixture(cwd, run.runId);
	});
	await profileAction(
		{ cwd, env },
		{
			op: "set",
			name: "hook-default",
			values: { executor: id },
			makeDefault: true,
		},
	);
	const invoke = (host, args, extra = {}, io = {}) =>
		handleHostCommand(
			host,
			{
				prompt: `${host === "codex" ? "$aw" : "/aw"} ${args}`,
				session_id: session,
				cwd,
				...extra,
			},
			{ cwd, env, ...io },
		);
	return { cwd, env, id, effectLog, invoke };
}

function runId(out) {
	assert.equal(out.decision, "block");
	assert.match(out.reason, /^agent-workflow: /);
	assert.ok(out.reason.length <= 1200);
	const id = out.reason.match(/workflow_[A-Za-z0-9_-]+/)?.[0];
	assert.ok(id, out.reason);
	return id;
}

for (const host of ["claude-code", "codex"]) {
	test(`${host}: run launches detached with profile defaults, links the session, and duplicates start nothing`, async (t) => {
		const { cwd, env, id, invoke } = await project(t);
		env.AGENT_WORKFLOW_HOST_WAKE = "1";
		const out = await invoke(
			host,
			'run hook-alpha "Review the parser --force-new"',
		);
		const launched = runId(out);
		assert.match(out.reason, new RegExp(`hook-alpha.*executor ${id}`));
		assert.match(out.reason, /You'll get the result here when it finishes\./);
		assert.match(
			out.reason,
			new RegExp(`project=${projectId(cwd)}&run=${launched}`),
		);
		assert.doesNotMatch(out.reason, /launchKey|token=/);
		assert.deepEqual(await runHostSessions(cwd, launched), [session]);
		assert.ok(
			existsSync(
				join(
					stateDir(cwd),
					".agent-workflow/workflows",
					launched,
					"supervise.log",
				),
			),
			"detached supervisor log created by the launch path",
		);
		const record = await readRunRecord(cwd, launched);
		assert.equal(record.launch.source, `mcp:${host}`);
		assert.equal(record.launch.entry.kind, "command");
		// Detached supervisors are durable children; no foreground wait happened in the hook.
		const duplicate = await invoke(
			host,
			'run hook-alpha "Review the parser --force-new"',
		);
		assert.equal(runId(duplicate), launched);
		assert.match(duplicate.reason, /existing|already|active/i);
		assert.equal(
			(await listRunRecords(cwd)).filter((r) => !r.parentRunId).length,
			1,
		);
	});

	test(`${host}: dynamic launches detached and is linked; stop resolves a prefix`, async (t) => {
		const { cwd, env, invoke } = await project(t);
		env.AGENT_WORKFLOW_HOST_WAKE = "1";
		const out = await invoke(host, "dynamic Review the parser");
		const id = runId(out);
		assert.match(out.reason, /dynamic/i);
		assert.ok(
			existsSync(
				join(stateDir(cwd), ".agent-workflow/workflows", id, "supervise.log"),
			),
		);
		assert.deepEqual(await runHostSessions(cwd, id), [session]);
		assert.equal((await readRunRecord(cwd, id)).launch.source, `mcp:${host}`);
		const stopped = await invoke(host, `stop ${id.slice(0, -3)}`);
		assert.match(stopped.reason, /stop|interrupt|settled/i);
		assert.ok(stopped.reason.includes(id), stopped.reason);
	});
}

test("Codex thread linking is disabled when host wake is disabled", async (t) => {
	const { cwd, invoke } = await project(t);
	const id = runId(await invoke("codex", "run hook-alpha Review code"));
	assert.deepEqual(await runHostSessions(cwd, id), []);
});

test("auto: injected classifier starts the top candidate and records command consent", async (t) => {
	const { cwd, env, invoke, effectLog } = await project(t);
	env.AGENT_WORKFLOW_HOST_WAKE = "1";
	const out = await invoke(
		"codex",
		"auto Do a careful code review of the parser module",
	);
	const id = runId(out);
	assert.match(out.reason, /Pick: hook-alpha/);
	assert.match(out.reason, /Reason: hook-alpha fits the supplied task/);
	assert.match(out.reason, /Other candidates: .*hook-beta/);
	const record = await readRunRecord(cwd, id);
	assert.equal(record.name, "hook-alpha");
	assert.equal(record.launch.selection.consent, "command");
	assert.equal(record.launch.selection.choseRecommendation, true);
	assert.deepEqual(await runHostSessions(cwd, id), [session]);
	assert.equal(
		readFixtureLog(effectLog).filter((e) => e.autoClassifier).length,
		1,
	);
});

test("auto: classifier failure starts nothing, never silently uses local ranking", async (t) => {
	const { cwd, invoke } = await project(t, {
		autoRecommend: undefined,
		stepDelayMs: 0,
	});
	const out = await invoke(
		"codex",
		"auto Do a careful code review of the parser module",
	);
	assert.equal(out.decision, "block");
	assert.match(
		out.reason,
		/unavailable|failed|No recommendation|No workflow has been started/i,
	);
	assert.equal((await listRunRecords(cwd)).length, 0);
});

test("help has six usage lines, three recent top-level runs, and a project URL without opening", async (t) => {
	const { cwd, invoke } = await project(t);
	for (let n = 0; n < 5; n++) {
		await writeRunRecord(cwd, {
			runId: `workflow_recent${n}`,
			name: `recent-${n}`,
			type: "workflow",
			status: "completed",
			createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
			updatedAt: new Date().toISOString(),
			tasks: [
				{
					taskId: "a-1",
					specId: "a",
					displayName: "a",
					agent: "reader",
					runtime: {},
					status: "completed",
					statusDetail: "completed",
					files: { output: "" },
				},
			],
			taskSummary: {
				total: 1,
				completed: 1,
				failed: 0,
				interrupted: 0,
				pending: 0,
				running: 0,
				blocked: 0,
				skipped: 0,
			},
			...(n === 4 ? { parentRunId: "workflow_recent0" } : {}),
		});
	}
	let opens = 0;
	const out = await invoke(
		"codex",
		"",
		{},
		{
			open: () => {
				opens++;
				return true;
			},
		},
	);
	assert.equal(
		out.reason.split("\n").filter((l) => /^(agent-workflow: )?aw\b/.test(l))
			.length,
		6,
	);
	assert.equal(out.reason.match(/workflow_recent/g)?.length, 3);
	assert.match(out.reason, /completed · recent-3 · workflow_recent3/);
	assert.doesNotMatch(out.reason, /workflow_recent[04]/);
	assert.match(out.reason, new RegExp(`project=${projectId(cwd)}`));
	assert.equal(opens, 0);
});

test("dashboard explicitly opens despite host suppression, resolving run prefix without leaking sign-in links", async (t) => {
	const { cwd, env, invoke } = await project(t);
	env.CLAUDECODE = "1";
	const id = runId(await invoke("codex", "run hook-alpha Review parser"));
	let opened;
	const out = await invoke(
		"codex",
		`dashboard ${id.slice(0, -3)}`,
		{},
		{
			open: (url) => {
				opened = url;
				return true;
			},
		},
	);
	assert.ok(opened);
	assert.match(out.reason, /Opened dashboard/);
	assert.match(out.reason, new RegExp(`project=${projectId(cwd)}&run=${id}`));
	assert.doesNotMatch(out.reason, /launchKey|token=/);
});

test("unknown action, bad run references and launch errors are bounded, redacted block reasons", async (t) => {
	const { env, invoke } = await project(t);
	assert.match(
		(await invoke("codex", "unknown")).reason,
		/aw dashboard \[run\]/,
	);
	assert.equal(
		(await invoke("claude-code", "run")).reason,
		"agent-workflow: aw run <workflow> <task…>",
	);
	assert.match(
		(await invoke("codex", "stop ../../outside")).reason,
		/invalid|not.*valid|safe/i,
	);
	env.MY_API_KEY = "a-secret-that-must-not-escape";
	const out = await invoke("codex", `run ${env.MY_API_KEY} task`);
	assert.doesNotMatch(out.reason, /a-secret-that-must-not-escape/);
	assert.match(out.reason, /REDACTED/);
	assert.ok(out.reason.length <= 1200);
	const long = await invoke("codex", `run ${"z".repeat(3000)} task`);
	assert.ok(long.reason.length <= 1200);
});

test("Claude cross-hook receipt prevents double handling in both orders, permits same-event retries", async (t) => {
	const { cwd, invoke } = await project(t);
	for (const first of ["submit", "expansion"]) {
		const args = `run hook-alpha Review ${first}`;
		const expansion = {
			expansion_type: "slash_command",
			command_name: "agent-workflow:aw",
			command_args: args,
		};
		const a = await invoke(
			"claude-code",
			args,
			first === "expansion" ? expansion : {},
		);
		const b = await invoke(
			"claude-code",
			args,
			first === "expansion" ? {} : expansion,
		);
		runId(a);
		assert.match(b.reason, /already handled/);
	}
	assert.equal(
		(await listRunRecords(cwd)).filter((r) => !r.parentRunId).length,
		2,
	);
	const receiptDir = join(stateDir(cwd), ".agent-workflow/host-command");
	const { readdir } = await import("node:fs/promises");
	const receipt = await readFile(
		join(receiptDir, (await readdir(receiptDir))[0]),
		"utf8",
	);
	assert.doesNotMatch(receipt, /Review|hook-alpha|aabbccdd/);
});

test("Claude receipt refuses symlinked state without writing outside or starting anything", async (t) => {
	const { cwd, invoke } = await project(t);
	const outside = join(cwd, "outside");
	await mkdir(outside);
	await mkdir(join(stateDir(cwd), ".agent-workflow"), { recursive: true });
	await symlink(outside, join(stateDir(cwd), ".agent-workflow/host-command"));
	const out = await invoke("claude-code", "run hook-alpha Do not start");
	assert.match(out.reason, /safely record/);
	assert.equal((await listRunRecords(cwd)).length, 0);
	assert.deepEqual(
		await import("node:fs/promises").then((fs) => fs.readdir(outside)),
		[],
	);
});

test("hook entry prints block JSON, stays silent for unrelated/malformed JSON, and returns zero", async () => {
	for (const [raw, handled] of [
		[JSON.stringify({ prompt: "$aw unknown" }), true],
		['{"prompt":"hi"}', false],
		["not json", false],
	]) {
		let stdout = "";
		const code = await runHostCommandHook("codex", {
			cwd: repo,
			env: process.env,
			stdin: (async function* () {
				yield raw;
			})(),
			stdout: (text) => {
				stdout += text;
			},
		});
		assert.equal(code, 0);
		if (handled) assert.equal(JSON.parse(stdout).decision, "block");
		else assert.equal(stdout, "");
	}
});

for (const host of ["claude-code", "codex"]) {
	test(`${host}: shell prefilter never starts the CLI for ordinary prompts; all recognized forms do`, async (t) => {
		const fixture = await dashboardProject(t, "aw-host-command-prefilter-");
		const marker = join(fixture.cwd, "cli-started");
		const cli = {
			command: "sh",
			args: ["-c", 'printf started > "$1"; cat', "marker", marker],
		};
		const command = plugins.hostCommandHookCommand(cli, host);
		const hook = (input) =>
			spawnSync("sh", ["-c", command], {
				cwd: fixture.cwd,
				input: JSON.stringify(input),
				encoding: "utf8",
			});
		const ordinary = [
			"hi",
			"draw a box",
			"please run /aw",
			"/awesome",
			"$awesome",
			'quote "prompt":"/aw run"',
		];
		if (host === "codex")
			ordinary.push("aw draw a box", "aw runaround", "aw help", "/aw");
		for (const prompt of ordinary) {
			const ran = hook({ prompt });
			assert.equal(ran.status, 0, ran.stderr);
			assert.equal(ran.stdout, "", prompt);
			assert.equal(existsSync(marker), false, prompt);
		}
		for (const prefix of host === "claude-code"
			? ["/aw", "/agent-workflow:aw"]
			: ["$aw", "aw"]) {
			for (const action of [
				"",
				"dashboard",
				"run wf 'hello'",
				"dynamic one\ntwo",
				"auto --yes",
				"stop workflow_abc",
			]) {
				for (const leading of ["", " \t\n"]) {
					const prompt = `${leading}${prefix}${action ? ` ${action}` : ""}`;
					const ran = hook({ prompt });
					assert.equal(ran.status, 0, ran.stderr);
					assert.ok(existsSync(marker), prompt);
					assert.deepEqual(
						JSON.parse(ran.stdout),
						{ prompt },
						"JSON is stdin, never shell code",
					);
					await import("node:fs/promises").then((fs) => fs.unlink(marker));
				}
			}
		}
		if (host === "claude-code") {
			const expansion = plugins.hostCommandHookCommand(cli, host, true);
			for (const command_name of ["aw", "agent-workflow:aw"]) {
				const ran = spawnSync("sh", ["-c", expansion], {
					input: JSON.stringify({
						expansion_type: "slash_command",
						command_name,
						command_args: 'dynamic "hi"\n$(touch injected)',
					}),
					encoding: "utf8",
					cwd: fixture.cwd,
				});
				assert.ok(existsSync(marker), ran.stderr);
				assert.equal(existsSync(join(fixture.cwd, "injected")), false);
			}
		}
	});
}

test("plugin manifests ship aw skill, command hooks, native timeout fields, and keep Claude completion delivery", () => {
	const launch = (host) => plugins.npxLaunch("0.1.0", host);
	const cli = plugins.npxCliLaunch("0.1.0");
	const claude = plugins.claudePluginManifest("0.1.0", launch, cli);
	const codex = plugins.codexPluginManifest("0.1.0", launch, cli);
	for (const [manifest, host] of [
		[claude, "claude-code"],
		[codex, "codex"],
	]) {
		const events = host === "codex" ? manifest.hooks.hooks : manifest.hooks;
		const hooks = events.UserPromptSubmit.flatMap((group) => group.hooks);
		const hook = hooks.find((h) => h.command.includes("host-command"));
		assert.equal(hook.type, "command");
		assert.equal(
			hook.timeout,
			300,
			"codex-rs protocol/hooks.rs serde rename = timeout",
		);
		assert.equal(hook.timeout_sec, undefined);
		assert.match(hook.command, new RegExp(`--host ${host}`));
		assert.match(hook.command, /grep -Eq/);
	}
	assert.deepEqual(
		Object.keys(codex.hooks),
		["hooks"],
		"codex-config HooksFile denies unknown fields; the event map must be nested",
	);
	assert.equal(claude.hooks.UserPromptExpansion[0].hooks[0].timeout, 300);
	assert.ok(
		claude.hooks.UserPromptSubmit[0].hooks.some((h) =>
			h.command.includes("notify-check"),
		),
	);
	assert.equal(claude.experimental.monitors[0].name, "run-completion");
	assert.ok(plugins.PLUGIN_SKILLS.includes("aw"));
	for (const tool of ["status", "dashboard", "run", "dynamic", "auto", "stop"])
		assert.ok(plugins.awSkill().includes(`workflow_${tool}`));
	assert.doesNotMatch(
		plugins.awSkill(),
		/open:true|open:false/,
		"fallback only uses valid MCP arguments",
	);
});
