#!/usr/bin/env node
// New in agent-workflow (WP5): stdio MCP server entry for workflow_artifact.
//   node dist/mcp/artifact-server/server.js --config <artifact-access.json> [--max-output-chars <n>]
// stdout carries only MCP protocol messages; every diagnostic goes to stderr.
import { parseArgs } from "node:util";
import { packageVersion } from "../package-version.js";

// Keep stdout protocol-only even if a dependency logs: route console output to stderr.
for (const method of ["log", "info", "debug", "warn"] as const)
	console[method] = (...args: unknown[]) => console.error(...args);

const log = (message: string) =>
	process.stderr.write(`workflow_artifact MCP server: ${message}\n`);

const USAGE =
	"usage: server.js --config <artifact-access.json> [--max-output-chars <n>]";

async function main(): Promise<void> {
	let configPath: string;
	let outputLimit: number | undefined;
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2),
			options: {
				config: { type: "string" },
				"max-output-chars": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		});
		if (values.config === undefined || values.config === "")
			throw new Error("--config is required");
		configPath = values.config;
		const { parseOutputLimit } = await import("./delivery.js");
		const limit = values["max-output-chars"];
		outputLimit = limit === undefined ? undefined : parseOutputLimit(limit);
	} catch (error) {
		log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		process.exit(2);
	}

	const { createArtifactToolService } = await import("./service.js");
	const { serveMcpStdio } = await import("./stdio.js");
	let service: Awaited<ReturnType<typeof createArtifactToolService>>;
	try {
		service = await createArtifactToolService({ configPath, outputLimit });
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
		void service
			.close()
			.catch(() => undefined)
			.finally(() => {
				if (process.stdout.writableLength === 0) process.exit(code);
				else process.stdout.write("", () => process.exit(code));
			});
	};
	process.stdout.on("error", () => exit(0));
	const server = serveMcpStdio({
		input: process.stdin,
		output: process.stdout,
		log,
		callTool: (args) => service.call(args),
		serverVersion: packageVersion(),
		onDrained: () => exit(0),
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.once(signal, () => {
			server.shutdown();
			// In-flight reads get a bounded grace period to answer and record their ledger rows.
			setTimeout(() => exit(0), 5_000).unref();
		});
}

process.on("uncaughtException", (error) => {
	log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

await main();
