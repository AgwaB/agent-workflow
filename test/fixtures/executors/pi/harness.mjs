// Conformance harness for the Pi executor (WP6), modelled on test/conformance/stub-cli-adapter.mjs.
// Offline: the kit's stub CLI replays scrubbed Pi transcripts (transcripts/*.json, recorded from
// real Pi 1.1.0 runs); `mcp_tool` uses fake-pi-mcp.mjs (the stub CLI cannot speak MCP);
// `crash_after_consume` points the adapter at a missing binary (consume, then spawn fails before
// any launch evidence). Effects are counted from the CLI invocation logs, per attempt through the
// adapter's own attempt record (its runDir appears on argv as `-e <runDir>/pi-extension.mjs`).
// Runtime tier: the same stub scripts behind a descriptor the durable worker reloads in a fresh
// process. Live: `createPiLiveHarness` (real Pi, real model; opt in).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStubCli } from "../../../../dist/sdk/conformance/index.js";
import {
	createExecutor,
	PI_EXECUTOR_ID,
	PI_EXECUTOR_VERSION,
} from "../../../../dist/executors/pi/index.js";
import { EXECUTOR_CONTRACT_VERSION } from "../../../../dist/sdk/index.js";

export const PI_MODULE = fileURLToPath(
	new URL("../../../../dist/executors/pi/index.js", import.meta.url),
);
const FAKE_PI_MCP = fileURLToPath(
	new URL("./fake-pi-mcp.mjs", import.meta.url),
);
const TRANSCRIPTS = fileURLToPath(new URL("./transcripts/", import.meta.url));

export async function loadTranscript(name) {
	return JSON.parse(await readFile(join(TRANSCRIPTS, `${name}.json`), "utf8"));
}

/** Stub CLI steps that replay a transcript: stdout lines, stderr, then the recorded exit. */
export function replaySteps(transcript, { hangAfter } = {}) {
	const lines =
		hangAfter === undefined
			? transcript.stdout
			: transcript.stdout.slice(0, hangAfter);
	const steps = lines.map((line) => ({ stdout: line }));
	if (hangAfter !== undefined) return [...steps, { hang: true }];
	for (const chunk of transcript.stderr.split("\n").filter(Boolean))
		steps.push({ stderr: chunk });
	steps.push({ exit: transcript.exitCode ?? 1 });
	return steps;
}

const SCENARIO_TRANSCRIPTS = {
	complete: "complete-read",
	usage_unknown: "usage-unknown-faux",
	fail_transient: "fail-transient-google-500",
	fail_rate_limit: "fail-rate-limit-google-429",
	fail_auth: "fail-auth-openai-401",
	fail_config: "fail-config-model-not-found",
	fail_unknown: "fail-unknown-flag-conflict",
};

export const PI_STUB_SCENARIOS = [
	...Object.keys(SCENARIO_TRANSCRIPTS),
	"slow",
	"crash_after_consume",
	"mcp_tool",
];

/** Non-effect probe scripts (no model turn): version, model list, auth check, package list. */
export const PROBE_SCRIPTS = [
	{
		name: "version",
		when: { argvIncludes: ["--version"] },
		effect: false,
		steps: [{ stdout: "1.1.0" }],
	},
	{
		name: "list-models",
		when: { argvIncludes: ["--list-models"] },
		effect: false,
		steps: [
			{
				stdout:
					"provider  model                  context  max-out  thinking  images",
			},
			{
				stdout:
					"google    gemini-2.5-flash-lite  1.0M     65.5K    yes       yes",
			},
		],
	},
	{
		name: "auth-check",
		when: { argvIncludes: ["auth", "check"] },
		effect: false,
		steps: [
			{ stdout: '{"status":"ready","provider":"google","authType":"api_key"}' },
		],
	},
	{
		name: "package-list",
		when: { argvIncludes: ["list"] },
		effect: false,
		steps: [{ stdout: "User packages:" }],
	},
];

