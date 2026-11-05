// 2026-11-05 (owner: fewer host model turns while waiting). One workflow_wait call waits up to 30 min
// where the host's per-call limit allows it (Claude Code; the Codex plugin's tool_timeout_sec), else
// 45 s; Codex is told how to keep its code-mode cell from yielding. A Claude Code launch that starts
// a project's first run waits briefly for the session's completion monitor instead of falling back
// to workflow_wait. Fake host API; no model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const tools = await import("../../dist/mcp/host-server/tools.js");
const notify = await import("../../dist/hosts/notify-check.js");

const MIN30 = 30 * 60_000;
const SESSION = "0b516ad5-f7fe-4ce9-af65-4427b25a175f";
let root;
let counter = 0;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-wait-slices-")));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function project() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	await mkdir(cwd, { recursive: true });
	return cwd;
}

test("the wait slice follows the host's per-call limit", () => {
	const slice = tools.hostMcpWaitSliceMs;
	assert.equal(slice({ host: "codex", env: {} }), 45_000);
	assert.equal(slice({ host: "generic", env: { CLAUDECODE: "1" } }), 45_000);
	assert.equal(
		slice({ host: "claude-code", env: {} }),
		45_000,
		"not started by Claude Code (desktop chat, hand registration)",
	);
	assert.equal(slice({ host: "claude-code", env: { CLAUDECODE: "1" } }), MIN30);
	assert.equal(
		slice({
			host: "claude-code",
			env: { CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "60000" },
		}),
		45_000,
	);
	assert.equal(
		slice({
			host: "claude-code",
			env: { CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "600000" },
		}),
		480_000,
	);
	assert.equal(
		slice({
			host: "claude-code",
			env: { CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "x" },
		}),
		MIN30,
	);
	assert.equal(
		slice({ host: "codex", env: {}, toolTimeoutMs: 1_920_000 }),
		MIN30,
	);
	assert.equal(
		slice({ host: "codex", env: {}, toolTimeoutMs: 120_000 }),
		45_000,
	);
});

test("instructions and the workflow_wait definition name the bound", () => {
	assert.match(tools.hostMcpInstructions(), /waits at most 45 s per call/);
	assert.match(
		tools.hostMcpInstructions(MIN30),
		/waits at most 30 min per call/,
	);
	assert.ok(tools.hostMcpInstructions(MIN30).length < 4096);
	const wait = (defs) => defs.find((tool) => tool.name === "workflow_wait");
	const short = wait(tools.hostMcpToolDefinitions("2025-06-18"));
	const long = wait(tools.hostMcpToolDefinitions("2025-06-18", MIN30));
	assert.equal(short.inputSchema.properties.timeoutMs.maximum, 45_000);
	assert.equal(long.inputSchema.properties.timeoutMs.maximum, MIN30);
	assert.match(long.description, /at most 30 min per call/);
	assert.equal(tools.HOST_MCP_INSTRUCTIONS, tools.hostMcpInstructions());
});

function fakeApi({ onWait, onRun } = {}) {
	return new Proxy(
		{},
		{
			get(_, name) {
				if (name === "registerTestExecutorFromEnv")
					return async () => undefined;
				if (name === "waitAction")
					return async (ctx, request) => {
						onWait?.(request);
						return {
							action: "wait",
							ok: true,
							outcome: "running",
							text: "still running",
							data: {
								runId: request.runId,
								status: "running",
								semanticStatus: "running",
								terminal: false,
								actionRequired: false,
								stillRunning: true,
								timeoutMs: request.timeoutMs ?? 45_000,
								blockedTaskIds: [],
								taskSummary: {
									total: 1,
									completed: 0,
									failed: 0,
									interrupted: 0,
									pending: 0,
									running: 1,
									blocked: 0,
									skipped: 0,
								},
								outputTaskIds: [],
								outputRetryAttempts: 0,
								launchRetryAttempts: 0,
								artifactRoot: "",
								reportArtifacts: [],
							},
						};
					};
				if (name === "runWorkflowAction")
					return async (ctx) => {
						const runId = `workflow_slice${counter}`;
						await onRun?.(ctx, runId);
						return {
							action: "run",
							ok: true,
							outcome: "running",
							text: "Workflow started: deep-review",
							data: {
								runId,
								status: "running",
								name: "deep-review",
								detached: { pid: 1, logPath: "x" },
							},
						};
					};
				return undefined;
			},
		},
	);
}

const callContext = (meta) => ({
	protocolVersion: "2025-06-18",
	clientCapabilities: {},
	signal: new AbortController().signal,
	sendRequest: async () => ({}),
	sendNotification: () => undefined,
	...(meta ? { meta } : {}),
});
const textOf = (result) => result.content.map((part) => part.text).join("\n");

test("workflow_wait waits up to the slice: a long wait, capped at the slice; the default stays 45 s", async () => {
	const cwd = await project();
	const requests = [];
	const service = (waitSliceMs) =>
		tools.createHostMcpService({
			root: cwd,
			host: "claude-code",
			env: {},
			api: fakeApi({ onWait: (r) => requests.push(r) }),
			...(waitSliceMs ? { waitSliceMs } : {}),
		});
	await service(MIN30).call(
		"workflow_wait",
		{ runId: "workflow_x" },
		callContext(),
	);
	await service(MIN30).call(
		"workflow_wait",
		{ runId: "workflow_x", timeoutMs: 4 * 3_600_000 },
		callContext(),
	);
	await service(MIN30).call(
		"workflow_wait",
		{ runId: "workflow_x", timeoutMs: 60_000 },
		callContext(),
	);
	await service().call("workflow_wait", { runId: "workflow_x" }, callContext());
	assert.deepEqual(
		requests.map((r) => [r.longWait ?? false, r.timeoutMs]),
		[
			[true, MIN30],
			[true, MIN30],
			[true, 60_000],
			[false, undefined],
		],
	);
});

