/**
 * ACP executor adapter (pilot, design note acp-pilot-20261102): `WorkflowExecutor` over an agent
 * started in ACP mode (NDJSON JSON-RPC on its stdio, protocol v1).
 *
 * - submit: idempotent per `attemptKey` (in flight, in memory, durable record); the authority is
 *   consumed immediately before the spawn (R#1) and launch evidence is durable (B3). Then
 *   `initialize` (no client fs/terminal: agents keep their native tools, D2) → `session/new` with
 *   the engine's MCP servers (D3) → one `session/prompt`; the agent process ends with the prompt.
 * - observe: normalized events (normalize.ts); the agent's raw output is kept in
 *   `artifactsDir/acp-stream.jsonl` with request env values redacted.
 * - respond: answers `session/request_permission` (D4) with an option the agent offered; an
 *   unanswered request is denied after `approvalPolicy.timeoutMs` (fail closed, D2).
 * - cancel: `session/cancel` (D7); `owned` also ends the agent's stdin and escalates SIGTERM → SIGKILL.
 * - reconcile: in-memory run, else the durable record (`found` when the raw log holds the prompt
 *   result, else `unknown`: the session belonged to the process that is gone).
 */
import { enforcesReadOnly } from "../../sdk/permission.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision } from "../../sdk/approval.js";
import { requireReleased } from "../../sdk/authority.js";
import type { ExecutorCapabilities } from "../../sdk/capabilities.js";
import {
	type ApprovalResponseResult,
	type CancelResult,
	type CancelScope,
	EXECUTOR_CONTRACT_VERSION,
	type ExecRef,
	type ExecutorProbe,
	type ReconcileResult,
	type SubmitRequest,
	validateSubmitRequest,
	type WorkflowExecutor,
} from "../../sdk/contract.js";
import { ARTIFACT_MCP_SERVER_NAME } from "../../core/artifact-access.js";
import { acquireDirectoryLock } from "../../runtime/artifacts/dir-lock.js";
import { SdkError } from "../../sdk/errors.js";
import type { ExecEvent } from "../../sdk/events.js";
import { createSecretRedactor, requestSecrets } from "../redact.js";
import { schedulePeriodicAdapterStatePrune } from "../state-retention.js";
import { acpCapabilities } from "./capabilities.js";
import type { AcpExecutorConfig } from "./config.js";
import {
	ACP_TOOL_RESULTS_RECORD,
	AcpEventNormalizer,
	acpToolKind,
	classifyAcpFailure,
	replayAcpLog,
} from "./normalize.js";
import { AcpPeer, AcpRpcError, METHOD_NOT_FOUND } from "./rpc.js";
import {
	AcpStateStore,
	type AttemptLookup,
	type AttemptRecord,
	classifyAcpAttemptRecord,
} from "./state.js";
import { ACP_ADAPTER_VERSION } from "./version.js";

export const ACP_RAW_STREAM_FILE = "acp-stream.jsonl";
export const ACP_RAW_STDERR_FILE = "acp-stderr.log";
export const ACP_INVOCATION_FILE = "acp-invocation.json";
/** ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpExecutorFaults {
	/** Conformance fault: consume the authority, then fail before any launch evidence. */
	readonly crashAfterConsume?: boolean;
}

interface PermissionOption {
	readonly optionId: string;
	readonly kind: string;
}