async function scriptsFor(scenario) {
	if (scenario === "slow")
		return replaySteps(await loadTranscript("complete-read"), { hangAfter: 3 });
	const name = SCENARIO_TRANSCRIPTS[scenario] ?? "complete-read";
	return replaySteps(await loadTranscript(name));
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function readJsonLines(path) {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** Attempt filter: the invocation loaded this attempt's per-run extension. */
async function attemptFilter(stateDir, attemptKey) {
	if (attemptKey === undefined) return () => true;
	const record = JSON.parse(
		await readFile(
			join(stateDir, "attempts", `${sha256(attemptKey)}.json`),
			"utf8",
		).catch(() => "{}"),
	);
	if (typeof record.runDir !== "string") return () => false;
	const marker = join(record.runDir, "pi-extension.mjs");
	return (invocation) => invocation.argv.includes(marker);
}

/** A Pi stand-in for one scenario: stub CLI, fake MCP Pi, or a missing binary. */
export async function stagePiCli(scenario, dir) {
	await mkdir(dir, { recursive: true });
	if (scenario === "mcp_tool") {
		const logPath = join(dir, "fake-pi.log.jsonl");
		const path = join(dir, "pi");
		await writeFile(
			path,
			`#!/bin/sh\nAW_FAKE_PI_LOG='${logPath}' exec '${process.execPath}' '${FAKE_PI_MCP}' "$@"\n`,
		);
		await chmod(path, 0o755);
		await writeFile(logPath, "");
		const invocations = async () =>
			(await readJsonLines(logPath))
				.filter((entry) => entry.type === "start")
				.map((entry) => ({ ...entry, effect: entry.argv.includes("--mode") }));
		return { path, invocations };
	}
	if (scenario === "crash_after_consume")
		return {
			path: join(dir, "missing-pi-binary"),
			invocations: async () => [],
		};
	const cli = await createStubCli({
		dir,
		name: "pi",
		scripts: [
			...PROBE_SCRIPTS,
			{
				name: scenario,
				when: { argvIncludes: ["--mode", "json"] },
				steps: await scriptsFor(scenario),
			},
		],
	});
	return { path: cli.path, invocations: () => cli.invocations() };
}

function counters(cli, stateDir) {
	const effects = async (attemptKey) => {
		const filter = await attemptFilter(stateDir, attemptKey);
		return (await cli.invocations()).filter(
			(invocation) => invocation.effect && filter(invocation),
		);
	};
	return {
		effectCount: async (attemptKey) => (await effects(attemptKey)).length,
		launches: async (attemptKey) =>
			(await effects(attemptKey)).map((invocation) => ({
				argv: invocation.argv,
				envKeys: invocation.envKeys,
				cwd: invocation.cwd,
			})),
		async killLeftovers() {
			for (const invocation of await cli.invocations())
				if (invocation.exitCode === null)
					for (const target of [-invocation.pid, invocation.pid])
						try {
							process.kill(target, "SIGKILL");
						} catch {}
		},
	};
}

/** Documented argv per permission mode (docs/executors/pi.md, WP4e): the same in both modes. */
export const PI_PERMISSION_MODE_SETTINGS = {
	free: ["--tools\nread,bash\n"],
	safe: ["--tools\nread,bash\n"],
	readOnly: ["--tools\nread\n"],
	equivalent:
		"Pi has no approval prompts and no sandbox: both modes run every requested tool; readOnly drops mutating tools from --tools",
};

export function createPiStubHarness() {
	return {
		name: "pi-executor-stub-cli",
		scenarios: PI_STUB_SCENARIOS,
		permissionModes: PI_PERMISSION_MODE_SETTINGS,
		async open(scenario) {
			const dir = await mkdtemp(join(tmpdir(), "aw-pi-stub-"));
			const cli = await stagePiCli(scenario, join(dir, "cli"));
			const stateDir = join(dir, "state");
			const config = { piCommand: cli.path, stateDir, killGraceMs: 500 };
			const count = counters(cli, stateDir);
			return {
				executor: createExecutor(config),
				effectCount: count.effectCount,
				launches: count.launches,
				restart: async () => createExecutor(config),
				async dispose() {
					await count.killLeftovers();
					await rm(dir, { recursive: true, force: true });
				},
			};
		},
		async descriptor() {
			return {
				descriptor: {
					id: PI_EXECUTOR_ID,
					version: PI_EXECUTOR_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: PI_MODULE,
					config: {
						piCommand: "pi",
						stateDir: join(tmpdir(), "aw-pi-descriptor-state"),
					},
				},
			};
		},
		async runtime(scenario, { workDir }) {
			const cli = await stagePiCli(scenario, join(workDir, "cli"));
			const stateDir = join(workDir, "state");
			const count = counters(cli, stateDir);
			return {
				descriptor: {
					id: PI_EXECUTOR_ID,
					version: PI_EXECUTOR_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: PI_MODULE,
					config: { piCommand: cli.path, stateDir, killGraceMs: 500 },
				},
				effectCount: count.effectCount,
				dispose: () => count.killLeftovers(),
			};
		},
	};
}

/** Live runs use fresh /tmp/aw-live-pi-* directories (WP6 rule), else the OS temp dir. */
export const LIVE_TMP = existsSync("/tmp") ? "/tmp" : tmpdir();

/**
 * Live harness: the real `pi` with the caller's environment (Pi owns its login, D1). Only the
 * `complete` scenario; every session costs model calls. Opt in with `tiers: ["live"]`.
 */
export function createPiLiveHarness({
	model,
	effort = "minimal",
	piCommand = "pi",
}) {
	// One state dir for the harness: live.resume opens a second session that must find the first.
	let stateDir;
	return {
		name: "pi-executor-live",
		live: true,
		scenarios: ["complete"],
		async open() {
			stateDir ??= join(
				await mkdtemp(join(LIVE_TMP, "aw-live-pi-kit-")),
				"state",
			);
			const config = { piCommand, stateDir };
			return {
				executor: createExecutor(config),
				effectCount: async () => 0,
				restart: async () => createExecutor(config),
				dispose: async () => {},
			};
		},
		request(base) {
			return { ...base, model, effort };
		},
	};
}
