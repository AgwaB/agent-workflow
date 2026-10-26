// Conformance harness for the codex adapter (WP7). Offline: the adapter drives a stub `codex`
// (createStubCli) that replays app-server transcripts (recorded where available, see
// scenarios.mjs), or, for `mcp_tool`, a small fake app-server that really launches the injected
// MCP server from the thread config. Effects are counted from the stub's invocation log: an
// app-server launch carries the attempt digest in its `-c log_dir=…` argument.
// Live (`createCodexLiveHarness`): the real CLI with the user's login, gated by AGENT_WORKFLOW_LIVE=1.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStubCli } from "../../../../dist/sdk/conformance/index.js";
import {
	attemptDigest,
	createExecutor,
} from "../../../../dist/executors/codex/index.js";
import { stepsFromTranscript } from "./replay.mjs";
import { scenarioTranscript, SYNTHETIC } from "./scenarios.mjs";

export const CODEX_MODULE_PATH = fileURLToPath(
	new URL("../../../../dist/executors/codex/index.js", import.meta.url),
);
const FAKE_APP_SERVER = fileURLToPath(
	new URL("./fake-mcp-app-server.mjs", import.meta.url),
);

export const OFFLINE_SCENARIOS = [...Object.keys(SYNTHETIC), "mcp_tool"];

const PROBE_SCRIPTS = [
	{
		name: "version",
		when: { argvIncludes: ["--version"] },
		effect: false,
		steps: [{ stdout: "codex-cli 0.159.2" }],
	},
	{
		name: "login",
		when: { argvIncludes: ["login", "status"] },
		effect: false,
		steps: [{ stderr: "Logged in using ChatGPT" }],
	},
	{
		name: "models",
		when: { argvIncludes: ["debug", "models"] },
		effect: false,
		steps: [
			{
				stdout: {
					models: [
						{ slug: "gpt-5.6-luna", visibility: "list" },
						{ slug: "codex-auto-review", visibility: "hide" },
					],
				},
			},
		],
	},
];

function appServerScript(scenario) {
	if (scenario === "mcp_tool")
		return {
			name: "mcp_tool",
			when: { argvIncludes: ["app-server"] },
			// The stub only logs the launch; the fake app-server does the protocol work.
			steps: [],
		};
	const { entries } = scenarioTranscript(scenario);
	return {
		name: scenario,
		when: { argvIncludes: ["app-server"] },
		steps: stepsFromTranscript(entries),
	};
}

async function stageCli(dir, scenario) {
	const cli = await createStubCli({
		dir,
		name: "codex-stub",
		scripts: [...PROBE_SCRIPTS, appServerScript(scenario)],
	});
	if (scenario !== "mcp_tool") return { cli, codexPath: cli.path };
	// mcp_tool: a wrapper logs the launch through the stub (by running it with the same argv),
	// then execs the fake app-server.
	const wrapper = join(dir, "codex");
	await writeFile(
		wrapper,
		`#!/bin/sh\n${JSON.stringify(cli.path)} "$@" </dev/null >/dev/null 2>&1\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_APP_SERVER)} "$@"\n`,
		{ mode: 0o755 },
	);
	return { cli, codexPath: wrapper };
}

const forAttempt = (attemptKey) => (invocation) =>
	attemptKey === undefined ||
	invocation.argv.some((arg) => arg.includes(attemptDigest(attemptKey)));

export function codexConfig(codexPath, stateDir, scenario) {
	return {
		codexPath,
		stateDir,
		cancelGraceMs: 800,
		...(scenario === "crash_after_consume"
			? { testFaults: { crashAfterConsume: true } }
			: {}),
	};
}

export function createCodexStubHarness(options = {}) {
	const scenarios = options.scenarios ?? OFFLINE_SCENARIOS;
	return {
		name: "codex-stub-app-server",
		scenarios,
		async open(scenario) {
			const dir = await mkdtemp(join(tmpdir(), "aw-codex-stub-"));
			const { cli, codexPath } = await stageCli(dir, scenario);
			const config = codexConfig(codexPath, join(dir, "state"), scenario);
			const executors = [createExecutor(config)];
			return {
				executor: executors[0],
				effectCount: (attemptKey) => cli.effectCount(forAttempt(attemptKey)),
				launches: (attemptKey) => cli.launches(forAttempt(attemptKey)),
				async restart() {
					const next = createExecutor(config);
					executors.push(next);
					return next;
				},
				async dispose() {
					await rm(dir, { recursive: true, force: true });
				},
			};
		},
		async descriptor() {
			const dir = await mkdtemp(join(tmpdir(), "aw-codex-desc-"));
			return {
				descriptor: {
					id: "codex",
					version: "0.1.0",
					contractVersion: "0.1.0",
					module: CODEX_MODULE_PATH,
					config: {
						codexPath: join(dir, "codex"),
						stateDir: join(dir, "state"),
					},
				},
			};
		},
		async runtime(scenario, { workDir }) {
			await mkdir(workDir, { recursive: true });
			const { cli, codexPath } = await stageCli(workDir, scenario);
			return {
				descriptor: {
					id: "codex",
					version: "0.1.0",
					contractVersion: "0.1.0",
					module: CODEX_MODULE_PATH,
					config: codexConfig(codexPath, join(workDir, "state"), scenario),
				},
				effectCount: (attemptKey) => cli.effectCount(forAttempt(attemptKey)),
			};
		},
	};
}

/** Live harness: real `codex` on PATH with the user's login (never an isolated HOME). */
export function createCodexLiveHarness({ model, effort = "low", stateDir }) {
	return {
		name: "codex-live",
		scenarios: ["complete"],
		live: true,
		async open() {
			const executor = createExecutor({ stateDir });
			return { executor, effectCount: async () => 0 };
		},
		request(base) {
			return { ...base, model, effort };
		},
	};
}
