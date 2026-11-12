// test-tier: integration
// 2026-11-12: `agent-workflow dashboard --status | head -1` crashed the CLI with an unhandled EPIPE
// once the reader closed the pipe. A closed output pipe is not an error: the command finishes and
// exits with its own code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);

test("the CLI exits cleanly when its output pipe is closed before it writes", async () => {
	const child = spawn(process.execPath, [cli, "help"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.destroy();
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(stderr, "", "no unhandled EPIPE");
	assert.equal(code, 0);
});