interface PendingPermission {
	readonly toolCallId: string | undefined;
	readonly options: readonly PermissionOption[];
	readonly resolve: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface Run {
	readonly ref: ExecRef;
	readonly log: ExecEvent[];
	done: boolean;
	exited: boolean;
	readonly waiters: (() => void)[];
	readonly child: ReturnType<typeof spawn>;
	readonly normalizer: AcpEventNormalizer;
	/** Appends one record to the attempt's raw log (redacted). */
	readonly writeRaw: (line: string) => void;
	/** The engine-owned agent home this attempt runs in; undefined when it inherits the user's. */
	readonly agentHome: string | undefined;
	/** A per-attempt home (preset `prepareAttemptHome`), removed when the agent exits. */
	readonly attemptHome: string | undefined;
	/** Releases the serialized-start lock (preset `serializeSessionStart`); idempotent. */
	readonly releaseStart: () => void;
	/** Set when the agent asked for an interactive login (preset `loginRequiredPattern`). */
	loginRequired: string | undefined;
	peer: AcpPeer | undefined;
	sessionId: string | undefined;
	cancelRequested: boolean;
	stdinOpen: boolean;
	readonly pending: Map<string, PendingPermission>;
	readonly answered: Set<string>;
	readonly timers: ReturnType<typeof setTimeout>[];
	nextPermission: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} timed out after ${ms} ms`)),
			ms,
		);
		timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** ACP has no system prompt field; it goes ahead of the task (capability: emulated, append). */
export function acpPromptText(
	req: Pick<SubmitRequest, "prompt" | "systemPrompt">,
): string {
	return req.systemPrompt === undefined || req.systemPrompt.trim() === ""
		? req.prompt
		: `${req.systemPrompt.trim()}\n\n---\n\n${req.prompt}`;
}

/** `McpServerSpec` → ACP stdio server (`env` as name/value pairs; values only on the wire). */
export function acpMcpServers(
	req: Pick<SubmitRequest, "mcpServers">,
): unknown[] {
	return req.mcpServers.map((server) => ({
		name: server.name,
		command: server.command,
		args: [...server.args],
		env: Object.entries(server.env ?? {}).map(([name, value]) => ({
			name,
			value,
		})),
	}));
}

/** The option an engine decision selects; never an `*_always` option (nothing is persisted). */
export function selectPermissionOption(
	options: readonly PermissionOption[],
	decision: ApprovalDecision,
): string | undefined {
	const wanted = decision === "allow" ? "allow_once" : "reject_once";
	return options.find((option) => option.kind === wanted)?.optionId;
}

function runCommand(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; error?: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{ timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error === null) return resolve({ code: 0, stdout });
				const code = typeof error.code === "number" ? error.code : null;
				resolve({ code, stdout: stdout ?? "", error: error.message });
			},
		);
	});
}

/** `agentInfo.version` from a bare ACP `initialize` (the agent process is ended right after). */
async function initializeVersion(
	command: string,
	launchArgs: (req: SubmitRequest) => string[],
	timeoutMs: number,
): Promise<{ version: string | null; error: string }> {
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command, launchArgs({} as SubmitRequest), {
			stdio: ["pipe", "pipe", "ignore"],
		});
	} catch (error) {
		return {
			version: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const spawnFailed = new Promise<never>((_, reject) =>
		child.once("error", (error) => reject(error)),
	);
	try {
		if (child.stdout === null || child.stdin === null)
			throw new Error("no stdio");
		const peer = new AcpPeer({ input: child.stdout, output: child.stdin });
		const result = await Promise.race([
			withTimeout(
				peer.request("initialize", {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
				}),
				timeoutMs,
				"ACP initialize",
			),
			spawnFailed,
		]);
		const info =
			isRecord(result) && isRecord(result.agentInfo)
				? result.agentInfo
				: undefined;
		const version = typeof info?.version === "string" ? info.version : null;
		return {
			version,
			error: version === null ? "initialize returned no agentInfo.version" : "",
		};
	} catch (error) {
		return {
			version: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		child.stdin?.end();
		child.kill("SIGTERM");
	}
}

/**
 * One-time login of an agent in the engine-owned home (`authenticate`; e.g. `oauth-personal` opens
 * the agent's own browser login, which the user completes). Stderr lines (the login link) go to
 * `onLine`; nothing is stored by the engine.
 */
export async function authenticateAcpAgent(
	config: AcpExecutorConfig,
	methodId: string,
	onLine: (line: string) => void = () => {},
	timeoutMs = 600_000,
): Promise<unknown> {
	const env =
		config.preset.isolatedEnv === undefined
			? {}
			: config.preset.isolatedEnv(config.agentHome);
	if (Object.keys(env).length > 0)
		await mkdir(config.agentHome, { recursive: true, mode: 0o700 });
	const child = spawn(
		config.command,
		config.preset.launchArgs({} as SubmitRequest),
		{
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	child.stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split("\n"))
			if (line.trim() !== "") onLine(line);
	});
	try {
		if (child.stdout === null || child.stdin === null)
			throw new Error("no stdio");
		const peer = new AcpPeer({ input: child.stdout, output: child.stdin });
		await withTimeout(
			peer.request("initialize", {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
			}),
			60_000,
			"ACP initialize",
		);
		return await withTimeout(
			peer.request("authenticate", { methodId }),
			timeoutMs,
			"ACP authenticate",
		);
	} finally {
		child.stdin?.end();
		child.kill("SIGTERM");
	}
}

export function createAcpExecutor(options: {
	readonly config: AcpExecutorConfig;
	readonly faults?: AcpExecutorFaults;
}): WorkflowExecutor {
	const { config } = options;
	const preset = config.preset;
	const store = new AcpStateStore(config.stateDir);
	const runs = new Map<string, Run>();
	const inflight = new Map<string, Promise<ExecRef>>();
	const capabilities = acpCapabilities(preset.id);

	const push = (run: Run, event: ExecEvent) => {
		if (run.done) return;
		run.log.push(event);
		if (event.type === "completed" || event.type === "failed") {
			run.done = true;
			for (const pending of run.pending.values()) clearTimeout(pending.timer);
		}
		for (const wake of run.waiters.splice(0)) wake();
	};

	const later = (run: Run, ms: number, action: () => void) => {
		const timer = setTimeout(action, ms);
		timer.unref();
		run.timers.push(timer);
	};

	const endStdin = (run: Run) => {
		if (!run.stdinOpen) return;
		run.stdinOpen = false;
		run.child.stdin?.end();
	};

	/** End the agent: close stdin, then SIGTERM and SIGKILL if it does not exit. */
	const reap = (run: Run) => {
		endStdin(run);
		later(run, config.killGraceMs, () => {
			if (run.exited) return;
			run.child.kill("SIGTERM");
			later(run, config.killGraceMs, () => {
				if (!run.exited) run.child.kill("SIGKILL");
			});
		});
	};

	const answer = (
		run: Run,
		requestId: string,
		decision: ApprovalDecision,
	): ApprovalResponseResult => {
		const pending = run.pending.get(requestId);
		if (pending === undefined)
			return run.answered.has(requestId) ? "too_late" : "unknown_request";
		run.pending.delete(requestId);
		run.answered.add(requestId);
		clearTimeout(pending.timer);
		if (decision === "deny") run.normalizer.markDenied(pending.toolCallId);
		const optionId = selectPermissionOption(pending.options, decision);
		pending.resolve(
			optionId === undefined
				? { outcome: { outcome: "cancelled" } }
				: { outcome: { outcome: "selected", optionId } },
		);
		return run.done ? "too_late" : "accepted";
	};

	const fromRecord = (attemptKey: string, record: AttemptRecord): ExecRef => {
		if (record.phase === "spawned" && record.ref !== undefined)
			return record.ref;
		if (record.phase === "revoked")
			throw new SdkError(
				"AUTHORITY_REVOKED",
				`attempt ${attemptKey} was revoked`,
				{
					subject: attemptKey,
				},
			);
		throw new SdkError(
			"AUTHORITY_ALREADY_CONSUMED",
			`attempt ${attemptKey} consumed its authority without launch evidence; reconcile reports unknown`,
			{ subject: attemptKey },
		);
	};

	const fromLookup = (
		attemptKey: string,
		lookup: AttemptLookup,
	): ExecRef | undefined => {
		if (lookup.status === "missing") return undefined;
		if (lookup.status === "found") return fromRecord(attemptKey, lookup.record);
		throw new SdkError(
			"AUTHORITY_ALREADY_CONSUMED",
			`attempt ${attemptKey} has launch evidence that cannot be trusted (${lookup.reason}); reconcile reports unknown`,
			{ subject: attemptKey },
		);
	};

	async function agentRequest(
		run: Run,
		req: SubmitRequest,
		method: string,
		params: unknown,
	) {
		if (method !== "session/request_permission")
			// D2: no client fs/terminal capability was offered; anything else is not served.
			throw new AcpRpcError({
				code: METHOD_NOT_FOUND,
				message: `agent-workflow does not serve ${method}`,
			});
		const toolCall =
			isRecord(params) && isRecord(params.toolCall) ? params.toolCall : {};
		const offered: PermissionOption[] = (
			isRecord(params) && Array.isArray(params.options) ? params.options : []
		)
			.filter(isRecord)
			.filter((option) => typeof option.optionId === "string")
			.map((option) => ({
				optionId: option.optionId as string,
				kind: typeof option.kind === "string" ? option.kind : "",
			}));
		const requestId = `permission-${run.nextPermission++}`;
		return new Promise<unknown>((resolve) => {
			const timer = setTimeout(
				() => answer(run, requestId, "deny"),
				Math.max(0, req.approvalPolicy.timeoutMs),
			);
			timer.unref();
			run.pending.set(requestId, {
				toolCallId:
					typeof toolCall.toolCallId === "string"
						? toolCall.toolCallId
						: undefined,
				options: offered,
				resolve,
				timer,
			});
			const kind = acpToolKind(
				preset.permissionKind !== undefined &&
					typeof toolCall.title === "string"
					? preset.permissionKind(toolCall.title, String(toolCall.kind ?? ""))
					: toolCall.kind,
			);
			const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
			// The exact command line of a shell execution (Antigravity `CommandLine`, others
			// `command`): a readOnly stage allows a plain read-only inspection command.
			const command =
				kind === "execute"
					? [rawInput.CommandLine, rawInput.command].find(
							(value): value is string => typeof value === "string",
						)
					: undefined;
			const title =
				typeof toolCall.title === "string" ? toolCall.title : undefined;
			// The engine's artifact server only reads (the same rule that admits it on readOnly
			// requests); agents that report MCP calls as `other` (Antigravity: "<server>_<tool>")
			// are judged as the read it is.
			const artifactCall =
				kind === "other" &&
				title?.startsWith(`${ARTIFACT_MCP_SERVER_NAME}_`) === true &&
				req.mcpServers.some(
					(server) => server.name === ARTIFACT_MCP_SERVER_NAME,
				);
			push(run, {
				type: "approval_request",
				requestId,
				kind: artifactCall ? "read" : kind,
				detail: title ?? "permission requested",
				...(command === undefined ? {} : { command }),
			});
		});
	}

	async function converse(
		run: Run,
		req: SubmitRequest,
		peer: AcpPeer,
	): Promise<void> {
		try {
			await withTimeout(
				peer.request("initialize", {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
					clientInfo: { name: "agent-workflow", version: ACP_ADAPTER_VERSION },
				}),
				config.handshakeTimeoutMs,
				"ACP initialize",
			);
			const session = await withTimeout(
				peer.request("session/new", {
					cwd: req.cwd,
					mcpServers: acpMcpServers(req),
					...(preset.sessionMeta === undefined
						? {}
						: { _meta: preset.sessionMeta(req) }),
				}),
				config.handshakeTimeoutMs,
				"ACP session/new",
			);
			const sessionId =
				isRecord(session) && typeof session.sessionId === "string"
					? session.sessionId
					: undefined;
			if (sessionId === undefined)
				throw new Error("ACP session/new returned no sessionId");
			run.sessionId = sessionId;
			run.releaseStart();
			for (const step of preset.afterSession?.(
				req,
				session as Record<string, unknown>,
			) ?? [])
				await withTimeout(
					peer.request(step.method, step.params),
					config.handshakeTimeoutMs,
					`ACP ${step.method}`,
				);
			if (run.cancelRequested) {
				for (const event of run.normalizer.prompt({ stopReason: "cancelled" }))
					push(run, event);
				return;
			}
			const result = await peer.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: acpPromptText(req) }],
			});
			const stopReason =
				isRecord(result) && typeof result.stopReason === "string"
					? result.stopReason
					: null;
			await releaseHeldTools(run, sessionId);
			for (const event of run.normalizer.prompt({
				stopReason,
				usage: isRecord(result) ? result.usage : undefined,
				...(stopReason === null
					? { error: "ACP session/prompt returned no stopReason" }
					: {}),
			}))
				push(run, event);
		} catch (error) {
			run.normalizer.prompt({
				stopReason: null,
				error:
					run.loginRequired ??
					(error instanceof Error ? error.message : String(error)),
			});
		} finally {
			run.releaseStart();
			reap(run);
		}
	}

	/**
	 * Calls held back because ACP carried only a summary get the results the agent recorded in its
	 * home (preset `toolResults`); what was released goes to the raw log for replays.
	 */
	async function releaseHeldTools(run: Run, sessionId: string): Promise<void> {
		const held = run.normalizer.heldCalls();
		if (held.length === 0) return;
		const outputs = new Map<string, string>();
		if (preset.toolResults !== undefined && run.agentHome !== undefined) {
			const results = await preset.toolResults
				.read(run.agentHome, sessionId)
				.catch(() => []);
			// Same key (server, tool, arguments): the n-th held call takes the n-th result.
			const used = new Set<number>();
			for (const call of held) {
				const index = results.findIndex(
					(result, i) => !used.has(i) && result.key === call.key,
				);
				const result = results[index];
				if (result === undefined) continue;
				used.add(index);
				outputs.set(call.callId, result.text);
			}
		}
		run.writeRaw(
			JSON.stringify({
				agentWorkflow: ACP_TOOL_RESULTS_RECORD,
				held: held.map((call) => call.callId),
				outputs: Object.fromEntries(outputs),
			}),
		);
		for (const event of run.normalizer.release(outputs)) push(run, event);
	}

	async function launch(req: SubmitRequest): Promise<ExecRef> {
		const known = runs.get(req.attemptKey);
		if (known !== undefined) return known.ref;
		schedulePeriodicAdapterStatePrune({
			stateDir: config.stateDir,
			classify: classifyAcpAttemptRecord,
			attemptDigestLength: 40,
		});
		const existingRef = fromLookup(
			req.attemptKey,
			await store.lookupAttempt(req.attemptKey),
		);
		if (existingRef !== undefined) return existingRef;
		const filesDir = req.artifactsDir ?? store.attemptFilesDir(req.attemptKey);
		// Everything that can refuse the request runs before consume (no effect on refusal).
		// As in the Claude adapter (review #6): only the engine's artifact server is known to be
		// read-only; another injected server may mutate, so a readOnly request with one is refused.
		const foreign = req.mcpServers
			.map((server) => server.name)
			.filter((name) => name !== ARTIFACT_MCP_SERVER_NAME);
		if (enforcesReadOnly(req) && foreign.length > 0)
			throw new SdkError(
				"CAPABILITY_MISSING",
				`readOnly request injects MCP servers whose tools may mutate (${foreign.join(", ")}); the ${preset.id} executor cannot enforce readOnly on them`,
				{ subject: "readOnly" },
			);
		const argv = preset.launchArgs(req);
		const secrets = createSecretRedactor(requestSecrets(req), {
			minLength: 8,
			replacement: (label) => `<redacted:${label}>`,
		});
		const redact = secrets.text;

		const decision = await req.authority.consume(); // immediately before the first effect (R#1)
		if (decision.kind === "revoked")
			await store.claimAttempt({
				attemptKey: req.attemptKey,
				phase: "revoked",
				sessionId: null,
			});
		requireReleased(decision);
		const claimed = await store.claimAttempt({
			attemptKey: req.attemptKey,
			phase: "consumed",
			sessionId: null,
			cwd: req.cwd,
		});
		if (!claimed) {
			const existing = fromLookup(
				req.attemptKey,
				await store.lookupAttempt(req.attemptKey),
			);
			if (existing !== undefined) return existing;
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`attempt ${req.attemptKey} is claimed by another executor instance`,
				{ subject: req.attemptKey },
			);
		}
		if (options.faults?.crashAfterConsume === true)
			throw new Error("injected fault: crash after consume, before launch");

		await mkdir(filesDir, { recursive: true });
		const rawPath = join(filesDir, ACP_RAW_STREAM_FILE);
		const stderrPath = join(filesDir, ACP_RAW_STDERR_FILE);
		const invocation = {
			schema: "agent-workflow-acp-invocation-v1",
			preset: preset.id,
			command: config.command,
			argv: argv.map(redact),
			envKeys: Object.keys(req.env).sort(),
			cwd: req.cwd,
			mcpServers: req.mcpServers.map((server) => ({
				name: server.name,
				envKeys: Object.keys(server.env ?? {}).sort(),
			})),
			readOnly: req.readOnly,
			permissionMode: req.permissionMode ?? null,
			agentHome:
				req.isolation.inherit || preset.isolatedEnv === undefined
					? null
					: config.agentHome,
			attemptHome:
				req.isolation.inherit ||
				preset.isolatedEnv === undefined ||
				preset.prepareAttemptHome === undefined
					? null
					: "per-attempt temporary home",
		};
		const rawStream: WriteStream = createWriteStream(rawPath, { mode: 0o600 });
		const stderrStream: WriteStream = createWriteStream(stderrPath, {
			mode: 0o600,
		});
		rawStream.on("error", () => {});
		stderrStream.on("error", () => {});

		const isolating =
			!req.isolation.inherit && preset.isolatedEnv !== undefined;
		if (isolating)
			await mkdir(config.agentHome, { recursive: true, mode: 0o700 });
		// 2026-11-03: a fresh home per attempt (private temp dir) when the preset asks for one.
		let attemptHome: string | undefined;
		if (isolating && preset.prepareAttemptHome !== undefined) {
			attemptHome = await mkdtemp(join(tmpdir(), `aw-${preset.id}-home-`));
			try {
				await preset.prepareAttemptHome(config.agentHome, attemptHome);
			} catch (error) {
				await rm(attemptHome, { recursive: true, force: true });
				throw error;
			}
		}
		const runHome = attemptHome ?? config.agentHome;
		const isolatedEnv = isolating ? preset.isolatedEnv!(runHome) : {};
		const isolated = Object.keys(isolatedEnv).length > 0;
		// An isolated worker uses the login recorded for its home: inherited variables that would
		// switch the account, project or harness are dropped (names in acp-invocation.json).
		const inherited: NodeJS.ProcessEnv = { ...process.env };
		const envRemoved: string[] = [];
		if (isolated && preset.inheritedEnvBlocked !== undefined)
			for (const key of Object.keys(inherited))
				if (preset.inheritedEnvBlocked(key) && !(key in req.env)) {
					delete inherited[key];
					envRemoved.push(key);
				}
		await writeFile(
			join(filesDir, ACP_INVOCATION_FILE),
			JSON.stringify({ ...invocation, envRemoved: envRemoved.sort() }, null, 2),
			{ mode: 0o600 },
		);
		const launchEnv = (await preset.launchEnv?.(config.command)) ?? {};
		// Serialized starts: wait (up to ~2 min) until no other attempt of this login home is between
		// spawn and session/new; on timeout start anyway.
		let releaseStartLock: (() => Promise<void>) | undefined;
		if (isolating && preset.serializeSessionStart === true)
			releaseStartLock = await acquireDirectoryLock(
				join(config.agentHome, ".session-start.lock"),
				{ retries: 600, retryMs: 200 },
			).catch(() => undefined);
		let startReleased = false;
		const releaseStart = () => {
			if (startReleased) return;
			startReleased = true;
			void releaseStartLock?.().catch(() => {});
		};
		const child = spawn(config.command, argv, {
			cwd: req.cwd,
			env: {
				...inherited,
				...launchEnv,
				...isolatedEnv,
				...(isolating ? (preset.workerEnv ?? {}) : {}),
				...req.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const ref: ExecRef = {
			executorId: preset.id,
			attemptKey: req.attemptKey,
			handle: `acp-attempt:${createHash("sha256").update(req.attemptKey).digest("hex").slice(0, 24)}`,
		};
		const run: Run = {
			ref,
			log: [],
			done: false,
			exited: false,
			waiters: [],
			child,
			normalizer: new AcpEventNormalizer({
				...(preset.toolName === undefined ? {} : { toolName: preset.toolName }),
				...(preset.answerFailure === undefined
					? {}
					: {
							answerFailure: (text: string) =>
								preset.answerFailure?.(text, classifyAcpFailure),
						}),
				...(preset.toolResults === undefined || !isolated
					? {}
					: {
							holdOutput: (_callId, call) =>
								preset.toolResults?.summaryKey(
									call,
									req.mcpServers.map((server) => server.name),
								),
						}),
			}),
			writeRaw: (line) => rawStream.write(`${redact(line)}\n`),
			agentHome: isolated ? runHome : undefined,
			attemptHome,
			releaseStart,
			loginRequired: undefined,
			peer: undefined,
			sessionId: undefined,
			cancelRequested: false,
			stdinOpen: true,
			pending: new Map(),
			answered: new Set(),
			timers: [],
			nextPermission: 1,
		};
		runs.set(req.attemptKey, run);
		// Every child handler is attached synchronously after spawn, before any await.
		child.stdin?.on("error", () => {
			run.stdinOpen = false;
		});
		let stderr = "";
		let spawnError: string | undefined;
		child.on("error", (error) => {
			spawnError = error.message;
		});
		const stderrRedact = secrets.stream();
		const onStderr = (text: string) => {
			if (text === "") return;
			stderrStream.write(text);
			stderr = (stderr + text).slice(-65_536);
			if (
				isolating &&
				run.loginRequired === undefined &&
				preset.loginRequiredPattern?.test(text) === true
			) {
				run.loginRequired = `${preset.label} asked for an interactive Google login; the worker home's login is missing or unreadable (sign it in again, docs/executors.md#antigravity-acp)`;
				reap(run);
			}
		};
		child.stderr?.on("data", (chunk: Buffer) =>
			onStderr(stderrRedact.push(chunk.toString("utf8"))),
		);
		child.stderr?.on("end", () => onStderr(stderrRedact.flush()));
		push(run, { type: "started", sessionId: null });
		if (child.stdout !== null && child.stdin !== null)
			run.peer = new AcpPeer({
				input: child.stdout,
				output: child.stdin,
				onLine: (line) => {
					rawStream.write(`${redact(line)}\n`);
				},
				onRequest: (method, params) => agentRequest(run, req, method, params),
				onNotification: (method, params) => {
					if (method !== "session/update") return;
					for (const event of run.normalizer.update(params)) push(run, event);
				},
			});
		child.on("close", (code, signal) => {
			run.exited = true;
			run.releaseStart();
			run.stdinOpen = false;
			for (const timer of run.timers) clearTimeout(timer);
			run.peer?.close(new Error("agent exited"));
			const finish = async () => {
				// The raw log is on disk before the terminal event (reconcile in another process).
				await new Promise<void>((resolve) => {
					if (rawStream.closed || rawStream.destroyed) return resolve();
					rawStream.once("close", () => resolve());
					rawStream.end();
				});
				onStderr(stderrRedact.flush());
				stderrStream.end();
				if (run.attemptHome !== undefined)
					await rm(run.attemptHome, { recursive: true, force: true }).catch(
						() => {},
					);
				for (const [requestId] of run.pending) answer(run, requestId, "deny");
				// Calls still held (the prompt failed or was cancelled) close without an output.
				for (const event of run.normalizer.release(new Map())) push(run, event);
				push(
					run,
					run.normalizer.finish({
						exitCode: code,
						signal,
						cancelled: run.cancelRequested,
						stderr,
						...(spawnError === undefined
							? {}
							: { spawnError: redact(spawnError) }),
					}),
				);
			};
			setImmediate(() => void finish());
		});
		await store.writeAttempt({
			attemptKey: req.attemptKey,
			phase: "spawned",
			sessionId: null,
			ref,
			pid: child.pid ?? null,
			cwd: req.cwd,
			rawPath,
			stderrPath,
		});
		if (run.peer !== undefined && child.pid !== undefined)
			void converse(run, req, run.peer);
		else reap(run);
		return ref;
	}

	const findRun = (ref: ExecRef): Run => {
		const run = runs.get(ref.attemptKey);
		if (run === undefined || run.ref.handle !== ref.handle)
			throw new SdkError(
				"UNKNOWN_EXEC_REF",
				`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
			);
		return run;
	};

	async function readRaw(
		rawPath: string | undefined,
	): Promise<string[] | undefined> {
		if (rawPath === undefined) return undefined;
		try {
			return (await readFile(rawPath, "utf8")).split("\n");
		} catch {
			return undefined;
		}
	}

	async function* replay(ref: ExecRef): AsyncGenerator<ExecEvent> {
		const record = await store.readAttempt(ref.attemptKey);
		if (record?.phase !== "spawned" || record.ref?.handle !== ref.handle)
			throw new SdkError(
				"UNKNOWN_EXEC_REF",
				`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
			);
		const { events, settled } = replayAcpLog(
			(await readRaw(record.rawPath)) ?? [],
			{
				...(preset.answerFailure === undefined
					? {}
					: {
							answerFailure: (text: string) =>
								preset.answerFailure?.(text, classifyAcpFailure),
						}),
				...(preset.toolName === undefined ? {} : { toolName: preset.toolName }),
			},
		);
		yield* events;
		if (!settled)
			yield {
				type: "failed",
				class: "unknown",
				message:
					"attempt was launched by another process; the ACP session belonged to that process, so its live stream cannot be observed here",
				raw: { pid: record.pid ?? null },
			};
	}

	return {
		id: preset.id,
		version: ACP_ADAPTER_VERSION,
		contractVersion: EXECUTOR_CONTRACT_VERSION,

		async probe(): Promise<ExecutorProbe> {
			// A preset without a usable `--version` (Antigravity prints build info) is asked through
			// ACP `initialize` (agentInfo.version); no session is created and no model is called.
			const version =
				preset.versionArgs === undefined
					? await initializeVersion(config.command, preset.launchArgs, 15_000)
					: await runCommand(config.command, preset.versionArgs, 15_000).then(
							(run) => ({
								version:
									run.code === 0
										? (run.stdout.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null)
										: null,
								error: run.error ?? `exit ${run.code}`,
							}),
						);
			const cliVersion = version.version;
			if (cliVersion === null)
				return {
					installed: false,
					cliVersion: null,
					auth: "unknown",
					notes: [
						`${preset.label} not runnable as ${config.command}: ${version.error}`,
					],
				};
			// ACP `initialize` lists auth methods, not whether one is set up. A preset that records its
			// login in the engine-owned home says whether one exists (no credential is read).
			const recorded = await preset.authRecorded?.(config.agentHome);
			return {
				installed: true,
				cliVersion,
				auth: recorded === undefined ? "unknown" : recorded ? "ok" : "missing",
				...(preset.mcpOutputLimitChars === undefined
					? {}
					: { mcpOutputLimitChars: preset.mcpOutputLimitChars }),
				notes: [
					preset.id === "antigravity"
						? `${preset.label} ${cliVersion}: built-in; live tier passed on 1.4.5 (docs/executors.md#antigravity-acp)`
						: `ACP pilot: capabilities are declared, not live-verified (${preset.label} ${cliVersion})`,
					...(recorded === false
						? [
								`no login in the worker home ${config.agentHome}; log in once with authenticateAcpAgent (docs/executors.md#antigravity-acp)`,
							]
						: []),
				],
			};
		},

		capabilities: (): ExecutorCapabilities => capabilities,
		...(preset.toolMapping === undefined
			? {}
			: { toolMapping: preset.toolMapping }),

		async submit(req: SubmitRequest): Promise<ExecRef> {
			const problems = validateSubmitRequest(req);
			if (problems.length > 0)
				throw new SdkError("INVALID_REQUEST", problems.join("; "));
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

		observe(ref: ExecRef): AsyncIterable<ExecEvent> {
			const run = runs.get(ref.attemptKey);
			if (run === undefined) return replay(ref);
			return (async function* () {
				const live = findRun(ref);
				let index = 0;
				for (;;) {
					while (index < live.log.length) yield live.log[index++] as ExecEvent;
					if (live.done) return;
					await new Promise<void>((resolve) => live.waiters.push(resolve));
				}
			})();
		},

		async cancel(ref: ExecRef, scope: CancelScope): Promise<CancelResult> {
			const run = runs.get(ref.attemptKey);
			if (run === undefined || run.ref.handle !== ref.handle) {
				const lookup = await store.lookupAttempt(ref.attemptKey);
				if (lookup.status === "unreadable") return "uncertain";
				return lookup.status === "found" && lookup.record.phase === "spawned"
					? "uncertain"
					: "no_active";
			}
			if (run.done) return "too_late";
			run.cancelRequested = true;
			for (const [requestId] of run.pending) answer(run, requestId, "deny");
			if (run.sessionId !== undefined)
				run.peer?.notify("session/cancel", { sessionId: run.sessionId });
			if (scope === "owned") reap(run);
			else
				later(run, config.killGraceMs, () => {
					if (!run.done) reap(run);
				});
			return "cancelled";
		},

		async reconcile(attemptKey: string): Promise<ReconcileResult> {
			const run = runs.get(attemptKey);
			if (run !== undefined) return { found: run.ref };
			const lookup = await store.lookupAttempt(attemptKey);
			if (lookup.status === "missing") return { absent: true };
			if (lookup.status === "unreadable")
				return { unknown: true, reason: lookup.reason };
			const record = lookup.record;
			if (record.phase === "revoked") return { absent: true };
			if (record.phase === "spawned" && record.ref !== undefined) {
				if (replayAcpLog((await readRaw(record.rawPath)) ?? []).settled)
					return { found: record.ref };
				return {
					unknown: true,
					reason: `${preset.label} attempt ${record.ref.handle} (pid ${record.pid ?? "unknown"}) was launched by a process that is gone; its ACP session belonged to that process and no prompt result was recorded, so the outcome is unknown: needs an owner decision, no automatic relaunch (B3)`,
				};
			}
			return {
				unknown: true,
				reason: "authority consumed but no launch evidence was recorded",
			};
		},

		async respond(
			ref: ExecRef,
			requestId: string,
			decision: ApprovalDecision,
		): Promise<ApprovalResponseResult> {
			return answer(findRun(ref), requestId, decision);
		},
	};
}
