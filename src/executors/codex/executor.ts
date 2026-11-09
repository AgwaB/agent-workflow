/**
 * Codex executor adapter (WP7): `codex app-server` JSON-RPC over stdio, one app-server process
 * per attempt. Effect boundary (R#1): `authority.consume()` runs immediately before the process
 * is spawned. Everything the worker gets — sandbox, approval routing, isolation (B5), injected
 * MCP servers including their env values — travels as `thread/start` parameters over stdin, so
 * argv carries no secret (prior-art §3 #8). Approval requests become `approval_request` events
 * answered through `respond()`; the adapter auto-approves nothing (D2). Permission mode (WP4e):
 * `free` on every stage starts the thread with `sandbox: "danger-full-access"` and
 * `approvalPolicy: "never"`; `safe` (or absent) keep the mapped sandbox and
 * `approvalPolicy: "on-request"`. Threads are ephemeral unless the request asks to keep a session
 * (D3).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalDecision } from "../../sdk/approval.js";
import { requireReleased } from "../../sdk/authority.js";
import type { ExecutorCapabilities } from "../../sdk/capabilities.js";
import {
	type ApprovalResponseResult,
	type CancelResult,
	type CancelScope,
	type DeleteOwnedSessionResult,
	EXECUTOR_CONTRACT_VERSION,
	type ExecRef,
	type ExecutorProbe,
	type ReconcileResult,
	type SubmitRequest,
	validateSubmitRequest,
	type WorkflowExecutor,
} from "../../sdk/contract.js";
import { SdkError } from "../../sdk/errors.js";
import type { ExecEvent, OwnedSession, ToolKind } from "../../sdk/events.js";
import type { JsonValue } from "../../sdk/json.js";
import { enforcesReadOnly } from "../../sdk/permission.js";
import {
	ARTIFACT_MCP_SERVER_NAME,
	WORKFLOW_ARTIFACT_TOOL_NAME,
} from "../../core/artifact-access.js";
import { mcpPrefixedToolName } from "../../mcp/visible-names.js";
import {
	CODEX_MCP_OUTPUT_LIMIT_CHARS,
	CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
	CODEX_VERIFIED_CLI_VERSION,
	codexCapabilities,
} from "./capabilities.js";
import { prepareCodexWorkerHome, removeCodexWorkerHome } from "./home.js";
import {
	codexEnvironmentCapabilities,
	codexEnvironmentNotes,
	codexHomeDir,
	inspectCodexEnvironment,
} from "./environment.js";
import { classifyCodexFailure } from "./errors.js";
import { CodexStderrParser } from "./stderr.js";
import { codexPermissionMismatch } from "./permissions.js";
import { CodexTurnNormalizer, failureEvent } from "./normalize.js";
import { AppServerConnection, type RpcId, type RpcMessage } from "./rpc.js";
import {
	AttemptStore,
	attemptDigest,
	classifyCodexAttemptRecord,
	defaultStateDir,
	processAlive,
	ThreadOwnershipStore,
} from "./state.js";
import { schedulePeriodicAdapterStatePrune } from "../state-retention.js";
import { CODEX_TOOL_MAPPING, planCodexTools } from "./tools.js";
import { executorModelId } from "../../core/executor-model-id.js";

/** Resolve cross-executor model names such as `openai-codex/<id>` to the Codex CLI form. */
function codexModel(model: string | undefined): string | undefined {
	if (model === undefined || model === "") return model;
	const translated = executorModelId("codex", model);
	return "model" in translated ? translated.model : model;
}
import {
	createSecretRedactor,
	requestSecrets,
	type SecretRedactor,
	type StreamRedactor,
} from "../redact.js";

import { CODEX_ADAPTER_VERSION, CODEX_EXECUTOR_ID } from "./version.js";

export { CODEX_ADAPTER_VERSION, CODEX_EXECUTOR_ID };
export const CODEX_OWNED_SESSION_KIND = "codex-thread";
/** Raw app-server transcript written under `SubmitRequest.artifactsDir` (D3). */
export const CODEX_RAW_TRANSCRIPT = "codex-app-server.jsonl";

export interface CodexExecutorConfig {
	/** CLI binary (default `codex` on PATH). */
	readonly codexPath?: string;
	/** Durable attempt evidence (default `$AGENT_WORKFLOW_HOME/executors/codex`). */
	readonly stateDir?: string;
	/** Per injected MCP server `tool_timeout_sec` (default 300). */
	readonly mcpToolTimeoutSec?: number;
	/** Per injected MCP server `startup_timeout_sec` (default 30). */
	readonly mcpStartupTimeoutSec?: number;
	/** Per-run `tool_output_token_limit` (C1 output cap; default 10000). */
	readonly toolOutputTokenLimit?: number;
	/** Grace after `turn/interrupt` before the process group is killed (default 2500 ms). */
	readonly cancelGraceMs?: number;
	/** Test-only fault hooks (conformance `crash_after_consume`). */
	readonly testFaults?: { readonly crashAfterConsume?: boolean };
}

const OPT_OUT_NOTIFICATIONS = [
	"item/reasoning/summaryTextDelta",
	"item/reasoning/summaryPartAdded",
	"item/reasoning/textDelta",
	"item/commandExecution/outputDelta",
	"item/fileChange/outputDelta",
	"command/exec/outputDelta",
	"process/outputDelta",
	// Account and host details the engine has no use for (D1: keep them out of run records).
	"account/updated",
	"account/rateLimits/updated",
	"remoteControl/status/changed",
];

/** Notifications whose params never reach the raw transcript (account/host details). */
const REDACTED_NOTIFICATIONS =
	/^(?:account\/|remoteControl\/|mcpServer\/oauth)/u;

/** Server → client requests that are approvals (answered through `respond`). */
const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);

