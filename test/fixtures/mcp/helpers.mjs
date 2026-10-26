// Shared fixtures for test/unit/mcp-*.test.mjs (WP5 workflow_artifact MCP server).
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeArtifactAccessConfig } from "../../../dist/core/artifact-access.js";

export const root = fileURLToPath(new URL("../../..", import.meta.url));
export const SERVER = join(root, "dist", "mcp", "artifact-server", "server.js");
const PRODUCER = fileURLToPath(new URL("./producer/", import.meta.url));

export const RUN_ID = "workflow_wp5_fixture";
export const TASK_ID = "consumer";

/**
 * Temp project with one workflow run: `tasks/producer` holds the static artifacts from
 * test/fixtures/mcp/producer, `tasks/consumer` holds the source manifest, the
 * artifact-access.json config and (after reads) the read ledger.
 */
export async function createRunFixture(options = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "aw-mcp-fixture-"));
	const runDir = join(cwd, ".agent-workflow", "runs", RUN_ID);
	const producerDir = join(runDir, "tasks", "producer");
	const taskDir = join(runDir, "tasks", TASK_ID);
	await mkdir(producerDir, { recursive: true });
	await mkdir(taskDir, { recursive: true });
	for (const name of [
		"control.json",
		"analysis.md",
		"refs.json",
		"prompt.md",
		"raw.txt",
	])
		await copyFile(join(PRODUCER, name), join(producerDir, name));
	const artifact = (name, mediaType) => ({
		path: join(producerDir, name),
		mediaType,
	});
	const sources = options.sources ?? [
		{
			source: "producer",
			taskId: "producer",
			specId: "producer",
			stageId: "producer",
			status: options.status ?? "completed",
			artifacts: {
				control: artifact("control.json", "application/json"),
				analysis: artifact("analysis.md", "text/markdown"),
				refs: artifact("refs.json", "application/json"),
				raw: artifact("raw.txt", "text/plain"),
				prompt: artifact("prompt.md", "text/markdown"),
			},
		},
	];
	const manifestPath = join(taskDir, "source-manifest.json");
	const ledgerPath = join(taskDir, "read-ledger.jsonl");
	await writeFile(
		manifestPath,
		`${JSON.stringify({
			schema: "workflow-source-manifest-v1",
			runId: options.manifestRunId ?? RUN_ID,
			taskId: TASK_ID,
			sources,
			...(options.policy ? { policy: options.policy } : {}),
		})}\n`,
	);
	const config = {
		version: 1,
		runId: RUN_ID,
		taskId: TASK_ID,
		manifestPath,
		ledgerPath,
		accessMode: options.accessMode ?? "workflow-task",
		runDir,
		...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
		...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
	};
	const { path: configPath } = await writeArtifactAccessConfig(config);
	return {
		cwd,
		runDir,
		producerDir,
		taskDir,
		manifestPath,
		ledgerPath,
		configPath,
		config,
	};
}

/**
 * Spawn the built server and speak raw newline-delimited JSON-RPC to it. Every stdout line is
 * kept so tests can assert stdout carries protocol only.
 */
export function startServer(args, options = {}) {
	const child = spawn(process.execPath, [SERVER, ...args], {
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = [];
	const waiters = [];
	let stdoutBuffer = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		for (;;) {
			const index = stdoutBuffer.indexOf("\n");
			if (index === -1) break;
			const line = stdoutBuffer.slice(0, index);
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			lines.push(line);
			const message = JSON.parse(line);
			for (const waiter of [...waiters])
				if (waiter.match(message)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(message);
				}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	let nextId = 0;
	const waitFor = (match, timeoutMs = 10_000) =>
		new Promise((resolve, reject) => {
			const existing = lines.map((line) => JSON.parse(line)).find(match);
			if (existing !== undefined) return resolve(existing);
			const timer = setTimeout(() => {
				reject(new Error(`no matching MCP message; stderr: ${stderr}`));
			}, timeoutMs);
			waiters.push({
				match,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
		});
	const api = {
		child,
		lines,
		exited,
		get stderr() {
			return stderr;
		},
		send(line) {
			child.stdin.write(line);
		},
		sendJson(message) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		},
		waitFor,
		async request(method, params) {
			nextId += 1;
			const id = nextId;
			api.sendJson({ jsonrpc: "2.0", id, method, params });
			return await waitFor((message) => message.id === id);
		},
		notify(method, params) {
			api.sendJson({ jsonrpc: "2.0", method, params });
		},
		async initialize(protocolVersion = "2025-06-18") {
			const response = await api.request("initialize", {
				protocolVersion,
				capabilities: {},
				clientInfo: { name: "aw-mcp-test", version: "0.0.0" },
			});
			api.notify("notifications/initialized");
			return response;
		},
		async callTool(args) {
			const response = await api.request("tools/call", {
				name: "workflow_artifact",
				arguments: args,
			});
			if (response.error) throw new Error(JSON.stringify(response.error));
			return response.result;
		},
		async close() {
			child.stdin.end();
			return await exited;
		},
	};
	return api;
}

/** Run the server until it exits (startup refusal tests). */
export async function runServerToExit(args, options = {}) {
	const server = startServer(args, options);
	const timer = setTimeout(() => server.child.kill("SIGKILL"), 10_000);
	if (options.input !== undefined) server.send(options.input);
	server.child.stdin.end();
	const result = await server.exited;
	clearTimeout(timer);
	return { ...result, stdout: server.lines.join("\n"), stderr: server.stderr };
}

export function resultText(result) {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
