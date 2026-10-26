/**
 * Claude Code executor adapter (WP8): `WorkflowExecutor` over `claude -p` stream-json.
 *
 * - submit: idempotent per `attemptKey` (in flight, in memory, durable record), consumes the
 *   authority immediately before the spawn (R#1), records launch evidence durably (B3).
 * - observe: normalized events from the stream (stream.ts); the raw stream is kept in
 *   `artifactsDir/claude-stream.jsonl` with request env values redacted.
 * - respond: answers `can_use_tool` control requests (approval channel, R#4); unanswered requests
 *   are denied after `approvalPolicy.timeoutMs` (fail closed, D2).
 * - cancel: `interrupt` control request; `owned` also ends stdin and escalates SIGTERM → SIGKILL.
 * - reconcile: in-memory run, else the durable record.
 * - deleteOwnedSession: removes only sessions this adapter created and recorded (D3, R#10).
 */
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
	type DeleteOwnedSessionResult,
	type ReconcileResult,
	type SubmitRequest,
	validateSubmitRequest,
	type WorkflowExecutor,
} from "../../sdk/contract.js";
import { SdkError } from "../../sdk/errors.js";
import type { ExecEvent, OwnedSession } from "../../sdk/events.js";
import { buildClaudeInvocation, isUuid, userMessageLine } from "./argv.js";
import { claudeCapabilities } from "./capabilities.js";
import {
	CLAUDE_ADAPTER_VERSION,
	CLAUDE_EXECUTOR_ID,
	CLAUDE_VERIFIED_CLI_VERSION,
	type ClaudeExecutorConfig,
	mcpOutputLimitChars,
} from "./config.js";
import {
	listModels,
	parseAuthStatus,
	parseCliVersion,
	runCommand,
} from "./probe.js";
import { removeClaudeSessionFiles } from "./sessions.js";
import { ClaudeStateStore } from "./state.js";
import { ClaudeStreamParser, parseClaudeStream } from "./stream.js";

export const CLAUDE_SESSION_KIND = "claude-session";
export const RAW_STREAM_FILE = "claude-stream.jsonl";
export const RAW_STDERR_FILE = "claude-stderr.log";
export const MCP_CONFIG_FILE = "claude-mcp-config.json";
export const INVOCATION_FILE = "claude-invocation.json";

export interface ClaudeWorkflowExecutor extends WorkflowExecutor {
	/** Delete a worker session this adapter kept (`ownedSession` of a terminal event). */
	deleteOwnedSession(session: OwnedSession): Promise<DeleteOwnedSessionResult>;
}

export interface ClaudeExecutorFaults {
	/** Conformance fault: consume the authority, then fail before any launch evidence. */
	readonly crashAfterConsume?: boolean;
}

interface PendingApproval {
	readonly toolUseId: string | null;
	readonly input: unknown;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface Run {
	readonly ref: ExecRef;
	readonly log: ExecEvent[];
	done: boolean;
	exited: boolean;
	readonly waiters: (() => void)[];
	readonly child: ReturnType<typeof spawn>;
	readonly parser: ClaudeStreamParser;
	cancelRequested: boolean;
	stdinOpen: boolean;
	readonly pending: Map<string, PendingApproval>;
	readonly answered: Set<string>;
	readonly timers: ReturnType<typeof setTimeout>[];
}

/** Replace request env values (≥ 8 chars) with `<redacted:KEY>` before anything is written. */
function redactor(req: SubmitRequest): (text: string) => string {
	const secrets: [string, string][] = [];
	for (const [key, value] of Object.entries(req.env))
		if (value.length >= 8) secrets.push([value, key]);
	for (const server of req.mcpServers)
		for (const [key, value] of Object.entries(server.env ?? {}))
			if (value.length >= 8) secrets.push([value, `${server.name}.${key}`]);
	secrets.sort((a, b) => b[0].length - a[0].length);
	if (secrets.length === 0) return (text) => text;
	return (text) => {
		let out = text;
		for (const [value, key] of secrets)
			if (out.includes(value)) out = out.split(value).join(`<redacted:${key}>`);
		return out;
	};
}

export function createClaudeExecutor(options: {
	readonly config: ClaudeExecutorConfig;
	readonly faults?: ClaudeExecutorFaults;
}): ClaudeWorkflowExecutor {
	const { config } = options;
	const store = new ClaudeStateStore(config.stateDir);
	const runs = new Map<string, Run>();
	const inflight = new Map<string, Promise<ExecRef>>();
	const capabilities = claudeCapabilities(config.systemPromptMode);

	const push = (run: Run, event: ExecEvent) => {
		if (run.done) return;
		run.log.push(event);
		if (event.type === "completed" || event.type === "failed") {
			run.done = true;
			for (const pending of run.pending.values()) clearTimeout(pending.timer);
		}
		for (const wake of run.waiters.splice(0)) wake();
	};

	const writeStdin = (run: Run, message: unknown) => {
		if (!run.stdinOpen) return false;
		run.child.stdin?.write(`${JSON.stringify(message)}\n`);
		return true;
	};

	const endStdin = (run: Run) => {
		if (!run.stdinOpen) return;
		run.stdinOpen = false;
		run.child.stdin?.end();
	};

	const later = (run: Run, ms: number, action: () => void) => {
		const timer = setTimeout(action, ms);
		timer.unref();
		run.timers.push(timer);
	};

	/** After stdin is closed the CLI should exit; make sure it does. */
	const reap = (run: Run) => {
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
		if (run.done || !run.stdinOpen) return "too_late";
		if (decision === "deny") run.parser.markDenied(pending.toolUseId);
		writeStdin(run, {
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response:
					decision === "allow"
						? { behavior: "allow", updatedInput: pending.input }
						: {
								behavior: "deny",
								message:
									"Denied by the workflow engine's approval policy. Do not retry this action.",
							},
			},
		});
		return "accepted";
	};

