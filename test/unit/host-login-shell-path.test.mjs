// 2026-11-05 (live: the ChatGPT app's Codex started the MCP server with PATH=/usr/bin:/bin:… only and
// the claude executor was not found: "spawn claude ENOENT"). The server adds the login shell's PATH
// entries before any tool call (as kimi-code, trilium and cline do). No real login shell or CLI runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const shellPath = await import("../../dist/hosts/login-shell-path.js");
const MARK = "__AGENT_WORKFLOW_LOGIN_SHELL_ENV__";

let root;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-login-path-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test("the login shell's PATH is read after the marker and merged behind the current PATH", () => {
	assert.equal(
		shellPath.pathFromShellOutput(
			`PATH=/noise\nWelcome!\n${MARK}\nHOME=/h\nPATH=/a:/b\n`,
		),
		"/a:/b",
	);
	assert.equal(
		shellPath.pathFromShellOutput("PATH=/a\n"),
		undefined,
		"no marker: profile output only",
	);
	assert.equal(
		shellPath.mergeLoginShellPath(
			"/usr/bin:/bin",
			"/x:/usr/bin:relative::.:/y",
		),
		"/usr/bin:/bin:/x:/y",
	);
	assert.equal(
		shellPath.mergeLoginShellPath("/usr/bin", "/usr/bin"),
		"/usr/bin",
	);
	assert.equal(shellPath.mergeLoginShellPath(undefined, "/a:/b"), "/a:/b");
});

test("adoptLoginShellPath runs -l and -i -l, adds both, and leaves PATH alone when it cannot", async () => {
	const calls = [];
	const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
	const added = await shellPath.adoptLoginShellPath(env, {
		platform: "darwin",
		run: async (shell, args) => {
			calls.push([shell, ...args.slice(0, -1)]);
			return args[0] === "-i"
				? `rc chatter\n${MARK}\nPATH=/Users/u/.nvm/bin:/usr/bin:/Users/u/.local/bin\n`
				: `${MARK}\nPATH=/Users/u/.local/bin:/usr/local/bin\n`;
		},
	});
	assert.deepEqual(calls, [
		["/bin/zsh", "-l", "-c"],
		["/bin/zsh", "-i", "-l", "-c"],
	]);
	assert.equal(
		env.PATH,
		"/usr/bin:/bin:/Users/u/.local/bin:/usr/local/bin:/Users/u/.nvm/bin",
	);
	assert.deepEqual(added, [
		"/Users/u/.local/bin",
		"/usr/local/bin",
		"/Users/u/.nvm/bin",
	]);
	// A broken or hanging interactive shell: the other result still counts; nothing throws.
	const half = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
	await shellPath.adoptLoginShellPath(half, {
		platform: "darwin",
		run: async (_shell, args) =>
			args[0] === "-i"
				? Promise.reject(new Error("boom"))
				: `${MARK}\nPATH=/opt/x\n`,
	});
	assert.equal(half.PATH, "/usr/bin:/opt/x");
	for (const [env2, platform] of [
		[
			{
				PATH: "/usr/bin",
				SHELL: "/bin/zsh",
				AGENT_WORKFLOW_LOGIN_SHELL_PATH: "0",
			},
			"darwin",
		],
		[{ PATH: "/usr/bin", SHELL: "/bin/zsh" }, "win32"],
		[{ PATH: "/usr/bin", SHELL: "/bin/tcsh" }, "darwin"],
	]) {
		let ran = false;
		assert.deepEqual(
			await shellPath.adoptLoginShellPath(env2, {
				platform,
				run: async () => ((ran = true), ""),
			}),
			[],
		);
		assert.equal(ran, false);
		assert.equal(env2.PATH, "/usr/bin");
	}
});

test("the MCP server finds a CLI that only the login shell's PATH has", async () => {
	const bin = join(root, "user-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(bin, "claude"),
		"#!/bin/sh\necho '2.1.318 (Claude Code)'\n",
	);
	await chmod(join(bin, "claude"), 0o755);
	// A stand-in login shell: prints the marker and a PATH with the user's bin directory.
	const shell = join(root, "fake-shell");
	await writeFile(
		shell,
		`#!/bin/sh\necho "profile says hi"\necho ${MARK}\necho "PATH=${bin}:/usr/bin:/bin"\n`,
	);
	await chmod(shell, 0o755);
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	const doctor = (extraEnv) =>
		new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					join(process.cwd(), "dist/mcp/host-server/server.js"),
					"--host",
					"codex",
				],
				{
					cwd: project,
					env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: shell, ...extraEnv },
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let out = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
				const reply = out
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 2);
				if (reply) {
					child.kill();
					resolve(reply.result.content.map((part) => part.text).join("\n"));
				}
			});
			child.on("error", reject);
			const send = (message) =>
				child.stdin.write(`${JSON.stringify(message)}\n`);
			send({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "t", version: "0" },
				},
			});
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			send({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "workflow_doctor", arguments: {} },
			});
		});
	const line = (text) =>
		text.split("\n").find((l) => /^\s*claude\s/.test(l)) ?? "";
	assert.doesNotMatch(line(await doctor({})), /not installed/);
	assert.match(
		line(await doctor({ AGENT_WORKFLOW_LOGIN_SHELL_PATH: "0" })),
		/not installed/,
	);
});
