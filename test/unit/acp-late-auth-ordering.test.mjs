// test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

const helper = new URL("../helpers/acp-late-auth.mjs", import.meta.url).href;

test("late-auth fixture survives a stop between its response and stderr, then exits itself", {
	timeout: 10_000,
}, async (t) => {
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { finishLateAuthentication } from ${JSON.stringify(helper)};
			await finishLateAuthentication(7, {
				afterResponse: () => new Promise(resolve => {
					process.once("message", resolve);
					process.send("response-held");
				}),
				onStop: () => process.send("stop-observed"),
			});`,
		],
		{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
	);
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	t.after(async () => {
		child.kill("SIGKILL");
		await closed;
	});
	const held = Promise.withResolvers();
	const stopped = Promise.withResolvers();
	child.on("message", (message) => {
		if (message === "response-held") held.resolve();
		if (message === "stop-observed") stopped.resolve("stop-observed");
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const lines = createInterface({ input: child.stdout });
	const response = once(lines, "line");
	await held.promise;
	assert.deepEqual(JSON.parse((await response)[0]), {
		jsonrpc: "2.0",
		id: 7,
		result: {},
	});
	assert.equal(stderr, "", "stderr is held after the stdout response");
	assert.equal(child.kill("SIGTERM"), true);
	assert.equal(
		await Promise.race([stopped.promise, closed]),
		"stop-observed",
		"the client's stop must not kill the fixture before its stderr exists",
	);
	assert.equal(stderr, "", "even after stop acknowledgement the write is held");
	child.send("release-stderr");
	assert.deepEqual(await closed, { code: 0, signal: null });
	assert.equal(stderr, "Signed in: https://example.invalid/done\n");
});
