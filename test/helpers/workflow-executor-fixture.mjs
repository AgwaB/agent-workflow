// New in agent-workflow (WP4c-1): an executor module the engine's task backend selects through the
// executor registry and that a durable worker reloads from its descriptor in a fresh process. It
// wraps the SDK fake executor (no model or CLI calls) and appends every submit, authority decision,
// effect, artifact read, reconcile and owned-session deletion to a JSONL effect log, so a test
// observes what happened in the worker process.
//
// Config (descriptor.config, JSON):
//   effectLog     absolute JSONL path (required)
//   id            executor id (default "wf-fake")
//   mode          "normal" | "crash-after-consume" (reconcile then says unknown → needs_decision)
//   reads         [{source, artifact}] read through the workflow_artifact config when the request
//                 carries the workflow_artifact MCP server (stands in for the WP5 MCP server)
//   ownSessions   true: the terminal event reports ownedSession {kind: "wf-fake-session", locator}
//   stepDelayMs   delay between script steps
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "@agwab/agent-workflow/sdk/testing";
import { handleWorkflowArtifactToolCall } from "../../dist/core/workflow-artifact-tool.js";

export const WORKFLOW_EXECUTOR_FIXTURE_MODULE = fileURLToPath(import.meta.url);

export function workflowFixtureDescriptor(config) {
	return {
		id: config.id ?? "wf-fake",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: WORKFLOW_EXECUTOR_FIXTURE_MODULE,
		config,
	};
}

export function readFixtureLog(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

function log(path, entry) {
	appendFileSync(
		path,
		`${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
	);
}

/** Final answer in the workflow output protocol (control / analysis / refs). */
export function workflowFinalText(label) {
	return [
		"<control>",
		JSON.stringify({ schema: "stage-control-v1", digest: `${label} done` }),
		"</control>",
		"<analysis>",
		`${label} analysis`,
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
}

function scriptFor(req, config) {
	const label = req.attemptKey.split(":")[2] ?? "task";
	const finalText = workflowFinalText(label);
	return [
		{ type: "started", sessionId: null },
		{ type: "message_delta", text: finalText },
		{
			type: "usage",
			input: 10,
			output: 5,
			cached: null,
			cost: null,
			source: "unknown",
		},
		{
			type: "completed",
			finalText,
			...(config.ownSessions === true
				? {
						ownedSession: {
							kind: "wf-fake-session",
							locator: `session-${req.attemptKey.replaceAll(":", "_")}`,
						},
					}
				: {}),
		},
	];
}

async function readArtifacts(req, config, effectLog) {
	const server = (req.mcpServers ?? []).find(
		(entry) => entry.name === "workflow_artifact",
	);
	if (server === undefined) return;
	const configPath = server.args[server.args.indexOf("--config") + 1];
	const { version: _version, ...access } = JSON.parse(
		readFileSync(configPath, "utf8"),
	);
	for (const read of config.reads ?? []) {
		try {
			await handleWorkflowArtifactToolCall(
				{ action: "read", source: read.source, artifact: read.artifact },
				access,
			);
			log(effectLog, {
				type: "artifact-read",
				attemptKey: req.attemptKey,
				...read,
			});
		} catch (error) {
			log(effectLog, {
				type: "artifact-read-failed",
				attemptKey: req.attemptKey,
				...read,
				message: String(error?.message ?? error),
			});
		}
	}
}

export function createExecutor(config) {
	const effectLog = config?.effectLog;
	if (typeof effectLog !== "string") throw new Error("fixture needs effectLog");
	const id = config.id ?? "wf-fake";
	const inners = new Map();
	const innerFor = (req) => {
		let inner = inners.get(req.attemptKey);
		if (inner === undefined) {
			inner = createFakeExecutor({
				id,
				version: "0.1.0",
				script: scriptFor(req, config),
				...(config.stepDelayMs === undefined
					? {}
					: { stepDelayMs: config.stepDelayMs }),
				faults: { crashAfterConsume: config.mode === "crash-after-consume" },
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
				cwd: req.cwd,
				model: req.model ?? null,
				effort: req.effort ?? null,
				tools: req.tools,
				readOnly: req.readOnly,
				isolation: req.isolation,
				approvalAllowKinds: req.approvalPolicy?.allowKinds ?? null,
				mcpServers: (req.mcpServers ?? []).map((server) => server.name),
				envKeys: Object.keys(req.env ?? {}).sort(),
				hasSystemPrompt: typeof req.systemPrompt === "string",
				artifactsDir: req.artifactsDir ?? null,
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
					if (decision.kind === "released")
						await readArtifacts(req, config, effectLog);
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
			const result =
				inner === undefined
					? { unknown: true, reason: "attempt unknown to this process" }
					: await inner.reconcile(attemptKey);
			log(effectLog, { type: "reconcile", attemptKey, result });
			return result;
		},
		respond: (ref, requestId, decision) =>
			inners.get(ref.attemptKey).respond(ref, requestId, decision),
		async deleteOwnedSession(session) {
			log(effectLog, { type: "delete-owned-session", ...session });
			return "deleted";
		},
	};
}
