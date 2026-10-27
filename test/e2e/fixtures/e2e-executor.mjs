// New in agent-workflow (WP12b): the E2E test executor. `npm run e2e` copies this file into the
// packed consumer project, so `@agwab/agent-workflow/*` resolves to the installed tarball. It is
// registered through the CLI's guarded test-executor hook (AGENT_WORKFLOW_TEST_EXECUTOR_MODULE +
// AGENT_WORKFLOW_TEST_EXECUTOR_ACK=test-only) or used directly as a runtime descriptor module.
//
// No model and no agent CLI: each attempt wraps the SDK fake executor. Like a real worker it reads
// the prompt — the stage id picks the control it answers with — and, when the request carries the
// `workflow_artifact` MCP server, it starts that server (the packed one) and speaks MCP over stdio:
// `initialize`, `list`, then every read the prompt's "Required Workflow Artifact Reads" section asks
// for, following page footers. Every submit, authority decision, MCP read and effect is appended
// to a JSONL effect log, so the parent process observes what happened inside durable workers.
//
// Config (descriptor.config, JSON): effectLog (absolute path, required), id, stepDelayMs.
// The hook descriptor takes them from AW_E2E_EFFECT_LOG, AW_E2E_EXECUTOR_ID, AW_E2E_STEP_DELAY_MS.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "@agwab/agent-workflow/sdk/testing";

export const E2E_EXECUTOR_MODULE = fileURLToPath(import.meta.url);

export function e2eExecutorDescriptor(config) {
	return {
		id: config.id ?? "test-e2e",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: E2E_EXECUTOR_MODULE,
		config,
	};
}

export const testExecutorDescriptor = process.env.AW_E2E_EFFECT_LOG
	? e2eExecutorDescriptor({
			effectLog: process.env.AW_E2E_EFFECT_LOG,
			id: process.env.AW_E2E_EXECUTOR_ID ?? "test-e2e",
			...(process.env.AW_E2E_STEP_DELAY_MS
				? { stepDelayMs: Number(process.env.AW_E2E_STEP_DELAY_MS) }
				: {}),
		})
	: undefined;

function log(path, entry) {
	appendFileSync(
		path,
		`${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
	);
}

/** The stage id from the compiled task prompt (`# Workflow Stage` → `stage=<id>`). */
export function promptStage(prompt) {
	return /^stage=([^\s]+)$/mu.exec(prompt ?? "")?.[1] ?? "task";
}

/**
 * Reads listed under "# Required Workflow Artifact Reads", e.g.
 * `- merge.control: available via workflow_artifact read with source="merge", artifact="control" (path=$, maxChars=15000, count=1).`
 */
export function promptRequiredReads(prompt) {
	const section =
		/# Required Workflow Artifact Reads\n([\s\S]*?)(?:\n# |$)/u.exec(
			prompt ?? "",
		)?.[1];
	if (section === undefined) return [];
	const reads = [];
	for (const line of section.split("\n")) {
		if (!line.startsWith("- ")) continue;
		const args = {};
		for (const [, key, quoted, bare] of line.matchAll(
			/\b(source|artifact|path|maxChars|maxItems)=(?:"([^"]*)"|([^\s,)]+))/gu,
		))
			args[key] =
				quoted ??
				(key === "maxChars" || key === "maxItems" ? Number(bare) : bare);
		if (typeof args.source === "string" && typeof args.artifact === "string")
			reads.push(args);
	}
	return reads;
}

function controlFor(stage) {
	if (stage === "triage")
		return {
			schema: "e2e-triage-control-v1",
			digest: "two review lenses",
			lenses: [
				{ id: "correctness", focus: "logic errors" },
				{ id: "tests", focus: "missing tests" },
			],
		};
	if (stage === "reviewers")
		return {
			schema: "e2e-reviewer-control-v1",
			digest: "lens reviewed",
			findings: [],
		};
	if (stage === "report")
		return {
			schema: "e2e-report-control-v1",
			digest: "report written",
			verdict: "PASS",
		};
	return { schema: "stage-control-v1", digest: `${stage} done` };
}