	async function launch(req: SubmitRequest): Promise<ExecRef> {
		const known = runs.get(req.attemptKey);
		if (known !== undefined) return known.ref;
		const record = await store.readAttempt(req.attemptKey);
		if (record?.phase === "spawned" && record.ref !== undefined)
			return record.ref;
		if (record?.phase === "consumed")
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`attempt ${req.attemptKey} consumed its authority without launch evidence; reconcile reports unknown`,
				{ subject: req.attemptKey },
			);
		if (record?.phase === "revoked")
			throw new SdkError(
				"AUTHORITY_REVOKED",
				`attempt ${req.attemptKey} was revoked`,
				{ subject: req.attemptKey },
			);
		const filesDir = req.artifactsDir ?? store.attemptFilesDir(req.attemptKey);
		const mcpConfigPath =
			req.mcpServers.length > 0 ? join(filesDir, MCP_CONFIG_FILE) : null;
		// Everything that can refuse the request runs before consume (no effect on refusal).
		const plan = buildClaudeInvocation(req, config, { mcpConfigPath });
		const redact = redactor(req);

		const decision = await req.authority.consume(); // immediately before the first effect (R#1)
		if (decision.kind === "revoked")
			await store.writeAttempt({
				attemptKey: req.attemptKey,
				phase: "revoked",
				sessionId: null,
				keepSession: false,
			});
		requireReleased(decision);
		await store.writeAttempt({
			attemptKey: req.attemptKey,
			phase: "consumed",
			sessionId: plan.sessionId,
			keepSession: plan.keepSession,
			cwd: req.cwd,
		});
		if (options.faults?.crashAfterConsume === true)
			throw new Error("injected fault: crash after consume, before launch");

