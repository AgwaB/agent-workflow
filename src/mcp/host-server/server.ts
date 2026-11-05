#!/usr/bin/env node
// New in agent-workflow (WP13): stdio entry of the `agent-workflow` host MCP server for agent hosts.
//   agent-workflow-mcp --host <claude-code|codex|generic> [--tool-timeout-ms <ms>]
//   node dist/mcp/host-server/server.js --host <claude-code|codex|generic>
// --tool-timeout-ms: the host's per-call limit for this server when the plugin set one (Codex
// tool_timeout_sec); workflow_wait then waits longer per call (hostMcpWaitSliceMs).
// The project is the server's working directory. stdout carries only MCP protocol messages; every
// diagnostic goes to stderr. docs/host-mcp.md.
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { packageVersion } from "../package-version.js";

// Keep stdout protocol-only even if a dependency logs: route console output to stderr.
for (const method of ["log", "info", "debug", "warn"] as const)
	console[method] = (...args: unknown[]) => console.error(...args);

const log = (message: string) =>
	process.stderr.write(`agent-workflow MCP server: ${message}\n`);

const USAGE =
	"usage: agent-workflow-mcp --host <claude-code|codex|generic> [--tool-timeout-ms <ms>]";

async function main(): Promise<void> {
	const { HOST_MCP_HOSTS, hostMcpWaitSliceMs } = await import("./tools.js");
	let host: (typeof HOST_MCP_HOSTS)[number];
	let toolTimeoutMs: number | undefined;
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2),
			options: {
				host: { type: "string" },
				"tool-timeout-ms": { type: "string" },
				help: { type: "boolean" },
			},
			strict: true,
			allowPositionals: false,
		});
		if (values.help) {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		if (values.host === undefined || values.host === "")
			throw new Error("--host is required");
		if (!(HOST_MCP_HOSTS as readonly string[]).includes(values.host))
			throw new Error(
				`unknown --host ${values.host} (expected ${HOST_MCP_HOSTS.join(", ")})`,
			);
		host = values.host as (typeof HOST_MCP_HOSTS)[number];
		const timeout = values["tool-timeout-ms"];
		if (timeout !== undefined) {
			if (!/^\d{4,10}$/u.test(timeout))
				throw new Error(
					`--tool-timeout-ms takes whole milliseconds (1000 or more), got ${JSON.stringify(timeout)}`,
				);
			toolTimeoutMs = Number(timeout);
		}
	} catch (error) {
		log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		process.exit(2);
	}

	const { registerTestExecutorFromEnv } = await import("../../hosts/api.js");
	const { serveHostMcpStdio } = await import("./serve.js");
	let root: string;
	try {
		root = realpathSync(process.cwd());
		// Guarded test-only hook (WP11a), as in the CLI: a no-op unless its two variables are set.
		const testExecutor = await registerTestExecutorFromEnv(process.env);
		if (testExecutor)
			log(
				`test executor "${testExecutor}" registered from AGENT_WORKFLOW_TEST_EXECUTOR_MODULE (tests only)`,
			);
	} catch (error) {
		log(
			`refusing to start: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	let exiting = false;
	const exit = (code: number) => {
		if (exiting) return;
		exiting = true;
		if (process.stdout.writableLength === 0) process.exit(code);
		else process.stdout.write("", () => process.exit(code));
	};
	process.stdout.on("error", () => exit(0));
	const waitSliceMs = hostMcpWaitSliceMs({
		host,
		env: process.env,
		...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
	});
	const server = serveHostMcpStdio({
		input: process.stdin,
		output: process.stdout,
		log,
		root,
		host,
		env: process.env,
		waitSliceMs,
		serverVersion: packageVersion(),
		onDrained: () => exit(0),
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.once(signal, () => {
			server.shutdown();
			setTimeout(() => exit(0), 5_000).unref();
		});
}

process.on("uncaughtException", (error) => {
	log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

await main();
