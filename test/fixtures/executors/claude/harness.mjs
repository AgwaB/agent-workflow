// Conformance harnesses for the Claude executor (WP8).
// - Offline: the kit's stub CLI replays scrubbed live transcripts (transcripts/*.jsonl, recorded with
//   claude-code 2.1.310) in Claude's stream-json wire format; `mcp_tool` uses fake-claude-mcp.mjs,
//   which acts as Claude's MCP client (config file + `${VAR}` expansion + output-limit spill).
// - Runtime: the same stub CLI behind a descriptor the durable runtime reloads in a fresh process.
// - Live: the real `claude` CLI (only with AGENT_WORKFLOW_LIVE=1, real HOME).
// Effects are counted from the stub invocation log by the attempt's deterministic `--session-id`.
import { readFileSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStubCli } from "../../../../dist/sdk/conformance/index.js";
import {
	attemptSessionId,
	CLAUDE_ADAPTER_VERSION,
	createClaudeExecutor,
	parseClaudeConfig,
} from "../../../../dist/executors/claude/index.js";
import { EXECUTOR_CONTRACT_VERSION } from "../../../../dist/sdk/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ADAPTER_MODULE = fileURLToPath(
	new URL("../../../../dist/executors/claude/index.js", import.meta.url),
);

export function loadTranscript(name) {
	return readFileSync(join(here, "transcripts", `${name}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const out = (value) => ({ stdout: value });
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Wait for the prompt (`user` line) the adapter writes first, then run `steps`. */
const afterPrompt = (steps) => ({
	awaitStdin: {
		timeoutMs: 15_000,
		branches: [{ match: '"type":"user"', steps }],
		otherwise: [],
	},
});

function resultLine(base, patch) {
	return { ...clone(base), ...patch };
}

function buildScenarios() {
	const complete = loadTranscript("complete-tools-mcp");
	const approval = loadTranscript("approval-allow-deny");
	const interrupt = loadTranscript("interrupt");
	const invalidModel = loadTranscript("invalid-model");
	const notLoggedIn = loadTranscript("bare-not-logged-in");
	const invalidModelMeta = JSON.parse(
		readFileSync(join(here, "transcripts", "invalid-model.meta.json"), "utf8"),
	);
	const completeResult = complete.find((line) => line.type === "result");
	const init = complete[0];
	const errorResult = invalidModel.find((line) => line.type === "result");
	// Synthetic API errors: shape of the live `api_error` result (invalid-model), text/status from
	// Anthropic error responses that could not be reproduced safely within the WP8 budget.
	const apiError = (status, text) => [
		out(init),
		out(
			resultLine(errorResult, {
				result: text,
				api_error_status: status,
				terminal_reason: "api_error",
			}),
		),
		{ exit: 1 },
	];
	// Approval: the first Bash call of the live allow/deny transcript; the answer picks the branch.
	const [
		apInit,
		apToolUse,
		apRequest,
		apRate,
		apAllowed,
		,
		,
		apDenied,
		apText,
		apResult,
	] = approval;
	const firstCallId = apToolUse.message.content[0].id;
	const denied = clone(apDenied);
	denied.message.content[0].tool_use_id = firstCallId;
	const interruptAt = interrupt.findIndex(
		(line) => line.type === "control_response",
	);
	return {
		complete: [afterPrompt(complete.map(out))],
		usage_unknown: [
			afterPrompt([
				...complete.filter((line) => line.type !== "result").map(out),
				out(
					(() => {
						const line = clone(completeResult);
						delete line.total_cost_usd;
						return line;
					})(),
				),
			]),
		],
		slow: [
			afterPrompt([
				...interrupt.slice(0, 12).map(out),
				{
					awaitStdin: {
						branches: [
							{
								match: '"interrupt"',
								steps: [...interrupt.slice(interruptAt).map(out), { exit: 1 }],
							},
						],
						otherwise: [],
					},
				},
			]),
		],
		approval: [
			afterPrompt([
				out(apInit),
				out(apToolUse),
				out(apRequest),
				{
					awaitStdin: {
						timeoutMs: 15_000,
						branches: [
							{
								match: '"behavior":"allow"',
								steps: [
									out(apRate),
									out(apAllowed),
									out(apText),
									out(apResult),
								],
							},
							{
								match: '"behavior":"deny"',
								steps: [out(denied), out(apText), out(apResult)],
							},
						],
						otherwise: [out(denied), out(apText), out(apResult)],
					},
				},
			]),
		],
		crash_after_consume: [afterPrompt(complete.map(out))],
		fail_auth: [afterPrompt([...notLoggedIn.map(out), { exit: 1 }])],
		fail_config: [
			afterPrompt([
				...invalidModel.map(out),
				{ stderr: invalidModelMeta.stderr.trim() },
				{ exit: 1 },
			]),
		],
		fail_rate_limit: [
			afterPrompt(
				apiError(
					429,
					'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
				),
			),
		],
		fail_transient: [
			afterPrompt(
				apiError(
					529,
					'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
				),
			),
		],
		fail_permanent: [
			afterPrompt(
				apiError(
					400,
					'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1204512 tokens > 1000000 maximum"}}',
				),
			),
		],
		fail_unknown: [
			afterPrompt([
				out(init),
				{ stderr: "segmentation fault in flux module" },
				{ exit: 139 },
			]),
		],
	};
}

export const STUB_SCENARIOS = buildScenarios();
export const STUB_SCENARIO_NAMES = [...Object.keys(STUB_SCENARIOS), "mcp_tool"];

const MODELS_RESPONSE = {
	type: "control_response",
	response: {
		subtype: "success",
		request_id: "probe-initialize",
		response: {
			models: [{ value: "default" }, { value: "haiku" }, { value: "sonnet" }],
			account: { email: "<REDACTED>" },
		},
	},
};

/** Probe scripts (effect: false) + the scenario run script. */
export function stubScripts(scenario) {
	return [
		{
			name: "version",
			when: { argvIncludes: ["--version"] },
			effect: false,
			steps: [{ stdout: "2.1.310 (Claude Code)" }],
		},
		{
			name: "auth",
			when: { argvIncludes: ["auth", "status"] },
			effect: false,
			steps: [{ stdout: { loggedIn: true, authMethod: "claude.ai" } }],
		},
		{
			name: scenario,
			when: { argvIncludes: ["--permission-prompt-tool"] },
			steps: STUB_SCENARIOS[scenario],
		},
		{
			name: "probe-initialize",
			when: { argvIncludes: ["--input-format"] },
			effect: false,
			steps: [
				{
					awaitStdin: {
						timeoutMs: 5000,
						branches: [{ match: "initialize", steps: [out(MODELS_RESPONSE)] }],
					},
				},
			],
		},
	];
}

const forAttempt = (attemptKey) => (invocation) =>
	attemptKey === undefined ||
	invocation.argv.includes(attemptSessionId(attemptKey));

/** fake-claude-mcp.mjs behind a sh launcher with its own invocation log. */
async function createFakeMcpClaude(dir) {
	const path = join(dir, "claude");
	const logPath = join(dir, "fake-claude.log.jsonl");
	await writeFile(logPath, "");
	await writeFile(
		path,
		`#!/bin/sh\nAW_FAKE_CLAUDE_LOG='${logPath}' exec '${process.execPath}' '${join(here, "fake-claude-mcp.mjs")}' "$@"\n`,
	);
	await chmod(path, 0o755);
	const invocations = async () =>
		(await readFile(logPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "start");
	const effects = async (filter) =>
		(await invocations()).filter(
			(entry) => entry.effect && (!filter || filter(entry)),
		);
	return {
		path,
		invocations,
		effectCount: async (filter) => (await effects(filter)).length,
		launches: async (filter) =>
			(await effects(filter)).map((entry) => ({
				argv: entry.argv,
				envKeys: entry.envKeys,
				cwd: entry.cwd,
			})),
	};
}

function configFor(dir, claudePath, extra = {}) {
	return {
		claudePath,
		stateDir: join(dir, "state"),
		claudeConfigDir: join(dir, "claude-config"),
		killGraceMs: 300,
		...extra,
	};
}

async function killLeftovers(cli) {
	for (const invocation of await cli.invocations())
		if (invocation.exitCode === null)
			try {
				process.kill(invocation.pid, "SIGKILL");
			} catch {
				// already gone
			}
}

/** Documented argv per permission mode (docs/executors/claude.md, WP4e). */
export const CLAUDE_PERMISSION_MODE_SETTINGS = {
	free: ["--permission-mode\nbypassPermissions"],
	safe: ["--permission-mode\ndefault"],
	readOnly: ["--permission-mode\ndefault", "--disallowedTools"],
};

/** Offline conformance harness (stub CLI replaying recorded transcripts). */
export function createClaudeStubHarness(options = {}) {
	const scenarios = options.scenarios ?? STUB_SCENARIO_NAMES;
	return {
		name: "claude-stub-cli",
		scenarios,
		permissionModes: CLAUDE_PERMISSION_MODE_SETTINGS,
		async open(scenario) {
			const dir = await mkdtemp(join(tmpdir(), "aw-claude-stub-"));
			const cli =
				scenario === "mcp_tool"
					? await createFakeMcpClaude(dir)
					: await createStubCli({
							dir,
							name: "claude",
							scripts: stubScripts(scenario),
						});
			const config = parseClaudeConfig(configFor(dir, cli.path));
			const faults =
				scenario === "crash_after_consume" ? { crashAfterConsume: true } : {};
			const make = () => createClaudeExecutor({ config, faults });
			return {
				executor: make(),
				effectCount: (attemptKey) => cli.effectCount(forAttempt(attemptKey)),
				launches: (attemptKey) => cli.launches(forAttempt(attemptKey)),
				restart: async () => make(),
				async dispose() {
					if (scenario !== "mcp_tool") await killLeftovers(cli);
					await rm(dir, { recursive: true, force: true });
				},
			};
		},
		async descriptor() {
			const dir = await mkdtemp(join(tmpdir(), "aw-claude-desc-"));
			return {
				descriptor: {
					id: "claude",
					version: CLAUDE_ADAPTER_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: ADAPTER_MODULE,
					config: configFor(dir, join(dir, "claude"), { listModels: false }),
				},
			};
		},
		async runtime(scenario, { workDir }) {
			const dir = join(workDir, "claude-stub");
			await mkdir(dir, { recursive: true });
			const cli = await createStubCli({
				dir,
				name: "claude",
				scripts: stubScripts(scenario),
			});
			return {
				descriptor: {
					id: "claude",
					version: CLAUDE_ADAPTER_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: ADAPTER_MODULE,
					config: configFor(dir, cli.path, { listModels: false }),
				},
				effectCount: (attemptKey) => cli.effectCount(forAttempt(attemptKey)),
				runInput: scenario === "approval" ? { tools: ["bash"] } : {},
				dispose: () => killLeftovers(cli),
			};
		},
	};
}

/** Live harness: real `claude` on PATH, cheapest model, low effort, adapter state in a temp dir. */
export function createClaudeLiveHarness(options = {}) {
	const model = options.model ?? "haiku";
	const root = options.root ?? tmpdir();
	const configs = [];
	const sessionCwds = new Map();
	return {
		name: "claude-live",
		live: true,
		scenarios: ["complete"],
		async open() {
			const dir = await mkdtemp(join(root, "aw-live-claude-kit-"));
			const config = parseClaudeConfig({
				claudePath: options.claudePath ?? "claude",
				stateDir: join(dir, "state"),
				listModels: false,
			});
			configs.push(config);
			const executor = createClaudeExecutor({ config });
			return {
				executor,
				// Launch evidence = the adapter's durable `spawned` record (no stub log for a real CLI).
				effectCount: async (attemptKey) => {
					if (attemptKey === undefined) return 0;
					const record = await executor.reconcile(attemptKey);
					return "found" in record ? 1 : 0;
				},
				restart: async () => createClaudeExecutor({ config }),
				dispose: async () => {},
			};
		},
		request(base) {
			// Claude resumes a session only from the directory it was created in (its transcript lives
			// under the cwd's project dir); the engine's same-session repair reuses the attempt cwd.
			if (base.sessionId !== undefined)
				sessionCwds.set(base.sessionId, base.cwd);
			const cwd =
				base.resumeSessionId === undefined
					? base.cwd
					: (sessionCwds.get(base.resumeSessionId) ?? base.cwd);
			return { ...base, cwd, model, effort: "low" };
		},
		/** Delete every worker session the live runs kept (D3), through `deleteOwnedSession`. */
		async cleanupSessions() {
			const results = [];
			for (const config of configs) {
				let names = [];
				try {
					names = await readdir(join(config.stateDir, "sessions"));
				} catch {
					continue;
				}
				const executor = createClaudeExecutor({ config });
				for (const name of names.filter((entry) => entry.endsWith(".json"))) {
					const locator = name.slice(0, -".json".length);
					results.push({
						locator,
						result: await executor.deleteOwnedSession({
							kind: "claude-session",
							locator,
						}),
					});
				}
			}
			return results;
		},
	};
}