interface PendingApproval {
	readonly rpcId: RpcId;
	readonly method: string;
	readonly params: Record<string, unknown>;
	timer?: ReturnType<typeof setTimeout>;
}

interface Run {
	ref: ExecRef;
	readonly attemptKey: string;
	readonly req: SubmitRequest;
	readonly log: ExecEvent[];
	done: boolean;
	readonly waiters: (() => void)[];
	child: ChildProcessWithoutNullStreams | undefined;
	conn: AppServerConnection | undefined;
	threadId?: string;
	turnId?: string;
	readonly normalizer: CodexTurnNormalizer;
	cancelRequested: boolean;
	readonly pending: Map<string, PendingApproval>;
	readonly answered: Set<string>;
	ownedSession?: OwnedSession;
	readonly rawPath: string | undefined;
	readonly methodsById: Map<RpcId, string>;
	stderr: string;
	/** Request env / MCP env values: never persisted (review #5). */
	readonly redact: SecretRedactor;
	readonly stderrRedact: StreamRedactor;
}

/** The engine's artifact tool is a read (A2-4); other MCP tools use their readOnlyHint. */
const ARTIFACT_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
	[mcpPrefixedToolName(ARTIFACT_MCP_SERVER_NAME, WORKFLOW_ARTIFACT_TOOL_NAME)]:
		"read",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

function parseConfig(config: JsonValue | undefined): CodexExecutorConfig {
	if (config === null || config === undefined) return {};
	if (!isRecord(config))
		throw new SdkError(
			"DESCRIPTOR_INVALID",
			"codex executor config must be an object",
		);
	const out: Record<string, unknown> = {};
	for (const key of ["codexPath", "stateDir"] as const)
		if (config[key] !== undefined) {
			if (typeof config[key] !== "string")
				throw new SdkError(
					"DESCRIPTOR_INVALID",
					`codex config.${key} must be a string`,
				);
			out[key] = config[key];
		}
	for (const key of [
		"mcpToolTimeoutSec",
		"mcpStartupTimeoutSec",
		"toolOutputTokenLimit",
		"cancelGraceMs",
	] as const)
		if (config[key] !== undefined) {
			const value = config[key];
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
				throw new SdkError(
					"DESCRIPTOR_INVALID",
					`codex config.${key} must be a positive number`,
				);
			out[key] = value;
		}
	if (isRecord(config.testFaults))
		out.testFaults = {
			crashAfterConsume: config.testFaults.crashAfterConsume === true,
		};
	return out as CodexExecutorConfig;
}

/** Human-readable approval detail (command, reason, paths). */
function approvalDetail(
	method: string,
	params: Record<string, unknown>,
): string {
	const parts: string[] = [];
	const command = params.command;
	if (typeof command === "string") parts.push(command);
	else if (Array.isArray(command)) parts.push(command.join(" "));
	if (typeof params.reason === "string" && params.reason !== "")
		parts.push(`reason: ${params.reason}`);
	if (typeof params.grantRoot === "string")
		parts.push(`grantRoot: ${params.grantRoot}`);
	if (isRecord(params.permissions))
		parts.push(`permissions: ${JSON.stringify(params.permissions)}`);
	if (isRecord(params.networkApprovalContext))
		parts.push(`network: ${JSON.stringify(params.networkApprovalContext)}`);
	return parts.length > 0 ? parts.join("; ") : method;
}

function approvalKind(
	method: string,
	params: Record<string, unknown>,
): ToolKind {
	switch (method) {
		case "item/commandExecution/requestApproval":
			return isRecord(params.networkApprovalContext) ? "fetch" : "execute";
		case "execCommandApproval":
			return "execute";
		case "item/fileChange/requestApproval":
		case "applyPatchApproval":
			return "edit";
		case "item/permissions/requestApproval": {
			const permissions = isRecord(params.permissions)
				? params.permissions
				: {};
			if (isRecord(permissions.fileSystem)) return "edit";
			if (isRecord(permissions.network)) return "fetch";
			return "execute";
		}
		default:
			return "other";
	}
}

function approvalResult(
	method: string,
	params: Record<string, unknown>,
	decision: ApprovalDecision,
): JsonValue {
	const allow = decision === "allow";
	switch (method) {
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			// Never acceptForSession: every request is answered on its own (D2).
			return { decision: allow ? "accept" : "decline" };
		case "item/permissions/requestApproval": {
			const requested = isRecord(params.permissions) ? params.permissions : {};
			const granted: Record<string, JsonValue> = {};
			if (allow) {
				if (isRecord(requested.network))
					granted.network = requested.network as JsonValue;
				if (isRecord(requested.fileSystem))
					granted.fileSystem = requested.fileSystem as JsonValue;
			}
			return { permissions: granted, scope: "turn" };
		}
		default:
			return {
				decision: allow
					? "approved"
					: {
							denied: { rejection: "denied by agent-workflow approval policy" },
						},
			};
	}
}

