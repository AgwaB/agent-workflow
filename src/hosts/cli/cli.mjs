#!/usr/bin/env node
// `agent-workflow` bin. A thin launcher of the compiled CLI (dist/hosts/cli/index.js), which is a
// thin argv layer over the host API (dist/hosts/api.js). No Pi imports (R#14).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 2026-11-12: a reader that closes the pipe early (`agent-workflow dashboard --status | head -1`)
// left the next write with an unhandled EPIPE that crashed the CLI. The output is no longer wanted:
// drop it and let the command finish. Any other stream error still surfaces.
for (const stream of [process.stdout, process.stderr])
	stream.on("error", (error) => {
		if (error?.code !== "EPIPE") throw error;
	});

// WP36: `statusline` runs on every host status refresh; it loads only its own module and never
// fails loudly (no output and exit 0 on any error, also a missing build).
if (
	process.argv[2] === "statusline" &&
	!process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h")
) {
	let code = 0;
	try {
		const statusline = new URL(
			"../../../dist/hosts/cli/statusline.js",
			import.meta.url,
		);
		const { statusLineMain } = await import(statusline.href);
		code = await statusLineMain();
	} catch {
		code = 0;
	}
	await new Promise((resolve) => process.stdout.write("", resolve));
	process.exit(code);
}
const entry = new URL("../../../dist/hosts/cli/index.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
	process.stderr.write(
		`agent-workflow: the build is missing at ${fileURLToPath(entry)}. Run \`npm run build\` in a source checkout, or install the packed package.\n`,
	);
	process.exit(1);
}
const { runAgentWorkflowCli } = await import(entry.href);
const code = await runAgentWorkflowCli(process.argv.slice(2));
// Flush both streams before exiting: pipes are asynchronous on some platforms, and in-process
// supervisors (unref'd timers) must not keep the process alive after the command finished.
await new Promise((resolve) => process.stdout.write("", resolve));
await new Promise((resolve) => process.stderr.write("", resolve));
process.exit(code);
