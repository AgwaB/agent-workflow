import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	callMcpTool,
	createStubCli,
	createStubMcpServer,
	McpClientError,
} from "../../dist/sdk/conformance/index.js";

const root = await mkdtemp(join(tmpdir(), "aw-conformance-stubs-"));
after(() => rm(root, { recursive: true, force: true }));

let dirCounter = 0;
async function dir() {
	dirCounter += 1;
	const path = join(root, `case-${dirCounter}`);
	await mkdir(path, { recursive: true });
	return path;
}

function run(command, args, { env = {}, stdin, cwd, onSpawn } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
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
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolve({ code, signal, stdout, stderr }),
		);
		onSpawn?.(child);
		if (stdin !== undefined) child.stdin.write(stdin);
		if (onSpawn === undefined) child.stdin.end();
	});
}

const SCRIPTS = [
	{
		name: "version",
		when: { argvIncludes: ["--version"] },
		effect: false,
		steps: [{ stdout: "stub-cli 9.9.9" }],
	},
	{
		name: "hang",
		when: { argvIncludes: ["hang"] },
		steps: [{ stdout: { type: "started" } }, { hang: true }],
	},
	{
		name: "approve",
		when: { argvIncludes: ["approve"] },
		steps: [
			{ stdout: { type: "approval_request", requestId: "r1" } },
			{
				awaitStdin: {
					timeoutMs: 5000,
					branches: [
						{ match: '"allow"', steps: [{ stdout: { type: "allowed" } }] },
						{
							match: '"deny"',
							steps: [{ stdout: { type: "denied" } }, { exit: 3 }],
						},
					],
					otherwise: [{ stdout: { type: "timeout" } }],
				},
			},
		],
	},
	{
		name: "run",
		when: { argvIncludes: ["run"] },
		exitCode: 7,
		steps: [
			{ stdout: { type: "started", n: 1 } },
			{ stderr: "warning: stub" },
			{ sleepMs: 5 },
			{ stdout: "plain line" },
		],
	},
];