		await mkdir(filesDir, { recursive: true });
		if (plan.mcpConfig !== null && mcpConfigPath !== null)
			await writeFile(mcpConfigPath, JSON.stringify(plan.mcpConfig, null, 2), {
				mode: 0o600,
			});
		const rawPath = join(filesDir, RAW_STREAM_FILE);
		const stderrPath = join(filesDir, RAW_STDERR_FILE);
		await writeFile(
			join(filesDir, INVOCATION_FILE),
			JSON.stringify(
				{
					schema: "agent-workflow-claude-invocation-v1",
					command: config.claudePath,
					argv: plan.argv.map(redact),
					envKeys: Object.keys(plan.env).sort(),
					cwd: req.cwd,
					sessionId: plan.sessionId,
					keepSession: plan.keepSession,
					builtinTools: plan.builtinTools,
					allowedTools: plan.allowedTools,
					requestPermissionMode: req.permissionMode ?? null,
					permissionMode: plan.permissionMode,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		const rawStream: WriteStream = createWriteStream(rawPath, { mode: 0o600 });
		const stderrStream: WriteStream = createWriteStream(stderrPath, {
			mode: 0o600,
		});
		rawStream.on("error", () => {});
		stderrStream.on("error", () => {});

		const child = spawn(config.claudePath, plan.argv, {
			cwd: req.cwd,
			env: { ...process.env, ...plan.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const ref: ExecRef = {
			executorId: CLAUDE_EXECUTOR_ID,
			attemptKey: req.attemptKey,
			handle: `claude-session:${plan.sessionId}`,
			sessionId: plan.sessionId,
		};
		const ownedSession: OwnedSession | undefined = plan.keepSession
			? { kind: CLAUDE_SESSION_KIND, locator: plan.sessionId }
			: undefined;
		let runRef: Run | undefined;
		const parser = new ClaudeStreamParser(
			(event) => {
				if (runRef !== undefined) push(runRef, event);
			},
			{
				cancelRequested: () => runRef?.cancelRequested === true,
				mcpServers: req.mcpServers.map((server) => server.name),
				...(ownedSession === undefined ? {} : { ownedSession }),
			},
		);
		const run: Run = {
			ref,
			log: [],
			done: false,
			exited: false,
			waiters: [],
			child,
			parser,
			cancelRequested: false,
			stdinOpen: true,
			pending: new Map(),
			answered: new Set(),
			timers: [],
		};
		runRef = run;
		runs.set(req.attemptKey, run);
		await store.writeAttempt({
			attemptKey: req.attemptKey,
			phase: "spawned",
			sessionId: plan.sessionId,
			keepSession: plan.keepSession,
			ref,
			pid: child.pid ?? null,
			cwd: req.cwd,
			rawPath,
			stderrPath,
		});
		if (plan.keepSession)
			await store.recordSession({
				sessionId: plan.sessionId,
				attemptKey: req.attemptKey,
				cwd: req.cwd,
			});

		child.stdin?.on("error", () => {
			run.stdinOpen = false;
		});
		let stderr = "";
		let spawnError: string | undefined;
		child.on("error", (error) => {
			spawnError = error.message;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = redact(chunk.toString("utf8"));
			stderrStream.write(text);
			stderr = (stderr + text).slice(-65_536);
		});
		const lines = child.stdout
			? createInterface({
					input: child.stdout,
					crlfDelay: Number.POSITIVE_INFINITY,
				})
			: null;
		lines?.on("line", (line) => {
			const safe = redact(line);
			rawStream.write(`${safe}\n`);
			for (const action of parser.line(safe)) {
				if (action.type === "result") {
					endStdin(run);
					reap(run);
				} else if (action.type === "unsupported_control")
					writeStdin(run, {
						type: "control_response",
						response: {
							subtype: "error",
							request_id: action.requestId,
							error: `agent-workflow does not serve control request ${action.subtype}`,
						},
					});
				else {
					// The approval input is echoed back unredacted on allow (redaction is for logs only).
					let input: unknown = action.request.input;
					try {
						const original = JSON.parse(line) as {
							request?: { input?: unknown };
						};
						input = original.request?.input ?? input;
					} catch {
						// unparsable original line: keep the parser's copy of the input
					}
					const requestId = action.request.requestId;
					const timer = setTimeout(
						() => answer(run, requestId, "deny"),
						Math.max(0, req.approvalPolicy.timeoutMs),
					);
					timer.unref();
					run.pending.set(requestId, {
						toolUseId: action.request.toolUseId,
						input,
						timer,
					});
				}
			}
		});
		child.on("close", (code, signal) => {
			run.exited = true;
			run.stdinOpen = false;
			for (const timer of run.timers) clearTimeout(timer);
			const finish = () => {
				parser.finish({
					exitCode: code,
					signal,
					stderr,
					...(spawnError === undefined ? {} : { spawnError }),
				});
				rawStream.end();
				stderrStream.end();
				if (!plan.keepSession)
					void removeClaudeSessionFiles(
						config.claudeConfigDir,
						plan.sessionId,
						{
							transcript: false,
						},
					).catch(() => {});
			};
			// Let readline flush the last stdout lines before deciding the terminal event.
			if (lines !== null) setImmediate(finish);
			else finish();
		});
		if (child.pid !== undefined)
			child.stdin?.write(`${userMessageLine(req.prompt)}\n`);
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

	async function* replay(ref: ExecRef): AsyncGenerator<ExecEvent> {
		const record = await store.readAttempt(ref.attemptKey);
		if (
			record?.phase !== "spawned" ||
			record.ref?.handle !== ref.handle ||
			record.rawPath === undefined
		)
			throw new SdkError(
				"UNKNOWN_EXEC_REF",
				`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
			);
		let text = "";
		try {
			text = await readFile(record.rawPath, "utf8");
		} catch {
			// no raw stream recorded yet: replay what exists (nothing)
		}
		const owned: OwnedSession | undefined =
			record.keepSession && record.sessionId !== null
				? { kind: CLAUDE_SESSION_KIND, locator: record.sessionId }
				: undefined;
		const events = parseClaudeStream(text.split("\n"), {
			...(owned === undefined ? {} : { ownedSession: owned }),
		});
		const terminal = events.some(
			(event) => event.type === "completed" || event.type === "failed",
		);
		if (!terminal)
			events.push(
				...(events.length === 0
					? [{ type: "started" as const, sessionId: record.sessionId }]
					: []),
				{
					type: "failed",
					class: "unknown",
					message:
						"attempt was launched by another process; the claude CLI is session-bound, so its live stream cannot be observed here",
					raw: { pid: record.pid ?? null },
				},
			);
		yield* events;
	}

	return {
		id: CLAUDE_EXECUTOR_ID,
		version: CLAUDE_ADAPTER_VERSION,
		contractVersion: EXECUTOR_CONTRACT_VERSION,

		async probe(): Promise<ExecutorProbe> {
			const version = await runCommand(config.claudePath, ["--version"], {
				timeoutMs: 15_000,
			});
			const cliVersion =
				version.code === 0 ? parseCliVersion(version.stdout) : null;
			const notes: string[] = [];
			if (cliVersion === null)
				return {
					installed: false,
					cliVersion: null,
					auth: "unknown",
					mcpOutputLimitChars: mcpOutputLimitChars(config.mcpOutputTokens),
					notes: [
						`claude CLI not runnable: ${version.error ?? `exit ${version.code}`}`,
					],
				};
			if (cliVersion !== CLAUDE_VERIFIED_CLI_VERSION)
				notes.push(
					`capabilities verified with claude-code ${CLAUDE_VERIFIED_CLI_VERSION}; installed ${cliVersion}`,
				);
			const auth = parseAuthStatus(
				await runCommand(config.claudePath, ["auth", "status", "--json"], {
					timeoutMs: 15_000,
				}),
			);
			if (config.listModels) {
				const models = await listModels(config.claudePath, {
					timeoutMs: 20_000,
					cwd: tmpdir(),
				});
				notes.push(
					models === null
						? "models: not listable (initialize control request failed)"
						: `models: ${models.join(", ")}`,
				);
			}
			notes.push(
				`MAX_MCP_OUTPUT_TOKENS=${config.mcpOutputTokens} (set by the adapter)`,
			);
			return {
				installed: true,
				cliVersion,
				auth,
				mcpOutputLimitChars: mcpOutputLimitChars(config.mcpOutputTokens),
				notes,
			};
		},

		capabilities: (): ExecutorCapabilities => capabilities,

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
				const record = await store.readAttempt(ref.attemptKey);
				// Launched by a process that is gone or elsewhere: this instance cannot reach it.
				return record?.phase === "spawned" ? "uncertain" : "no_active";
			}
			if (run.done) return "too_late";
			run.cancelRequested = true;
			writeStdin(run, {
				type: "control_request",
				request_id: `aw-interrupt-${Date.now()}`,
				request: { subtype: "interrupt" },
			});
			if (scope === "owned") {
				endStdin(run);
				reap(run);
			} else
				later(run, config.killGraceMs, () => {
					if (run.done) return;
					endStdin(run);
					reap(run);
				});
			return "cancelled";
		},

		async reconcile(attemptKey: string): Promise<ReconcileResult> {
			const run = runs.get(attemptKey);
			if (run !== undefined) return { found: run.ref };
			const record = await store.readAttempt(attemptKey);
			if (record === undefined || record.phase === "revoked")
				return { absent: true };
			if (record.phase === "spawned" && record.ref !== undefined)
				return { found: record.ref };
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

		async deleteOwnedSession(
			session: OwnedSession,
		): Promise<DeleteOwnedSessionResult> {
			if (session.kind !== CLAUDE_SESSION_KIND || !isUuid(session.locator))
				return "refused";
			const record = await store.readSession(session.locator);
			if (record === undefined) return "refused";
			const removed = await removeClaudeSessionFiles(
				config.claudeConfigDir,
				session.locator,
				{ transcript: true },
			);
			await store.forgetSession(session.locator);
			return removed > 0 ? "deleted" : "not_found";
		},
	};
}
