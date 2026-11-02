// Conformance harness for the ACP executor pilot: the adapter (Gemini preset) against the scripted
// ACP agent fake-acp-agent.mjs. Effects are the agent launches in its log; the offline tier tags
// each launch with the attemptKey through the request env (FAKE_ACP_ATTEMPT).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ACP_ADAPTER_VERSION,
	createAcpExecutor,
	parseAcpConfig,
} from "../../../../dist/executors/acp/index.js";
import { EXECUTOR_CONTRACT_VERSION } from "../../../../dist/sdk/index.js";

const FAKE_AGENT = fileURLToPath(
	new URL("./fake-acp-agent.mjs", import.meta.url),
);
export const ADAPTER_MODULE = fileURLToPath(
	new URL("../../../../dist/executors/acp/index.js", import.meta.url),
);

export const ACP_SCENARIOS = [
	"complete",
	"usage_unknown",
	"slow",
	"approval",
	"crash_after_consume",
	"mcp_tool",
	"fail_transient",
	"fail_rate_limit",
	"fail_auth",
	"fail_config",
	"fail_permanent",
	"fail_unknown",
];

/** Gemini preset launch settings per permission mode (config.ts). */
export const ACP_PERMISSION_MODE_SETTINGS = {
	free: ["--approval-mode\nyolo"],
	safe: ["--approval-mode\ndefault"],
	readOnly: ["--approval-mode\nplan"],
};

async function agentCommand(dir, scenario) {
	await mkdir(dir, { recursive: true });
	const command = join(dir, "fake-gemini");
	const log = join(dir, "agent-log.jsonl");
	await writeFile(
		command,
		`#!/bin/sh\nFAKE_ACP_SCENARIO=${scenario} FAKE_ACP_LOG=${JSON.stringify(log)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@"\n`,
		{ mode: 0o755 },
	);
	const launches = async (attemptKey) =>
		(await readFile(log, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter(
				(entry) =>
					Array.isArray(entry.argv) && !entry.argv.includes("--version"),
			)
			.filter(
				(entry) =>
					attemptKey === undefined ||
					entry.attempt === null ||
					entry.attempt === attemptKey,
			)
			.map((entry) => ({
				argv: entry.argv,
				envKeys: entry.envKeys,
				pid: entry.pid,
			}));
	return { command, launches };
}

const configFor = (dir, command) => ({
	preset: "gemini",
	command,
	stateDir: join(dir, "state"),
	killGraceMs: 200,
	handshakeTimeoutMs: 10_000,
});

export function createAcpHarness(options = {}) {
	return {
		name: "acp-gemini-fake-agent",
		scenarios: options.scenarios ?? ACP_SCENARIOS,
		permissionModes: ACP_PERMISSION_MODE_SETTINGS,
		request(base) {
			return {
				...base,
				env: { ...base.env, FAKE_ACP_ATTEMPT: base.attemptKey },
			};
		},
		async open(scenario) {
			const dir = await mkdtemp(join(tmpdir(), "aw-acp-conf-"));
			const agent = await agentCommand(dir, scenario);
			const config = parseAcpConfig(configFor(dir, agent.command));
			const faults =
				scenario === "crash_after_consume" ? { crashAfterConsume: true } : {};
			const make = () => createAcpExecutor({ config, faults });
			return {
				executor: make(),
				effectCount: async (attemptKey) =>
					(await agent.launches(attemptKey)).length,
				launches: (attemptKey) => agent.launches(attemptKey),
				restart: async () => make(),
				dispose: () =>
					rm(dir, {
						recursive: true,
						force: true,
						maxRetries: 10,
						retryDelay: 100,
					}),
			};
		},
		async descriptor() {
			const dir = await mkdtemp(join(tmpdir(), "aw-acp-desc-"));
			return {
				descriptor: {
					id: "gemini",
					version: ACP_ADAPTER_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: ADAPTER_MODULE,
					config: configFor(dir, join(dir, "fake-gemini")),
				},
			};
		},
		async runtime(scenario, { workDir }) {
			const dir = join(workDir, "acp-fake");
			const agent = await agentCommand(dir, scenario);
			return {
				descriptor: {
					id: "gemini",
					version: ACP_ADAPTER_VERSION,
					contractVersion: EXECUTOR_CONTRACT_VERSION,
					module: ADAPTER_MODULE,
					config: configFor(dir, agent.command),
				},
				// The durable worker gives the agent no per-attempt tag: attribute launches by the pid the
				// adapter recorded for the attempt (as the Pi harness does with its recorded run dir).
				effectCount: async (attemptKey) => {
					const all = await agent.launches();
					if (attemptKey === undefined) return all.length;
					const digest = createHash("sha256")
						.update(attemptKey)
						.digest("hex")
						.slice(0, 40);
					const record = JSON.parse(
						await readFile(
							join(dir, "state", "attempts", `${digest}.json`),
							"utf8",
						).catch(() => "{}"),
					);
					return typeof record.pid === "number"
						? all.filter((entry) => entry.pid === record.pid).length
						: 0;
				},
				runInput: scenario === "approval" ? { tools: ["bash"] } : {},
			};
		},
	};
}
