// test-tier: integration
// Direct coverage of the compiled process-gate contract.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeWorkerPath } from "../../dist/runtime/index.js";

const gate = runtimeWorkerPath("process-gate");

function runGate(args, input) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [gate, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolveRun({ code, signal, stdout, stderr }),
		);
		child.stdin.end(input);
	});
}

const payload = (argv, extra = {}) =>
	`${JSON.stringify({ argv, cwd: tmpdir(), env: {}, ...extra })}\n`;

test("process-gate: invalid payloads exit 125", async () => {
	for (const input of [
		"",
		"not json\n",
		"null\n",
		payload([]),
		payload([""]),
		payload([process.execPath], { cwd: 1 }),
		`${JSON.stringify({ argv: [process.execPath], cwd: tmpdir() })}\n`,
	]) {
		const result = await runGate([], input);
		assert.deepEqual(
			[result.code, result.signal],
			[125, null],
			JSON.stringify(input),
		);
	}
});

test("process-gate: exit code, signal and spawn error pass through", async () => {
	const exitCode = await runGate(
		[],
		payload([process.execPath, "-e", "process.exit(7)"]),
	);
	assert.deepEqual([exitCode.code, exitCode.signal], [7, null]);
	const signalled = await runGate(
		[],
		payload([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]),
	);
	assert.deepEqual([signalled.code, signalled.signal], [null, "SIGTERM"]);
	const missing = await runGate([], payload(["/nonexistent/aw-gate-binary"]));
	assert.equal(missing.code, 127);
	assert.match(missing.stderr, /ENOENT/);
	const env = await runGate(
		[],
		payload(
			[process.execPath, "-e", "console.log(process.env.AW_GATE ?? 'unset')"],
			{
				env: { AW_GATE: "explicit" },
			},
		),
	);
	assert.equal(
		env.stdout,
		"explicit\n",
		"only the payload env reaches the child",
	);
});

test("process-gate: --file payload is read once and removed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "aw-gate-file-"));
	try {
		const path = join(dir, "payload.json");
		const pending = runGate(["--file", path], "");
		// The gate waits for a payload file that appears later.
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
		// Atomic publish (write + rename): the gate may poll between a non-atomic
		// create and its first write and read an empty payload under load.
		await writeFile(
			`${path}.tmp`,
			payload([process.execPath, "-e", "console.log('file')"]),
		);
		await rename(`${path}.tmp`, path);
		const result = await pending;
		assert.deepEqual([result.code, result.signal], [0, null], result.stderr);
		assert.equal(result.stdout, "file\n");
		assert.equal(existsSync(path), false, "payload file is unlinked");
	} finally {
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