function finalText(stage) {
	return [
		"<control>",
		JSON.stringify(controlFor(stage)),
		"</control>",
		"<analysis>",
		`e2e ${stage} analysis`,
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
}

/** Minimal newline-delimited JSON-RPC MCP client over the server's stdio. */
async function withMcpServer(server, use) {
	const child = spawn(server.command, server.args, {
		env: { ...process.env, ...(server.env ?? {}) },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map();
	let buffer = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (line === "") continue;
			const message = JSON.parse(line);
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		}
	});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolveCall, rejectCall) => {
			nextId += 1;
			const id = nextId;
			const timer = setTimeout(
				() => rejectCall(new Error(`mcp ${method} timed out; ${stderr}`)),
				20_000,
			);
			pending.set(id, (message) => {
				clearTimeout(timer);
				if (message.error)
					rejectCall(
						new Error(`mcp ${method}: ${JSON.stringify(message.error)}`),
					);
				else resolveCall(message.result);
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	try {
		const init = await request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "agent-workflow-e2e", version: "0.0.0" },
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		return await use({
			serverInfo: init.serverInfo,
			call: async (args) => {
				const result = await request("tools/call", {
					name: "workflow_artifact",
					arguments: args,
				});
				return {
					text: result.content?.[0]?.text ?? "",
					isError: result.isError === true,
				};
			},
		});
	} finally {
		child.stdin.end();
		await exited;
	}
}

async function readArtifacts(req, effectLog) {
	const server = (req.mcpServers ?? []).find(
		(entry) => entry.name === "workflow_artifact",
	);
	if (server === undefined) return;
	await withMcpServer(server, async ({ serverInfo, call }) => {
		const listed = await call({ action: "list" });
		const sources = JSON.parse(listed.text).sources.map(
			(entry) => entry.source,
		);
		log(effectLog, {
			type: "artifact-list",
			attemptKey: req.attemptKey,
			server: serverInfo?.name ?? null,
			sources,
		});
		for (const read of promptRequiredReads(req.prompt)) {
			let offset;
			let pages = 0;
			let result;
			do {
				result = await call({
					action: "read",
					...read,
					...(offset === undefined ? {} : { offset }),
				});
				pages += 1;
				offset = Number(
					/call again with offset=(\d+)/u.exec(result.text)?.[1] ?? Number.NaN,
				);
			} while (!result.isError && Number.isFinite(offset) && pages < 64);
			log(effectLog, {
				type: result.isError ? "artifact-read-failed" : "artifact-read",
				attemptKey: req.attemptKey,
				...read,
				pages,
			});
		}
	});
}

export function createExecutor(config) {
	const effectLog = config?.effectLog;
	if (typeof effectLog !== "string")
		throw new Error("e2e executor needs effectLog");
	const id = config.id ?? "test-e2e";
	const inners = new Map();
	const innerFor = (req) => {
		let inner = inners.get(req.attemptKey);
		if (inner === undefined) {
			const text = finalText(promptStage(req.prompt));
			inner = createFakeExecutor({
				id,
				version: "0.1.0",
				script: [
					{ type: "started", sessionId: null },
					{ type: "message_delta", text },
					{
						type: "usage",
						input: 3,
						output: 2,
						cached: null,
						cost: null,
						source: "unknown",
					},
					{ type: "completed", finalText: text },
				],
				...(config.stepDelayMs === undefined
					? {}
					: { stepDelayMs: config.stepDelayMs }),
			});
			inners.set(req.attemptKey, inner);
		}
		return inner;
	};
	const probeInner = createFakeExecutor({ id, version: "0.1.0" });
	return {
		id,
		version: "0.1.0",
		contractVersion: "0.1.0",
		probe: () => probeInner.probe(),
		capabilities: () => probeInner.capabilities(),
		async submit(req) {
			log(effectLog, {
				type: "submit",
				attemptKey: req.attemptKey,
				stage: promptStage(req.prompt),
				readOnly: req.readOnly,
				permissionMode: req.permissionMode ?? null,
				tools: req.tools,
				mcpServers: (req.mcpServers ?? []).map((server) => server.name),
				systemPromptNamesArtifactTool:
					req.systemPrompt?.includes(
						"mcp__workflow_artifact__workflow_artifact",
					) === true,
			});
			const inner = innerFor(req);
			const authority = {
				attemptKey: req.authority.attemptKey,
				async consume() {
					const decision = await req.authority.consume();
					log(effectLog, {
						type: "consume",
						attemptKey: req.attemptKey,
						outcome: decision.kind,
					});
					if (decision.kind === "released") await readArtifacts(req, effectLog);
					return decision;
				},
			};
			const before = inner.effectCount(req.attemptKey);
			try {
				return await inner.submit({ ...req, authority });
			} finally {
				if (inner.effectCount(req.attemptKey) > before)
					log(effectLog, { type: "effect", attemptKey: req.attemptKey });
			}
		},
		observe: (ref) => inners.get(ref.attemptKey).observe(ref),
		async cancel(ref, scope) {
			const inner = inners.get(ref.attemptKey);
			const result =
				inner === undefined ? "no_active" : await inner.cancel(ref, scope);
			log(effectLog, { type: "cancel", attemptKey: ref.attemptKey, result });
			return result;
		},
		async reconcile(attemptKey) {
			const inner = inners.get(attemptKey);
			return inner === undefined
				? { unknown: true, reason: "attempt unknown to this process" }
				: await inner.reconcile(attemptKey);
		},
		respond: (ref, requestId, decision) =>
			inners.get(ref.attemptKey).respond(ref, requestId, decision),
	};
}
