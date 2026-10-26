#!/usr/bin/env node
// `agent-workflow` bin. A thin launcher of the compiled CLI (dist/hosts/cli/index.js), which is a
// thin argv layer over the host API (dist/hosts/api.js). No Pi imports (R#14).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