test("Codex with a long slice is told to keep the code-mode cell from yielding; other hosts are not", async () => {
	const cwd = await project();
	const run = async (host, waitSliceMs) =>
		textOf(
			await tools
				.createHostMcpService({
					root: cwd,
					host,
					env: {},
					api: fakeApi(),
					...(waitSliceMs ? { waitSliceMs } : {}),
				})
				.call(
					"workflow_run",
					{ workflow: "deep-review", task: "t" },
					callContext(),
				),
		);
	const pragma = `// @exec: {"yield_time_ms": ${MIN30 + 30_000}}`;
	assert.ok((await run("codex", MIN30)).includes(pragma));
	assert.ok(!(await run("codex")).includes("@exec"));
	assert.ok(!(await run("generic", MIN30)).includes("@exec"));
	const waited = textOf(
		await tools
			.createHostMcpService({
				root: cwd,
				host: "codex",
				env: {},
				api: fakeApi(),
				waitSliceMs: MIN30,
			})
			.call("workflow_wait", { runId: "workflow_x" }, callContext()),
	);
	assert.match(
		waited,
		/Next: call workflow_wait \{"runId":"workflow_x"\} again\. In Codex code mode, begin that exec cell with/,
	);
});

test("a project's first run from a Claude Code session waits for the session's monitor", async () => {
	const MONITOR =
		/This session's agent-workflow completion monitor \(from the plugin\) reports the run/;
	const WAIT =
		/Then call workflow_wait \{"runId":"workflow_slice\d+"\} and repeat while stillRunning is true\./;
	const launch = async ({
		entrypoint = "cli",
		monitorAfterMs,
		otherRun = false,
		projectDir,
	}) => {
		const cwd = await project();
		if (otherRun)
			await mkdir(
				join(cwd, ".agent-workflow", "workflows", "workflow_earlier"),
				{ recursive: true },
			);
		const env = {
			CLAUDE_CODE_SESSION_ID: SESSION,
			CLAUDE_PROJECT_DIR: projectDir ?? cwd,
			CLAUDE_CODE_ENTRYPOINT: entrypoint,
		};
		const api = fakeApi({
			onRun: async (ctx, runId) => {
				await mkdir(join(ctx.cwd, ".agent-workflow", "workflows", runId), {
					recursive: true,
				});
				// The monitor's shell sees the directory and its CLI writes the session stamp.
				if (monitorAfterMs !== undefined)
					setTimeout(
						() =>
							notify.notifyCheck(ctx.cwd, {
								host: "claude-code",
								session: SESSION,
							}),
						monitorAfterMs,
					);
			},
		});
		const started = Date.now();
		const text = textOf(
			await tools
				.createHostMcpService({
					root: cwd,
					host: "claude-code",
					env,
					api,
					monitorStartWaitMs: 1_500,
				})
				.call(
					"workflow_run",
					{ workflow: "deep-review", task: "t" },
					callContext(),
				),
		);
		return { text, ms: Date.now() - started };
	};
	const first = await launch({ monitorAfterMs: 300 });
	assert.match(first.text, MONITOR);
	// No monitor came (plugin monitor off): the launch waits, at most the bound.
	const none = await launch({});
	assert.match(none.text, WAIT);
	assert.ok(none.ms >= 1_400 && none.ms < 5_000, `${none.ms} ms`);
	// Print mode / Agent SDK run no monitors; not the first run; a session in another directory:
	// no waiting at all.
	for (const options of [
		{ entrypoint: "sdk-cli", monitorAfterMs: 300 },
		{ otherRun: true, monitorAfterMs: 300 },
		{ projectDir: join(root, "elsewhere"), monitorAfterMs: 300 },
	]) {
		const result = await launch(options);
		assert.match(result.text, WAIT, JSON.stringify(options));
		assert.ok(result.ms < 1_000, `${JSON.stringify(options)}: ${result.ms} ms`);
	}
});

test("the server sizes workflow_wait from --tool-timeout-ms and from Claude Code's environment", async () => {
	const cwd = await project();
	const probe = (args, env) =>
		new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[join(process.cwd(), "dist/mcp/host-server/server.js"), ...args],
				{
					cwd,
					env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let out = "";
			let err = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
				const lines = out.trim().split("\n");
				if (lines.length >= 2) {
					child.kill();
					const [init, list] = lines.map((line) => JSON.parse(line));
					const wait = list.result.tools.find(
						(tool) => tool.name === "workflow_wait",
					);
					resolve({
						instructions: init.result.instructions,
						maximum: wait.inputSchema.properties.timeoutMs.maximum,
					});
				}
			});
			child.stderr.on("data", (chunk) => {
				err += chunk;
			});
			child.on("exit", (code) => {
				if (code === 2) resolve({ code, err });
			});
			child.on("error", reject);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
			);
		});
	const codex = await probe(
		["--host", "codex", "--tool-timeout-ms", "1920000"],
		{},
	);
	assert.equal(codex.maximum, MIN30);
	assert.match(codex.instructions, /waits at most 30 min per call/);
	assert.equal((await probe(["--host", "codex"], {})).maximum, 45_000);
	assert.equal(
		(await probe(["--host", "claude-code"], { CLAUDECODE: "1" })).maximum,
		MIN30,
	);
	assert.equal((await probe(["--host", "claude-code"], {})).maximum, 45_000);
	const bad = await probe(["--host", "codex", "--tool-timeout-ms", "soon"], {});
	assert.equal(bad.code, 2);
	assert.match(bad.err, /--tool-timeout-ms takes whole milliseconds/);
});