/** Thread config sent with thread/start (over stdin, never argv). */
export function buildThreadConfig(input: {
	readonly req: Pick<
		SubmitRequest,
		"isolation" | "mcpServers" | "tools" | "readOnly" | "permissionMode"
	>;
	readonly userMcpServers: readonly string[];
	readonly toolOutputTokenLimit: number;
	readonly mcpToolTimeoutSec: number;
	readonly mcpStartupTimeoutSec: number;
}): Record<string, JsonValue> {
	const { req } = input;
	const plan = planCodexTools(req.tools, req.readOnly, req.permissionMode);
	const config: Record<string, JsonValue> = {
		web_search: plan.webSearch,
		tool_output_token_limit: input.toolOutputTokenLimit,
		// Worker sub-agents would be uncontrolled model calls outside the engine's slots.
		"features.multi_agent": false,
	};
	if (!req.isolation.inherit) {
		Object.assign(config, {
			project_doc_max_bytes: 0,
			"skills.include_instructions": false,
			"features.plugins": false,
			"features.apps": false,
			"features.hooks": false,
			"features.memories": false,
			include_apps_instructions: false,
			"history.persistence": "none",
			notify: [],
		});
		const ours = new Set(req.mcpServers.map((server) => server.name));
		for (const name of input.userMcpServers)
			if (!ours.has(name)) config[`mcp_servers.${name}.enabled`] = false;
	}
	for (const server of req.mcpServers) {
		const prefix = `mcp_servers.${server.name}`;
		config[`${prefix}.command`] = server.command;
		config[`${prefix}.args`] = [...server.args];
		if (server.env !== undefined && Object.keys(server.env).length > 0)
			config[`${prefix}.env`] = { ...server.env };
		config[`${prefix}.enabled`] = true;
		config[`${prefix}.tool_timeout_sec`] = input.mcpToolTimeoutSec;
		config[`${prefix}.startup_timeout_sec`] = input.mcpStartupTimeoutSec;
	}
	return config;
}

/** Copy of a JSON-RPC message safe for the raw transcript (no MCP env values, no user config). */
export function redactForTranscript(
	message: RpcMessage,
	direction: "in" | "out",
	methodOf: (id: RpcId) => string | undefined,
): RpcMessage {
	if (
		direction === "out" &&
		(message.method === "thread/start" || message.method === "thread/resume") &&
		isRecord(message.params) &&
		isRecord(message.params.config)
	) {
		const config: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(message.params.config))
			config[key] =
				/^mcp_servers\..+\.env$/u.test(key) && isRecord(value)
					? Object.fromEntries(
							Object.keys(value).map((name) => [name, "<redacted>"]),
						)
					: value;
		return { ...message, params: { ...message.params, config } } as RpcMessage;
	}
	if (
		direction === "in" &&
		message.id === undefined &&
		typeof message.method === "string" &&
		REDACTED_NOTIFICATIONS.test(message.method)
	)
		return { method: message.method, params: "<redacted>" };
	if (
		direction === "in" &&
		message.id !== undefined &&
		message.method === undefined
	) {
		const method = methodOf(message.id);
		if (method === "config/read" && isRecord(message.result))
			return {
				...message,
				result: {
					omitted: "user config (may hold secrets)",
					mcpServers: userMcpServerNames(message.result),
				},
			} as RpcMessage;
		if (method === "mcpServerStatus/list" && isRecord(message.result))
			return {
				...message,
				result: { servers: mcpStatusSummary(message.result) },
			} as RpcMessage;
	}
	return message;
}

function userMcpServerNames(result: unknown): string[] {
	if (!isRecord(result) || !isRecord(result.config)) return [];
	const servers = result.config.mcp_servers;
	return isRecord(servers) ? Object.keys(servers).sort() : [];
}

function mcpStatusSummary(result: unknown): { name: string; tools: number }[] {
	if (!isRecord(result) || !Array.isArray(result.data)) return [];
	return result.data.flatMap((entry) =>
		isRecord(entry) && typeof entry.name === "string"
			? [
					{
						name: entry.name,
						tools: isRecord(entry.tools) ? Object.keys(entry.tools).length : 0,
					},
				]
			: [],
	);
}

interface CliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

function runCli(
	path: string,
	args: readonly string[],
	timeoutMs = 15_000,
): Promise<CliResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: CliResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(path, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: null, stdout, stderr, error: String(error) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr, error: "timeout" });
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) =>
			finish({ code: null, stdout, stderr, error: error.message }),
		);
		child.on("close", (code) => finish({ code, stdout, stderr }));
	});
}

/** Map `codex login status` output to the SDK enum (D1: never read credential files). */
export function parseLoginStatus(result: {
	code: number | null;
	stdout: string;
	stderr: string;
}): ExecutorProbe["auth"] {
	const text = `${result.stdout}\n${result.stderr}`;
	if (/not logged in/i.test(text)) return "missing";
	if (/expired/i.test(text)) return "expired";
	if (result.code === 0 && /logged in/i.test(text)) return "ok";
	return "unknown";
}