test("stub CLI replays scripts and records invocations", async () => {
	const cli = await createStubCli({ dir: await dir(), scripts: SCRIPTS });
	const cwd = await dir();

	const version = await run(cli.path, ["--version"]);
	assert.equal(version.code, 0);
	assert.equal(version.stdout, "stub-cli 9.9.9\n");

	const result = await run(cli.path, ["run", "--attempt", "a1"], {
		cwd,
		env: { STUB_SECRET_TOKEN: "do-not-log-me" },
	});
	assert.equal(result.code, 7);
	assert.deepEqual(result.stdout.trim().split("\n"), [
		JSON.stringify({ type: "started", n: 1 }),
		"plain line",
	]);
	assert.equal(result.stderr, "warning: stub\n");

	const missing = await run(cli.path, ["nothing"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /no script matches/);

	const invocations = await cli.invocations();
	assert.equal(invocations.length, 3);
	assert.deepEqual(
		invocations.map((entry) => [entry.script, entry.effect, entry.exitCode]),
		[
			["version", false, 0],
			["run", true, 7],
			[null, false, 2],
		],
	);
	const launch = invocations[1];
	assert.deepEqual(launch.argv, ["run", "--attempt", "a1"]);
	assert.ok(launch.cwd.endsWith(cwd.split("/").at(-1)));
	assert.ok(launch.envKeys.includes("STUB_SECRET_TOKEN"));
	assert.doesNotMatch(await readFile(cli.logPath, "utf8"), /do-not-log-me/);

	assert.equal(await cli.effectCount(), 1);
	assert.equal(await cli.effectCount((entry) => entry.argv.includes("a2")), 0);
	assert.deepEqual(await cli.launches(), [
		{
			argv: ["run", "--attempt", "a1"],
			envKeys: launch.envKeys,
			cwd: launch.cwd,
		},
	]);
	await cli.reset();
	assert.deepEqual(await cli.invocations(), []);
});

test("stub CLI hang is killed by a signal and the signal is recorded", async () => {
	const cli = await createStubCli({ dir: await dir(), scripts: SCRIPTS });
	const result = await run(cli.path, ["hang"], {
		onSpawn(child) {
			child.stdout.once("data", () => child.kill("SIGTERM"));
		},
	});
	assert.equal(result.code, 143);
	const [invocation] = await cli.invocations();
	assert.deepEqual(invocation.signals, ["SIGTERM"]);
	assert.equal(invocation.exitCode, 143);
});

test("stub CLI awaitStdin branches on the answer and records stdin", async () => {
	const cli = await createStubCli({ dir: await dir(), scripts: SCRIPTS });
	const deny = await run(cli.path, ["approve"], {
		onSpawn(child) {
			child.stdout.once("data", () =>
				child.stdin.end('{"requestId":"r1","decision":"deny"}\n'),
			);
		},
	});
	assert.equal(deny.code, 3);
	assert.match(deny.stdout, /"denied"/);
	const allow = await run(cli.path, ["approve"], {
		onSpawn(child) {
			child.stdout.once("data", () =>
				child.stdin.end('{"requestId":"r1","decision":"allow"}\n'),
			);
		},
	});
	assert.equal(allow.code, 0);
	assert.match(allow.stdout, /"allowed"/);
	const closed = await run(cli.path, ["approve"]);
	assert.match(closed.stdout, /"timeout"/);
	const invocations = await cli.invocations();
	assert.deepEqual(invocations[0].stdin, [
		'{"requestId":"r1","decision":"deny"}',
	]);

	await cli.setScripts([{ name: "only", steps: [{ stdout: "replaced" }] }]);
	assert.equal((await run(cli.path, ["approve"])).stdout, "replaced\n");
});

test("stub MCP server speaks stdio JSON-RPC and logs calls without argv secrets", async () => {
	const secret = "s3cr3t-value-123456";
	const server = await createStubMcpServer({
		dir: await dir(),
		padChars: 64,
		env: { AW_CONFORMANCE_MCP_TOKEN: secret },
	});
	assert.equal(server.spec.name, "conformance");
	assert.ok(!server.spec.args.some((arg) => arg.includes(secret)));

	const result = await callMcpTool(server.spec, "echo", { text: "hello" });
	assert.equal(result.isError, false);
	assert.deepEqual(result.tools, ["echo", "fail"]);
	assert.equal(result.text.length, 64);
	assert.ok(result.text.startsWith("hello "));
	assert.equal(result.serverInfo.name, "agent-workflow-conformance-stub");

	const failed = await callMcpTool(server.spec, "fail", {});
	assert.equal(failed.isError, true);
	await assert.rejects(
		callMcpTool(server.spec, "missing", {}),
		(error) => error instanceof McpClientError && error.code === -32602,
	);

	const log = await server.log();
	const starts = log.filter((entry) => entry.type === "start");
	assert.equal(starts.length, 3);
	assert.ok(
		starts.every((entry) => entry.envKeys.includes("AW_CONFORMANCE_MCP_TOKEN")),
	);
	assert.ok(
		starts.every((entry) => !entry.argv.some((arg) => arg.includes(secret))),
	);
	assert.deepEqual(
		log
			.filter((entry) => entry.type === "request")
			.map((entry) => entry.method)
			.slice(0, 4),
		["initialize", "notifications/initialized", "tools/list", "tools/call"],
	);
	assert.deepEqual(await server.toolCalls(), [
		{ name: "echo", arguments: { text: "hello" } },
		{ name: "fail", arguments: {} },
		{ name: "missing", arguments: {} },
	]);
});

test("MCP client times out against a server that never answers", async () => {
	const cli = await createStubCli({
		dir: await dir(),
		scripts: [{ name: "mute", steps: [{ hang: true }] }],
	});
	await assert.rejects(
		callMcpTool(
			{ name: "mute", command: cli.path, args: [] },
			"echo",
			{},
			{ timeoutMs: 200 },
		),
		/timed out/,
	);
});