export function createCodexExecutor(rawConfig?: JsonValue): WorkflowExecutor & {
	listModels(): Promise<string[]>;
	deleteOwnedSession(session: OwnedSession): Promise<DeleteOwnedSessionResult>;
} {
	const config = parseConfig(rawConfig);
	const codexPath = config.codexPath ?? "codex";
	/** Visible models from `codex debug models` (no model turn), with their supported efforts. */
	const codexModelCatalog = async (): Promise<
		Array<{ slug: string; efforts: string[] }>
	> => {
		const result = await runCli(codexPath, ["debug", "models"]);
		if (result.code !== 0) return [];
		try {
			const parsed = JSON.parse(result.stdout) as unknown;
			const list =
				isRecord(parsed) && Array.isArray(parsed.models)
					? parsed.models
					: parsed;
			if (!Array.isArray(list)) return [];
			return list.flatMap((entry) =>
				isRecord(entry) &&
				typeof entry.slug === "string" &&
				entry.visibility !== "hide"
					? [
							{
								slug: entry.slug,
								efforts: Array.isArray(entry.supported_reasoning_levels)
									? entry.supported_reasoning_levels.flatMap((level) =>
											isRecord(level) && typeof level.effort === "string"
												? [level.effort]
												: [],
										)
									: [],
							},
						]
					: [],
			);
		} catch {
			return [];
		}
	};
	const stateDir = config.stateDir ?? defaultStateDir();
	const store = new AttemptStore(stateDir);
	const threads = new ThreadOwnershipStore(stateDir);
	const runs = new Map<string, Run>();
	const inflight = new Map<string, Promise<ExecRef>>();
	const capabilities: ExecutorCapabilities = codexCapabilities();

	const raw = (run: Run, direction: string, message: unknown) => {
		if (run.rawPath === undefined) return;
		try {
			appendFileSync(
				run.rawPath,
				`${JSON.stringify({ at: Date.now(), dir: direction, msg: run.redact.value(message) })}\n`,
				{ mode: 0o600 },
			);
		} catch {
			// raw transcript is best effort; events stay authoritative
		}
	};

	const emit = (run: Run, rawEvent: ExecEvent) => {
		if (run.done) return;
		// Events are persisted by this store and by the runtime: no request secret (review #5).
		const event = run.redact.value(rawEvent);
		run.log.push(event);
		try {
			store.appendEvent(run.attemptKey, event);
		} catch {
			// durable log is best effort for non-terminal events
		}
		if (event.type === "completed" || event.type === "failed") {
			run.done = true;
			for (const pending of run.pending.values())
				if (pending.timer !== undefined) clearTimeout(pending.timer);
			store.write({
				attemptKey: run.attemptKey,
				phase: "terminal",
				ref: run.ref,
				...(run.child?.pid === undefined ? {} : { pid: run.child.pid }),
				...(run.threadId === undefined ? {} : { threadId: run.threadId }),
				terminal: event.type,
			});
			shutdown(run);
		}
		for (const wake of run.waiters.splice(0)) wake();
	};

	const shutdown = (run: Run) => {
		run.conn?.end();
		const child = run.child;
		if (
			child === undefined ||
			child.exitCode !== null ||
			child.signalCode !== null
		)
			return;
		const timer = setTimeout(() => killGroup(child, "SIGKILL"), 3_000);
		timer.unref();
		child.once("close", () => clearTimeout(timer));
	};

	// The app-server stays in the caller's process group (no `detached`): a runtime kill of the
	// worker group takes it down too, and it exits on stdin EOF when its owner dies.
	const killGroup = (
		child: ChildProcessWithoutNullStreams,
		signal: NodeJS.Signals,
	) => {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	};

	const answer = (
		run: Run,
		requestId: string,
		decision: ApprovalDecision,
	): ApprovalResponseResult => {
		if (run.answered.has(requestId)) return "too_late";
		const pending = run.pending.get(requestId);
		if (pending === undefined) return "unknown_request";
		run.pending.delete(requestId);
		run.answered.add(requestId);
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		if (run.done || run.conn === undefined || run.conn.isClosed)
			return "too_late";
		run.conn.respond(
			pending.rpcId,
			approvalResult(pending.method, pending.params, decision),
		);
		return "accepted";
	};

	const onServerRequest = (
		run: Run,
		id: RpcId,
		method: string,
		params: unknown,
	) => {
		const conn = run.conn;
		if (conn === undefined) return;
		const p = isRecord(params) ? params : {};
		if (APPROVAL_METHODS.has(method)) {
			const requestId = `codex-${String(id)}`;
			if (
				run.done ||
				run.pending.has(requestId) ||
				run.answered.has(requestId)
			) {
				conn.respond(id, approvalResult(method, p, "deny"));
				return;
			}
			const pending: PendingApproval = { rpcId: id, method, params: p };
			run.pending.set(requestId, pending);
			// Fail closed (D2): an unanswered approval is denied when the policy timeout expires.
			pending.timer = setTimeout(
				() => answer(run, requestId, "deny"),
				Math.max(0, run.req.approvalPolicy.timeoutMs),
			);
			pending.timer.unref?.();
			emit(run, {
				type: "approval_request",
				requestId,
				kind: approvalKind(method, p),
				detail: approvalDetail(method, p),
			});
			return;
		}
		switch (method) {
			case "mcpServer/elicitation/request":
				// No person behind a worker: elicitations are declined, never accepted (D2).
				conn.respond(id, { action: "decline", content: null, _meta: null });
				return;
			case "item/tool/requestUserInput":
				conn.respond(id, { answers: {} });
				return;
			default:
				conn.respondError(
					id,
					-32601,
					`agent-workflow does not handle ${method}`,
				);
		}
	};

	const onNotification = (run: Run, method: string, params: unknown) => {
		if (method === "turn/completed") {
			const p = isRecord(params) ? params : {};
			const turn = isRecord(p.turn) ? p.turn : {};
			if (
				run.turnId !== undefined &&
				turn.id !== undefined &&
				turn.id !== run.turnId
			)
				return;
			for (const event of run.normalizer.finish(
				{
					...(typeof turn.id === "string" ? { id: turn.id } : {}),
					status: typeof turn.status === "string" ? turn.status : "failed",
					error: isRecord(turn.error) ? (turn.error as never) : null,
				},
				{
					cancelled: run.cancelRequested,
					...(run.ownedSession === undefined
						? {}
						: { ownedSession: run.ownedSession }),
				},
			))
				emit(run, event);
			return;
		}
		if (method === "serverRequest/resolved") {
			const p = isRecord(params) ? params : {};
			const requestId = `codex-${String(p.requestId)}`;
			const pending = run.pending.get(requestId);
			if (pending !== undefined) {
				if (pending.timer !== undefined) clearTimeout(pending.timer);
				run.pending.delete(requestId);
				run.answered.add(requestId);
			}
			return;
		}
		for (const event of run.normalizer.push(method, params)) emit(run, event);
	};

	const ensureStarted = (run: Run) => {
		if (!run.log.some((event) => event.type === "started"))
			emit(run, { type: "started", sessionId: run.threadId ?? null });
	};

	const onClose = (run: Run, error: Error | null) => {
		if (run.done) return;
		ensureStarted(run);
		const tail = run.stderr.slice(-2_000).trim();
		if (run.cancelRequested) {
			emit(
				run,
				failureEvent(
					"codex app-server stopped after a cancel request",
					"cancelled",
					{ stderrTail: tail },
					run.ownedSession,
				),
			);
			return;
		}
		const pendingError = run.normalizer.pendingError;
		const message =
			pendingError?.message ??
			(tail !== ""
				? tail
				: (error?.message ??
					"codex app-server exited before the turn completed"));
		emit(
			run,
			failureEvent(
				message,
				classifyCodexFailure({
					message,
					codexErrorInfo: pendingError?.codexErrorInfo,
					exitCode: run.child?.exitCode ?? null,
				}),
				{
					exitCode: run.child?.exitCode ?? null,
					signal: run.child?.signalCode ?? null,
					stderrTail: tail,
				},
				run.ownedSession,
			),
		);
	};

	/** initialize → (config/read) → thread/start|resume → (isolation guard) → turn/start. */
	const handshake = async (run: Run) => {
		const { req } = run;
		const conn = run.conn;
		if (conn === undefined) return;
		const keep =
			req.sessionId !== undefined || req.resumeSessionId !== undefined;
		try {
			await conn.request("initialize", {
				clientInfo: {
					name: "agent_workflow",
					title: "agent-workflow",
					version: CODEX_ADAPTER_VERSION,
				},
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					optOutNotificationMethods: OPT_OUT_NOTIFICATIONS,
				},
			});
			conn.notify("initialized");
			let userMcpServers: string[] = [];
			if (!req.isolation.inherit)
				userMcpServers = userMcpServerNames(
					await conn.request("config/read", {
						includeLayers: false,
						cwd: req.cwd,
					}),
				);
			const plan = planCodexTools(req.tools, req.readOnly, req.permissionMode);
			const model = codexModel(req.model);
			const threadParams = {
				cwd: req.cwd,
				...(model === undefined ? {} : { model }),
				// WP4e: "never" + danger-full-access for every free-mode stage.
				approvalPolicy: plan.approvalPolicy,
				approvalsReviewer: "user",
				sandbox: plan.sandbox,
				// fastTier is not offered: run on the standard tier whatever the user's config says.
				serviceTier: null,
				...(req.systemPrompt === undefined
					? {}
					: { developerInstructions: req.systemPrompt }),
				config: buildThreadConfig({
					req,
					userMcpServers,
					toolOutputTokenLimit:
						config.toolOutputTokenLimit ?? CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
					mcpToolTimeoutSec: config.mcpToolTimeoutSec ?? 300,
					mcpStartupTimeoutSec: config.mcpStartupTimeoutSec ?? 30,
				}),
			};
			const started = (
				req.resumeSessionId !== undefined
					? await conn.request("thread/resume", {
							threadId: req.resumeSessionId,
							...threadParams,
						})
					: await conn.request("thread/start", {
							...threadParams,
							ephemeral: !keep,
						})
			) as Record<string, unknown>;
			const thread = isRecord(started.thread) ? started.thread : {};
			const threadId = typeof thread.id === "string" ? thread.id : undefined;
			run.threadId = threadId;
			// WP12a: usage names the model the server resolved for the thread.
			run.normalizer.model =
				typeof started.model === "string" && started.model !== ""
					? started.model
					: model !== undefined && model !== ""
						? model
						: undefined;
			if (keep && threadId !== undefined) {
				// Review #9: a thread is owned only when this adapter created it (durable record
				// written here) or resumes one it recorded earlier; a resumed foreign thread is not.
				if (req.resumeSessionId === undefined)
					threads.record(threadId, run.attemptKey);
				if (threads.owns(threadId))
					run.ownedSession = {
						kind: CODEX_OWNED_SESSION_KIND,
						locator: threadId,
					};
				run.ref = { ...run.ref, sessionId: threadId };
				store.write({
					attemptKey: run.attemptKey,
					phase: "spawned",
					ref: run.ref,
					...(run.child?.pid === undefined ? {} : { pid: run.child.pid }),
					threadId,
				});
			}
			emit(run, { type: "started", sessionId: threadId ?? null });
			const mismatch = codexPermissionMismatch(plan, started);
			if (mismatch !== undefined) {
				emit(
					run,
					failureEvent(
						mismatch,
						"config",
						{
							requested: {
								sandbox: plan.sandbox,
								approvalPolicy: plan.approvalPolicy,
							},
							effective: {
								sandbox: (started.sandbox ?? null) as JsonValue,
								approvalPolicy: (started.approvalPolicy ?? null) as JsonValue,
								activePermissionProfile: (started.activePermissionProfile ??
									null) as JsonValue,
							},
						},
						run.ownedSession,
					),
				);
				return;
			}
			if (!req.isolation.inherit && threadId !== undefined) {
				const status = await conn.request("mcpServerStatus/list", {
					threadId,
					detail: "toolsAndAuthOnly",
				});
				const ours = new Set(req.mcpServers.map((server) => server.name));
				const foreign = mcpStatusSummary(status).filter(
					(server) => server.tools > 0 && !ours.has(server.name),
				);
				if (foreign.length > 0) {
					emit(
						run,
						failureEvent(
							`isolation guard: MCP servers outside the request are active (${foreign.map((server) => server.name).join(", ")})`,
							"config",
							{ foreign },
						),
					);
					return;
				}
			}
			if (threadId === undefined) {
				emit(
					run,
					failureEvent(
						"codex app-server returned no thread id",
						"unknown",
						started,
					),
				);
				return;
			}
			const turn = (await conn.request("turn/start", {
				threadId,
				input: [{ type: "text", text: req.prompt, text_elements: [] }],
				...(model === undefined ? {} : { model }),
				...(req.effort === undefined ? {} : { effort: req.effort }),
			})) as Record<string, unknown>;
			if (isRecord(turn.turn) && typeof turn.turn.id === "string")
				run.turnId = turn.turn.id;
		} catch (error) {
			if (run.done) return;
			ensureStarted(run);
			const message = error instanceof Error ? error.message : String(error);
			emit(
				run,
				failureEvent(
					message,
					run.cancelRequested ? "cancelled" : classifyCodexFailure({ message }),
					{ error: message, code: (error as { code?: unknown }).code ?? null },
					run.ownedSession,
				),
			);
		}
	};

	const launch = async (req: SubmitRequest): Promise<ExecRef> => {
		const lookup = store.lookup(req.attemptKey);
		// Unreadable evidence may hide a launch: refuse before consuming (review #3).
		if (lookup.status === "unreadable")
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`codex attempt ${req.attemptKey} has launch evidence that cannot be trusted (${lookup.reason}); reconcile reports unknown`,
				{ subject: req.attemptKey },
			);
		const known = lookup.status === "found" ? lookup.record : undefined;
		if (known?.ref !== undefined) return known.ref;
		if (known?.phase === "consumed")
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`codex attempt ${req.attemptKey} consumed its authority without launch evidence`,
				{ subject: req.attemptKey },
			);
		if (known?.phase === "revoked")
			throw new SdkError(
				"AUTHORITY_REVOKED",
				`codex attempt ${req.attemptKey} was revoked`,
				{
					subject: req.attemptKey,
				},
			);
		// WP18b: old terminal attempt records are pruned in the background (at most every 6 h).
		schedulePeriodicAdapterStatePrune({
			stateDir,
			classify: classifyCodexAttemptRecord,
			attemptDigestLength: 32,
		});
		// Last step before the effect (R#1).
		const decision = await req.authority.consume();
		if (decision.kind === "revoked")
			store.create({ attemptKey: req.attemptKey, phase: "revoked" });
		requireReleased(decision);
		if (!store.create({ attemptKey: req.attemptKey, phase: "consumed" }))
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`codex attempt ${req.attemptKey} already has a durable record`,
				{ subject: req.attemptKey },
			);
		if (config.testFaults?.crashAfterConsume === true)
			throw new Error("injected fault: crash after consume, before launch");
		const logDir = store.logDir(req.attemptKey);
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
		let rawPath: string | undefined;
		try {
			const dir = req.artifactsDir ?? logDir;
			mkdirSync(dir, { recursive: true });
			rawPath = join(dir, CODEX_RAW_TRANSCRIPT);
		} catch {
			rawPath = undefined;
		}
		// C1 (2026-11-08): isolated workers get a private CODEX_HOME (linked auth/config/rules, no
		// global AGENTS.md) under the attempt's log directory; see home.ts for when it stays shared.
		const env = { ...process.env, ...req.env };
		const workerHome = prepareCodexWorkerHome({
			userHome: codexHomeDir(env),
			dir: logDir,
			env,
			inherit: req.isolation.inherit,
			keepsSession:
				req.sessionId !== undefined || req.resumeSessionId !== undefined,
		});
		if (workerHome.relocated) env.CODEX_HOME = workerHome.path;
		// argv: no prompt, no env value. `log_dir` keeps CLI logs per attempt (and marks the launch).
		const child = spawn(
			codexPath,
			["-c", `log_dir=${JSON.stringify(logDir)}`, "app-server"],
			{
				cwd: req.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		child.once("close", () => removeCodexWorkerHome(workerHome));
		const digest = attemptDigest(req.attemptKey);
		const redact = createSecretRedactor(requestSecrets(req), {
			minLength: 8,
			replacement: (label) => `<redacted:${label}>`,
		});
		const ref: ExecRef = {
			executorId: CODEX_EXECUTOR_ID,
			attemptKey: req.attemptKey,
			handle: `codex-app-server:${child.pid ?? "none"}:${digest.slice(0, 12)}`,
		};
		const run: Run = {
			ref,
			attemptKey: req.attemptKey,
			req,
			log: [],
			done: false,
			waiters: [],
			child,
			conn: undefined,
			normalizer: new CodexTurnNormalizer(ARTIFACT_TOOL_KINDS),
			cancelRequested: false,
			pending: new Map(),
			answered: new Set(),
			rawPath,
			methodsById: new Map(),
			stderr: "",
			redact,
			stderrRedact: redact.stream(),
		};
		runs.set(req.attemptKey, run);
		store.write({
			attemptKey: req.attemptKey,
			phase: "spawned",
			ref,
			...(child.pid === undefined ? {} : { pid: child.pid }),
		});
		raw(run, "meta", {
			argv: ["-c", `log_dir=${JSON.stringify(logDir)}`, "app-server"],
			cwd: req.cwd,
			envKeys: Object.keys(req.env).sort(),
			pid: child.pid ?? null,
			codexHome: workerHome.relocated
				? { relocated: true, linked: [...workerHome.linked] }
				: { relocated: false, reason: workerHome.reason ?? null },
		});
		// Decode before the second redaction pass: JSON/Rust escaping can hide raw secret bytes.
		// Redact before bounding so the limit cannot expose a partial secret.
		const stderrParser = new CodexStderrParser(run.redact.text);
		const onStderr = (text: string) => {
			if (text === "") return;
			run.stderr = (run.stderr + text).slice(-16_384);
			raw(run, "stderr", text);
			for (const event of stderrParser.push(text)) emit(run, event);
		};
		// A value split across stderr chunks is held back until it can be redacted (review #5).
		child.stderr.on("data", (chunk: Buffer) =>
			onStderr(run.stderrRedact.push(chunk.toString())),
		);
		child.stderr.on("end", () => {
			onStderr(run.stderrRedact.flush());
			for (const event of stderrParser.finish()) emit(run, event);
		});
		run.conn = new AppServerConnection(child, {
			onLine: (direction, message) => {
				if (
					direction === "out" &&
					message.id !== undefined &&
					typeof message.method === "string"
				)
					run.methodsById.set(message.id, message.method);
				raw(
					run,
					direction,
					redactForTranscript(message, direction, (id) =>
						run.methodsById.get(id),
					),
				);
			},
			onNotification: (method, params) => onNotification(run, method, params),
			onServerRequest: (id, method, params) =>
				onServerRequest(run, id, method, params),
			onClose: (error) => onClose(run, error),
		});
		if (child.pid === undefined) {
			// spawn failed (ENOENT…): report it as a config failure, never as "not launched".
			ensureStarted(run);
			emit(
				run,
				failureEvent(
					`codex CLI not found or not executable: ${codexPath}`,
					"config",
					{ codexPath },
				),
			);
			return ref;
		}
		await handshake(run);
		return run.ref;
	};

	const findRun = (ref: ExecRef): Run | undefined => {
		const run = runs.get(ref.attemptKey);
		return run !== undefined && run.ref.handle === ref.handle ? run : undefined;
	};

	const executor = {
		id: CODEX_EXECUTOR_ID,
		version: CODEX_ADAPTER_VERSION,
		contractVersion: EXECUTOR_CONTRACT_VERSION,

		async probe(): Promise<ExecutorProbe> {
			const version = await runCli(codexPath, ["--version"]);
			const match = /(\d+\.\d+\.\d+)/.exec(version.stdout);
			if (version.code !== 0 || match === null)
				return {
					installed: false,
					cliVersion: null,
					auth: "unknown",
					mcpOutputLimitChars: CODEX_MCP_OUTPUT_LIMIT_CHARS,
					notes: [
						`codex --version failed: ${version.error ?? version.stderr.trim().slice(0, 200)}`,
					],
				};
			const notes: string[] = [];
			if (match[1] !== CODEX_VERIFIED_CLI_VERSION)
				notes.push(
					`codex-cli ${match[1]} differs from the verified ${CODEX_VERIFIED_CLI_VERSION}; rerun the conformance kit (F3)`,
				);
			const login = await runCli(codexPath, ["login", "status"]);
			const auth = parseLoginStatus(login);
			const catalog = await codexModelCatalog().catch(() => []);
			const models = catalog.map((entry) => entry.slug);
			notes.push(
				models.length > 0
					? `models: ${models.join(", ")}`
					: "models: not listable",
			);
			// WP4d: allow rules weaken readOnly; a global AGENTS.md weakens isolation (warnings).
			const environment = inspectCodexEnvironment(process.env);
			notes.push(...codexEnvironmentNotes(environment));
			return {
				installed: true,
				cliVersion: match[1],
				auth,
				capabilities: codexEnvironmentCapabilities(environment),
				mcpOutputLimitChars: CODEX_MCP_OUTPUT_LIMIT_CHARS,
				// WP31 follow-up: `codex debug models` lists the visible catalog slugs only (hidden ones
				// are dropped above) and the CLI passes any `model` on (API-key and custom-provider
				// logins accept models outside the catalog), so the list is not exhaustive.
				modelListComplete: false,
				...(catalog.some((entry) => entry.efforts.length > 0)
					? {
							modelEfforts: Object.fromEntries(
								catalog
									.filter((entry) => entry.efforts.length > 0)
									.map((entry) => [entry.slug, entry.efforts]),
							),
						}
					: {}),
				notes,
			};
		},

		capabilities: () => capabilities,
		toolMapping: CODEX_TOOL_MAPPING,

		/** Visible model slugs from `codex debug models` (no model turn). */
		async listModels(): Promise<string[]> {
			return (await codexModelCatalog()).map((entry) => entry.slug);
		},

		async submit(req: SubmitRequest): Promise<ExecRef> {
			const problems = validateSubmitRequest(req);
			const plan = Array.isArray(req.tools)
				? planCodexTools(req.tools, req.readOnly === true, req.permissionMode)
				: undefined;
			if (plan !== undefined && plan.unmapped.length > 0)
				problems.push(
					`tools without a codex mapping: ${plan.unmapped.join(", ")} (B4 decides before submit)`,
				);
			for (const server of req.mcpServers ?? [])
				if (!/^[A-Za-z0-9_-]+$/.test(server.name))
					problems.push(
						`mcp server name ${server.name} must match [A-Za-z0-9_-]+`,
					);
			if (problems.length > 0)
				throw new SdkError("INVALID_REQUEST", problems.join("; "));
			// Review #6: MCP servers run outside the Codex sandbox. Only the engine's artifact server
			// (one read-only tool) is trusted on a readOnly request; any other server may mutate.
			const foreignServers = (req.mcpServers ?? [])
				.map((server) => server.name)
				.filter((name) => name !== ARTIFACT_MCP_SERVER_NAME);
			if (enforcesReadOnly(req) && foreignServers.length > 0)
				throw new SdkError(
					"CAPABILITY_MISSING",
					`readOnly request injects MCP servers whose tools may mutate (${foreignServers.join(", ")}); the codex executor cannot enforce readOnly on them`,
					{ subject: "readOnly" },
				);
			const pending = inflight.get(req.attemptKey);
			if (pending !== undefined) return pending;
			const launching = launch(req);
			inflight.set(req.attemptKey, launching);
			try {
				return await launching;
			} finally {
				inflight.delete(req.attemptKey);
			}
		},

		async *observe(ref: ExecRef): AsyncIterable<ExecEvent> {
			const run = findRun(ref);
			if (run !== undefined) {
				let index = 0;
				for (;;) {
					while (index < run.log.length) yield run.log[index++] as ExecEvent;
					if (run.done) return;
					await new Promise<void>((resolve) => run.waiters.push(resolve));
				}
			}
			const record = store.read(ref.attemptKey);
			if (record?.ref === undefined || record.ref.handle !== ref.handle)
				throw new SdkError(
					"UNKNOWN_EXEC_REF",
					`unknown codex exec ref ${ref.attemptKey}/${ref.handle}`,
				);
			// Attempt owned by another (or an earlier) process: replay its durable event log.
			let index = 0;
			for (;;) {
				const events = store.events(ref.attemptKey);
				while (index < events.length) {
					const event = events[index++] as ExecEvent;
					yield event;
					if (event.type === "completed" || event.type === "failed") return;
				}
				const current = store.read(ref.attemptKey);
				if (current?.phase === "terminal") continue;
				if (!processAlive(current?.pid)) {
					// The app-server that ran the turn is gone and never wrote a terminal event.
					if (index === 0)
						yield { type: "started", sessionId: current?.threadId ?? null };
					yield failureEvent(
						"codex app-server of this attempt exited without a terminal event (owner process gone)",
						"unknown",
						{ pid: current?.pid ?? null },
					);
					return;
				}
				await sleep(100);
			}
		},

		async cancel(ref: ExecRef, scope: CancelScope): Promise<CancelResult> {
			const run = findRun(ref);
			if (run === undefined) {
				const lookup = store.lookup(ref.attemptKey);
				// Unreadable evidence cannot prove nothing runs (review #3).
				if (lookup.status === "unreadable") return "uncertain";
				const record = lookup.status === "found" ? lookup.record : undefined;
				if (record === undefined || record.ref === undefined)
					return "no_active";
				if (record.phase === "terminal") return "too_late";
				if (!processAlive(record.pid)) return "no_active";
				return "uncertain";
			}
			if (run.done) return "too_late";
			run.cancelRequested = true;
			const grace = config.cancelGraceMs ?? 2_500;
			const waitTerminal = (ms: number) =>
				withTimeout(
					new Promise<void>((resolve) => {
						if (run.done) resolve();
						else run.waiters.push(() => run.done && resolve());
						const tick = setInterval(() => {
							if (run.done) {
								clearInterval(tick);
								resolve();
							}
						}, 25);
						tick.unref();
					}),
					ms,
				);
			if (
				run.turnId !== undefined &&
				run.threadId !== undefined &&
				run.conn !== undefined &&
				!run.conn.isClosed
			)
				await withTimeout(
					run.conn.request("turn/interrupt", {
						threadId: run.threadId,
						turnId: run.turnId,
					}),
					grace,
				);
			await waitTerminal(
				scope === "owned" || run.turnId === undefined
					? Math.min(grace, 1_000)
					: grace,
			);
			if (
				!run.done &&
				(scope === "owned" || run.turnId === undefined) &&
				run.child !== undefined
			) {
				killGroup(run.child, "SIGTERM");
				await waitTerminal(1_500);
				if (!run.done) {
					killGroup(run.child, "SIGKILL");
					await waitTerminal(1_000);
				}
			}
			if (!run.done) return "uncertain";
			const terminal = run.log.at(-1);
			return terminal?.type === "failed" && terminal.class === "cancelled"
				? "cancelled"
				: "too_late";
		},

		async reconcile(attemptKey: string): Promise<ReconcileResult> {
			const run = runs.get(attemptKey);
			if (run !== undefined) return { found: run.ref };
			const lookup = store.lookup(attemptKey);
			// Only a missing record proves absence; unreadable evidence is ambiguous (review #3).
			if (lookup.status === "missing") return { absent: true };
			if (lookup.status === "unreadable")
				return { unknown: true, reason: lookup.reason };
			const record = lookup.record;
			if (record.phase === "revoked") return { absent: true };
			if (record.ref !== undefined) return { found: record.ref };
			return {
				unknown: true,
				reason: "authority consumed without launch evidence",
			};
		},

		async respond(
			ref: ExecRef,
			requestId: string,
			decision: ApprovalDecision,
		): Promise<ApprovalResponseResult> {
			const run = findRun(ref);
			if (run === undefined) {
				const record = store.read(ref.attemptKey);
				if (record?.ref === undefined || record.ref.handle !== ref.handle)
					throw new SdkError(
						"UNKNOWN_EXEC_REF",
						`unknown codex exec ref ${ref.attemptKey}/${ref.handle}`,
					);
				const asked = store
					.events(ref.attemptKey)
					.some(
						(event) =>
							event.type === "approval_request" &&
							event.requestId === requestId,
					);
				return asked ? "too_late" : "unknown_request";
			}
			return answer(run, requestId, decision);
		},

		/** D3/R#10: delete a thread this adapter kept (`thread/delete`, no model turn). */
		async deleteOwnedSession(
			session: OwnedSession,
		): Promise<DeleteOwnedSessionResult> {
			// Not a thread this adapter created and recorded: never touch it (review #9).
			if (session.kind !== CODEX_OWNED_SESSION_KIND) return "refused";
			if (!threads.owns(session.locator)) return "refused";
			const child = spawn(codexPath, ["app-server"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let closed: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				closed = resolve;
			});
			const conn = new AppServerConnection(child, {
				onNotification: () => {},
				onServerRequest: (id) => conn.respondError(id, -32601, "not handled"),
				onClose: () => closed(),
			});
			try {
				await conn.request("initialize", {
					clientInfo: {
						name: "agent_workflow",
						title: "agent-workflow",
						version: CODEX_ADAPTER_VERSION,
					},
					capabilities: { experimentalApi: false, requestAttestation: false },
				});
				conn.notify("initialized");
				await conn.request("thread/delete", { threadId: session.locator });
				threads.forget(session.locator);
				return "deleted";
			} catch (error) {
				if (!/not found|no rollout|unknown thread/i.test(String(error)))
					return "failed";
				threads.forget(session.locator);
				return "not_found";
			} finally {
				conn.end();
				await withTimeout(done, 3_000);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
		},
	};
	return executor;
}
