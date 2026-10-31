// New in agent-workflow (WP2a-2): drives one SDK executor attempt (submit → observe) under a
// runtime-enforced fence and turns the normalized event stream into attempt artifacts.
// Replaces the Pi runner call in pi-subagent's src/orchestrate/run.ts (runHeadlessModel /
// runInlineModel / runTmuxModel) and the output/usage parsing those runners did.
// WP2b: approval requests under an interactive policy wait for a host answer through the durable
// control mailbox (orchestrate/control.ts) up to approvalPolicy.timeoutMs, then deny
// (default-timeout); every decision is audited in approvals.jsonl with who decided it; a mailbox
// cancel(owned) takes the stop path, cancel(turn) is forwarded to the executor.
import { type ApprovalDecision, decideApproval } from "../../sdk/approval.js";
import type {
	AuthorityDecision,
	ExecutionAuthority,
} from "../../sdk/authority.js";
import type {
	CancelResult,
	ExecRef,
	ReconcileResult,
	WorkflowExecutor,
} from "../../sdk/contract.js";
import { isSdkError, SdkError } from "../../sdk/errors.js";
import {
	type CompletedEvent,
	type ExecEvent,
	type FailedEvent,
	isTerminalEvent,
	type UsageSource,
	validateEventSequence,
	validateExecEvent,
} from "../../sdk/events.js";
import type {
	ArtifactRef,
	ResultExecutorMetadata,
} from "../artifacts/result.js";
import type { AttemptArtifactStore } from "../artifacts/store.js";
import {
	type FailureKind,
	isFailureKind,
	type Status,
} from "../core/constants.js";
import {
	type DurableLaunchAuthority,
	isDurableAuthorityError,
} from "../durable-authority.js";
import {
	flushToolCallTelemetry,
	processExecToolCall,
	ToolCallTelemetryCollector,
} from "../telemetry/tool-call-telemetry.js";
import { isMutatingKind } from "../../sdk/tools.js";
import {
	type ApprovalDecider,
	type AttemptControl,
	appendApprovalAudit,
} from "./control.js";
import type { SubmitRequestFields } from "./request.js";
import type { TaskActivity } from "../../core/task-activity.js";
import { activityFromExecEvent } from "../telemetry/task-activity.js";

/** How long the runtime waits for a terminal event after it asked the executor to stop. */
export const DEFAULT_CANCEL_GRACE_MS = 10_000;

export function cancelGraceMs(): number {
	const raw = Number.parseInt(
		process.env.AGENT_WORKFLOW_CANCEL_GRACE_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CANCEL_GRACE_MS;
}

/**
 * Summed `usage` events (normalized meaning: SDK `UsageEvent`). A field is null when any event
 * reported it unknown (never 0). WP12a: `cacheWrite` (absent on every event = 0), `total` =
 * input + cached + cacheWrite + output (null when any part is unknown), `model` = the last model an
 * event named.
 */
export interface UsageSummary {
	input: number | null;
	output: number | null;
	cached: number | null;
	cacheWrite: number | null;
	total: number | null;
	model?: string;
	cost: number | null;
	source: UsageSource;
	events: number;
}

export function summarizeUsage(
	events: readonly ExecEvent[],
): UsageSummary | undefined {
	const usage = events.filter(
		(event): event is Extract<ExecEvent, { type: "usage" }> =>
			event.type === "usage",
	);
	if (usage.length === 0) return undefined;
	const sum = (key: "input" | "output" | "cached" | "cost") =>
		usage.some((event) => event[key] === null)
			? null
			: usage.reduce((total, event) => total + (event[key] ?? 0), 0);
	const cacheWrite = usage.some((event) => event.cacheWrite === null)
		? null
		: usage.reduce((total, event) => total + (event.cacheWrite ?? 0), 0);
	const sources = new Set(usage.map((event) => event.source));
	const source: UsageSource = sources.has("unknown")
		? "unknown"
		: sources.has("estimated")
			? "estimated"
			: "reported";
	const cost = sum("cost");
	const input = sum("input");
	const output = sum("output");
	const cached = sum("cached");
	const total =
		input === null || output === null || cached === null || cacheWrite === null
			? null
			: input + output + cached + cacheWrite;
	const model = usage
		.map((event) => event.model)
		.filter((name): name is string => typeof name === "string" && name !== "")
		.at(-1);
	return {
		input,
		output,
		cached,
		cacheWrite,
		total,
		...(model === undefined ? {} : { model }),
		// Floating sums are rounded to 12 decimals so 0.1 + 0.2 does not leak into records.
		cost: cost === null ? null : Math.round(cost * 1e12) / 1e12,
		source,
		events: usage.length,
	};
}

/** `failed.class` → (status, failureKind). See docs/runtime-port.md "Failure kinds". */
export function statusForFailureClass(failureClass: FailedEvent["class"]): {
	status: Status;
	failureKind: FailureKind;
} {
	switch (failureClass) {
		case "cancelled":
			return { status: "cancelled", failureKind: "cancelled" };
		case "transient":
			return { status: "failed", failureKind: "transient" };
		case "rate_limit":
			return { status: "failed", failureKind: "rate_limit" };
		case "auth":
			return { status: "failed", failureKind: "executor_auth" };
		case "config":
			return { status: "failed", failureKind: "executor_config" };
		case "permanent":
			return { status: "failed", failureKind: "executor_permanent" };
		default:
			return { status: "failed", failureKind: "executor_unknown" };
	}
}

/** Why the runtime stopped an attempt: user/engine cancel, plain abort, or the timeout. */
export type StopKind = "user_cancelled" | "abort" | "timeout";

export function stopKind(signal: AbortSignal | undefined): StopKind {
	const reason = signal?.reason as { failureKind?: unknown } | undefined;
	return reason?.failureKind === "timeout"
		? "timeout"
		: reason?.failureKind === "user_cancelled"
			? "user_cancelled"
			: "abort";
}

function statusForStop(kind: StopKind): Status {
	return kind === "timeout" ? "failed" : "cancelled";
}

/**
 * The attempt never reached an effect: the authority was revoked/refused or the executor
 * declined before consuming. Callers treat the workspace as still "prepared".
 */
export class ExecutionNotStartedError extends Error {
	readonly failureKind: FailureKind;
	readonly status: Status;
	readonly authority: ResultExecutorMetadata["authority"];

	constructor(
		message: string,
		options: {
			failureKind: FailureKind;
			status: Status;
			authority: ResultExecutorMetadata["authority"];
			cause?: unknown;
		},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "ExecutionNotStartedError";
		this.failureKind = options.failureKind;
		this.status = options.status;
		this.authority = options.authority;
	}
}

export function isExecutionNotStartedError(
	error: unknown,
): error is ExecutionNotStartedError {
	return error instanceof ExecutionNotStartedError;
}

export interface ExecutionReport {
	status: Status;
	failureKind: FailureKind | null;
	/** Runtime diagnostics for stderr.log (empty on a clean completion). */
	message: string;
	outputText: string;
	outputPartial: boolean;
	usage?: UsageSummary;
	sessionId?: string;
	executor: ResultExecutorMetadata;
	artifacts: ArtifactRef[];
}

type FenceState =
	| "unconsumed"
	| "consuming"
	| "released"
	| "revoked"
	| "failed";

interface Fence {
	readonly authority: ExecutionAuthority &
		Pick<DurableLaunchAuthority, "binding">;
	state(): FenceState;
	decision(): AuthorityDecision | undefined;
	failure(): Error | undefined;
	/** Refuse every later consume (the runtime stopped waiting for `submit`). */
	close(reason: string): void;
}

/** Wrap the authority handed to the adapter so the runtime sees exactly what the adapter did. */
function fenceAuthority(inner: ExecutionAuthority): Fence {
	let state: FenceState = "unconsumed";
	let decision: AuthorityDecision | undefined;
	let failure: Error | undefined;
	let closed: string | undefined;
	// The adapter sees the durable authority's binding (if any) through the fence.
	const binding = (inner as Partial<DurableLaunchAuthority>).binding;
	return {
		authority: {
			attemptKey: inner.attemptKey,
			binding: () => binding?.call(inner),
			async consume() {
				if (state !== "unconsumed") return await inner.consume();
				if (closed !== undefined) {
					state = "revoked";
					decision = {
						kind: "revoked",
						attemptKey: inner.attemptKey,
						reason: closed,
					};
					return decision;
				}
				state = "consuming";
				try {
					decision = await inner.consume();
					state = decision.kind;
					return decision;
				} catch (error) {
					state = "failed";
					failure = error instanceof Error ? error : new Error(String(error));
					throw error;
				}
			},
		},
		state: () => state,
		decision: () => decision,
		failure: () => failure,
		close(reason) {
			closed ??= reason;
		},
	};
}

function authorityLabel(
	state: FenceState,
): ResultExecutorMetadata["authority"] {
	return state === "consuming" ? "unconsumed" : state;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failureKindOf(error: unknown, fallback: FailureKind): FailureKind {
	const candidate =
		typeof error === "object" && error !== null && "failureKind" in error
			? (error as { failureKind?: unknown }).failureKind
			: undefined;
	return isFailureKind(candidate) ? candidate : fallback;
}

/** Map an error raised before any effect into the attempt's terminal status. */
function notStarted(
	error: unknown,
	fence: Fence,
	stopSignal: AbortSignal | undefined,
): ExecutionNotStartedError {
	const authority = authorityLabel(fence.state());
	if (stopSignal?.aborted) {
		const kind = stopKind(stopSignal);
		return new ExecutionNotStartedError(
			kind === "timeout"
				? "attempt timed out before the executor launched"
				: `attempt was cancelled before the executor launched: ${errorMessage(error)}`,
			{
				failureKind: kind,
				status: statusForStop(kind),
				authority,
				cause: error,
			},
		);
	}
	const decision = fence.decision();
	if (fence.state() === "revoked" && decision?.kind === "revoked")
		return new ExecutionNotStartedError(
			`execution authority was revoked: ${decision.reason}`,
			{
				// WP2c: an engine revoke is not a user interrupt (a stop signal is handled above).
				failureKind: "revoked",
				status: "cancelled",
				authority,
				cause: error,
			},
		);
	if (fence.state() === "failed") {
		const cause = fence.failure() ?? error;
		return new ExecutionNotStartedError(errorMessage(cause), {
			failureKind:
				isDurableAuthorityError(cause) ||
				isSdkError(cause, "AUTHORITY_ALREADY_CONSUMED")
					? "guard_failure"
					: failureKindOf(cause, "internal"),
			status: "failed",
			authority,
			cause,
		});
	}
	// The adapter refused before consuming. A refusal that claims an authority state the runtime
	// never produced is itself a fence fault.
	const failureKind =
		isSdkError(error, "AUTHORITY_REVOKED") ||
		isSdkError(error, "AUTHORITY_ALREADY_CONSUMED")
			? "guard_failure"
			: isSdkError(error, "INVALID_REQUEST") ||
					isSdkError(error, "CAPABILITY_MISSING") ||
					isSdkError(error, "CAPABILITY_UNVERIFIED")
				? "validation"
				: failureKindOf(error, "spawn");
	return new ExecutionNotStartedError(
		`executor refused the attempt before launch: ${errorMessage(error)}`,
		{ failureKind, status: "failed", authority, cause: error },
	);
}

const STOP: unique symbol = Symbol("stop");
const GRACE: unique symbol = Symbol("grace");

function graceAfter(ms: number): Promise<typeof GRACE> {
	return sleep(ms).then((): typeof GRACE => GRACE);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function onAbort(signal: AbortSignal | undefined): Promise<typeof STOP> {
	return new Promise((resolve) => {
		if (signal === undefined) return;
		if (signal.aborted) resolve(STOP);
		else signal.addEventListener("abort", () => resolve(STOP), { once: true });
	});
}

/** Incremental form of `validateEventSequence` (the SDK rules), checked per event. */
function sequenceProblem(
	events: readonly ExecEvent[],
	event: ExecEvent,
	approvals: Set<string>,
): string | undefined {
	const index = events.length;
	if (index === 0 && event.type !== "started")
		return "#0: first event must be started";
	if (index > 0 && event.type === "started")
		return `#${index}: started must be the first event`;
	if (event.type === "approval_request") {
		if (approvals.has(event.requestId))
			return `#${index}: duplicate approval requestId ${event.requestId}`;
		approvals.add(event.requestId);
	}
	return undefined;
}

export interface ExecuteAttemptOptions {
	executor: WorkflowExecutor;
	request: SubmitRequestFields;
	/** Inner authority (durable); the runtime wraps it in its fence. */
	authority: ExecutionAuthority;
	store: AttemptArtifactStore;
	/** Aborted on user cancel (reason.failureKind "user_cancelled"), abort, or timeout ("timeout"). */
	stopSignal?: AbortSignal;
	/** Called once the authority released (the workspace becomes execution-owned). */
	onReleased?(): void;
	/** Called once with the ExecRef the runtime is going to observe. */
	onSubmitted?(ref: ExecRef): Promise<void> | void;
	cancelGraceMs?: number;
	/** Write tool-calls.jsonl / tool-calls-summary.json from normalized tool_call events. */
	captureToolCalls?: boolean;
	/** Always-on latest intent; independent of tool-call artifact capture. */
	onActivity?(activity: TaskActivity): void;
	/** WP2b: the attempt's control mailbox state (interactive approvals, cancel relay). */
	control?: AttemptControl;
}

/**
 * Submit and observe one attempt. Throws `ExecutionNotStartedError` when no effect can have
 * happened; otherwise returns a report (also for fence violations, which are `guard_failure`).
 *
 * Runtime-enforced fencing: `submit` resolving with a ref, or any event arriving, while the
 * authority is not `released` (unconsumed, revoked, failed) fails the attempt with
 * `guard_failure` and the runtime calls `cancel(ref, "owned")`. Every event is checked with
 * `validateExecEvent` and the SDK sequence rules; an invalid event or order is `guard_failure`.
 */
export async function executeAttempt(
	options: ExecuteAttemptOptions,
): Promise<ExecutionReport> {
	const { executor, request, store, stopSignal } = options;
	const grace = options.cancelGraceMs ?? cancelGraceMs();
	const fence = fenceAuthority(options.authority);
	const meta: ResultExecutorMetadata = {
		id: executor.id,
		version: executor.version,
		attemptKey: request.attemptKey,
	};
	const notes: string[] = [];
	const toolCalls =
		options.captureToolCalls === true
			? new ToolCallTelemetryCollector()
			: undefined;
	let releasedNotified = false;
	const noteReleased = () => {
		if (!releasedNotified && fence.state() === "released") {
			releasedNotified = true;
			options.onReleased?.();
		}
	};

	const submitted = executor
		.submit({ ...request, authority: fence.authority })
		.then(
			(ref) => ({ ok: true as const, ref }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	type Submitted = Awaited<typeof submitted>;
	let settled: Submitted | typeof STOP | typeof GRACE = await Promise.race([
		submitted,
		onAbort(stopSignal),
	]);
	if (settled === STOP) {
		settled = await Promise.race([submitted, graceAfter(grace)]);
		if (settled === GRACE) {
			fence.close("the runtime stopped waiting for submit");
			noteReleased();
			if (fence.state() !== "released")
				throw notStarted(new Error("submit did not return"), fence, stopSignal);
			const kind = stopKind(stopSignal);
			return await finish({
				status: statusForStop(kind),
				failureKind: kind,
				termination: "unconfirmed",
				message: `${kind}: submit did not return within ${grace} ms after the stop request; the executor may still hold the attempt`,
			});
		}
	}
	noteReleased();

	let ref: ExecRef;
	if (!settled.ok) {
		if (fence.state() !== "released")
			throw notStarted(settled.error, fence, stopSignal);
		// Released, then submit failed: the adapter cannot tell us whether an effect happened.
		// Ask the executor instead of guessing (B3).
		const reconciled = await reconcileSafely(executor, request.attemptKey);
		meta.reconcile = reconciled.outcome;
		if (reconciled.reason !== undefined)
			meta.reconcileReason = reconciled.reason;
		notes.push(`submit failed after release: ${errorMessage(settled.error)}`);
		if (reconciled.ref === undefined)
			return finish(
				reconciled.outcome === "absent"
					? {
							status: "failed",
							failureKind: failureKindOf(settled.error, "spawn"),
							message: "",
						}
					: {
							status: "failed",
							failureKind: "needs_decision",
							termination: "unconfirmed",
							message: `executor reconcile after a failed submit returned ${reconciled.outcome}; an effect may have happened, so the runtime will not retry (B3)`,
						},
			);
		ref = reconciled.ref;
	} else ref = settled.ref;
	meta.ref = { ...ref };

	if (fence.state() !== "released") {
		meta.fenceViolation = `submit returned ${ref.handle} while the execution authority was ${fence.state()}`;
		meta.cancelResult = await cancelSafely(executor, ref);
		return finish({
			status: "failed",
			failureKind: "guard_failure",
			termination: "unconfirmed",
			message: `fence violation: ${meta.fenceViolation}; cancel(owned) → ${meta.cancelResult}`,
		});
	}
	await options.onSubmitted?.(ref);
	options.control?.bind(executor, ref);

	return finish(
		await observeAttempt({
			executor,
			ref,
			store,
			stopSignal,
			grace,
			approvalPolicy: request.approvalPolicy,
			readOnly: request.readOnly,
			...(request.permissionMode === undefined
				? {}
				: { permissionMode: request.permissionMode }),
			meta,
			...(options.control === undefined ? {} : { control: options.control }),
			unauthorized: () =>
				fence.state() === "released" ? undefined : fence.state(),
			cancelOnStop: true,
			onEvent: (event: ExecEvent, index: number) => {
				const activity = activityFromExecEvent(event, request.cwd);
				if (activity) options.onActivity?.(activity);
				if (toolCalls) processExecToolCall(toolCalls, event, index);
			},
		}),
	);

	async function finish(outcome: AttemptOutcome): Promise<ExecutionReport> {
		meta.authority = authorityLabel(fence.state());
		const report = await buildExecutionReport(store, meta, notes, outcome);
		report.artifacts.push(...(await flushToolCallTelemetry(toolCalls, store)));
		return report;
	}
}

/** What one observed (or abandoned) attempt amounted to, before artifacts are written. */
export interface AttemptOutcome {
	status: Status;
	failureKind: FailureKind | null;
	message: string;
	termination?: "confirmed" | "unconfirmed";
	usage?: UsageSummary;
	sessionId?: string;
	deltas?: string;
	finalText?: string;
	ownedSession?: { kind: string; locator: string };
	/** Observation stopped without a terminal event and without cancelling (adoption window). */
	abandoned?: boolean;
}

export interface ObserveAttemptOptions {
	executor: WorkflowExecutor;
	ref: ExecRef;
	store: AttemptArtifactStore;
	stopSignal?: AbortSignal;
	grace: number;
	approvalPolicy: SubmitRequestFields["approvalPolicy"];
	readOnly: boolean;
	/** WP4e: `free` answers every request `allow` except mutating kinds on a readOnly stage. */
	permissionMode?: SubmitRequestFields["permissionMode"];
	meta: ResultExecutorMetadata;
	/** Returns the authority state when it is not `released` (an event then is a fence fault). */
	unauthorized(): string | undefined;
	/**
	 * true: a stop sends `cancel(ref, "owned")` and waits `grace` ms for a terminal event.
	 * false (adoption by reconcile): a stop just abandons observation, leaving the attempt alone.
	 */
	cancelOnStop: boolean;
	/** Called for every accepted (valid, authorized) event, in order. */
	onEvent?(event: ExecEvent, index: number): void;
	/** WP2b: interactive approvals wait for a mailbox answer; owned cancels are reported to it. */
	control?: AttemptControl;
}

/** Why the policy decided (audit text), mirroring `decideApproval`. */
function policyReason(
	kind: Parameters<typeof isMutatingKind>[0],
	readOnly: boolean,
	decision: ApprovalDecision | "ask",
	free = false,
): string {
	if (readOnly && isMutatingKind(kind))
		return `readOnly stage denies mutating kind ${kind}`;
	if (decision === "allow" && free)
		return `free permission mode allows ${kind} (D2 revised)`;
	if (decision === "allow") return `approvalPolicy.allowKinds includes ${kind}`;
	if (decision === "ask") return "interactive policy";
	return `${kind} is not in approvalPolicy.allowKinds and no interactive host (fail-closed, D2)`;
}

/** Observe one ExecRef to its terminal event, validating every event and the sequence. */
export async function observeAttempt(
	options: ObserveAttemptOptions,
): Promise<AttemptOutcome> {
	const { executor, ref, store, stopSignal, grace, meta } = options;
	const events: ExecEvent[] = [];
	const approvals = new Set<string>();
	let deltas = "";
	let sessionId: string | undefined;
	let terminal: CompletedEvent | FailedEvent | undefined;
	let violation: string | undefined;
	let observeError: string | undefined;
	let stopHandled = false;
	let gracePromise: Promise<typeof GRACE> | undefined;
	let termination: "confirmed" | "unconfirmed" = "confirmed";
	let exhausted = false;
	let abandoned = false;
	const iterator = executor.observe(ref)[Symbol.asyncIterator]();
	const stopPromise = onAbort(stopSignal);
	const nextEvent = () =>
		iterator.next().then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
	let pending = nextEvent();
	for (;;) {
		const winner = await Promise.race([
			pending,
			stopHandled ? (gracePromise as Promise<typeof GRACE>) : stopPromise,
		]);
		if (winner === STOP) {
			if (!options.cancelOnStop) {
				abandoned = true;
				termination = "unconfirmed";
				void Promise.resolve(iterator.return?.()).catch(() => undefined);
				break;
			}
			stopHandled = true;
			const cancelResult = await cancelSafely(executor, ref);
			meta.cancelResult = cancelResult;
			options.control?.noteOwnedCancel(cancelResult);
			gracePromise = graceAfter(grace);
			continue;
		}
		if (winner === GRACE) {
			termination = "unconfirmed";
			void Promise.resolve(iterator.return?.()).catch(() => undefined);
			break;
		}
		if ("error" in winner) {
			observeError = errorMessage(winner.error);
			break;
		}
		if (winner.result.done) {
			exhausted = true;
			break;
		}
		const event = winner.result.value as unknown;
		const problems = validateExecEvent(event);
		if (problems.length > 0) {
			violation = `invalid event #${events.length}: ${problems.join("; ")}`;
			break;
		}
		const valid = event as ExecEvent;
		const order = sequenceProblem(events, valid, approvals);
		if (order !== undefined) {
			violation = `invalid event sequence: ${order}`;
			break;
		}
		const unauthorized = options.unauthorized();
		if (unauthorized !== undefined) {
			violation = `event ${valid.type} arrived while the execution authority was ${unauthorized}`;
			break;
		}
		events.push(valid);
		options.onEvent?.(valid, events.length - 1);
		const asked =
			valid.type === "approval_request"
				? decideApproval(options.approvalPolicy, valid, {
						readOnly: options.readOnly,
						...(options.permissionMode === undefined
							? {}
							: { permissionMode: options.permissionMode }),
					})
				: undefined;
		// The waiter exists before the request is visible on disk, so an early answer finds it.
		if (valid.type === "approval_request" && asked === "ask")
			options.control?.expectApproval(valid.requestId);
		await store.appendTextArtifact("exec-events", `${JSON.stringify(valid)}\n`);
		if (valid.type === "started" && valid.sessionId !== null)
			sessionId = valid.sessionId;
		if (valid.type === "message_delta") deltas += valid.text;
		if (valid.type === "approval_request" && asked !== undefined) {
			const requestedAt = new Date();
			const waits = asked === "ask" && options.control !== undefined;
			await appendApprovalAudit(store.attemptDir, {
				phase: "requested",
				requestId: valid.requestId,
				kind: valid.kind,
				...(valid.detail === undefined ? {} : { detail: valid.detail }),
				at: requestedAt.toISOString(),
				deadlineAt: waits
					? new Date(
							requestedAt.getTime() + options.approvalPolicy.timeoutMs,
						).toISOString()
					: null,
			}).catch(() => undefined);
			let decision: ApprovalDecision;
			let by: ApprovalDecider;
			let reason: string;
			let seq: number | undefined;
			if (asked !== "ask") {
				const free = options.permissionMode === "free";
				decision = asked;
				by = free ? "engine-policy:free" : "engine-policy";
				reason = policyReason(valid.kind, options.readOnly, asked, free);
				options.control?.markDecided(valid.requestId);
			} else if (options.control === undefined) {
				// No control channel in this process (e.g. reconcile adoption): fail closed (D2).
				decision = "deny";
				by = "engine-policy";
				reason =
					"interactive policy but no control channel in this process (fail-closed, D2)";
			} else {
				({ decision, by, reason, seq } = await options.control.awaitApproval(
					valid.requestId,
					options.approvalPolicy.timeoutMs,
					stopPromise,
				));
			}
			const response = await executor
				.respond(ref, valid.requestId, decision)
				.catch((error: unknown) => `error: ${errorMessage(error)}`);
			options.control?.settleApproval(valid.requestId, response);
			await appendApprovalAudit(store.attemptDir, {
				phase: "decided",
				requestId: valid.requestId,
				kind: valid.kind,
				decision,
				by,
				reason,
				response,
				...(seq === undefined ? {} : { seq }),
				at: new Date().toISOString(),
			}).catch(() => undefined);
			meta.approvals = [
				...(meta.approvals ?? []),
				{
					requestId: valid.requestId,
					kind: valid.kind,
					decision,
					by,
					response,
				},
			];
		}
		if (isTerminalEvent(valid)) {
			terminal = valid;
			void Promise.resolve(iterator.return?.()).catch(() => undefined);
			break;
		}
		pending = nextEvent();
	}
	if (violation === undefined && terminal !== undefined) {
		const sequence = validateEventSequence(events);
		if (sequence.length > 0)
			violation = `invalid event sequence: ${sequence.join("; ")}`;
	}
	if (violation === undefined && exhausted && terminal === undefined)
		violation = "invalid event sequence: stream ended without a terminal event";

	const usage = summarizeUsage(events);
	const extra = {
		...(usage === undefined ? {} : { usage }),
		...(sessionId === undefined ? {} : { sessionId }),
		deltas,
		...(terminal?.type === "completed"
			? { finalText: terminal.finalText }
			: {}),
		...(terminal?.ownedSession === undefined
			? {}
			: { ownedSession: terminal.ownedSession }),
	};

	if (violation !== undefined) {
		meta.fenceViolation = violation;
		meta.cancelResult ??= await cancelSafely(executor, ref);
		return {
			status: "failed",
			failureKind: "guard_failure",
			termination: "unconfirmed",
			message: `${violation}; cancel(owned) → ${meta.cancelResult}`,
			...extra,
		};
	}
	if (observeError !== undefined) {
		meta.cancelResult ??= await cancelSafely(executor, ref);
		return {
			status: "failed",
			failureKind: "executor_unknown",
			termination: "unconfirmed",
			message: `observe failed: ${observeError}; cancel(owned) → ${meta.cancelResult}`,
			...extra,
		};
	}
	if (abandoned)
		return {
			status: "running",
			failureKind: null,
			termination: "unconfirmed",
			message: "observation window ended before a terminal event",
			abandoned: true,
			...extra,
		};
	if (terminal === undefined) {
		const kind = stopKind(stopSignal);
		return {
			status: statusForStop(kind),
			failureKind: kind,
			termination,
			message: `${kind}: no terminal event within ${grace} ms after cancel(owned) → ${meta.cancelResult ?? "not sent"}; the executor may still hold the attempt`,
			...extra,
		};
	}
	if (terminal.type === "completed")
		return { status: "completed", failureKind: null, message: "", ...extra };
	meta.failureClass = terminal.class;
	if (terminal.class === "cancelled" && stopHandled) {
		const kind = stopKind(stopSignal);
		return {
			status: statusForStop(kind),
			failureKind: kind,
			message: `${kind}: ${terminal.message}`,
			...extra,
		};
	}
	return {
		...statusForFailureClass(terminal.class),
		message: `${terminal.class}: ${terminal.message}`,
		...extra,
	};
}

/** Turn an outcome into the report the caller writes as output.log / stderr.log / result.json. */
export async function buildExecutionReport(
	store: AttemptArtifactStore,
	meta: ResultExecutorMetadata,
	notes: readonly string[],
	outcome: AttemptOutcome,
): Promise<ExecutionReport> {
	if (outcome.termination !== undefined) meta.termination = outcome.termination;
	else if (meta.ref !== undefined) meta.termination = "confirmed";
	// R#10 (WP4c, additive): persist the adapter-reported owned session for retention.
	if (outcome.ownedSession !== undefined)
		meta.ownedSession = { ...outcome.ownedSession };
	const completed = outcome.status === "completed";
	// Completed: the final answer only (stale progress is never promoted to an answer).
	// Otherwise: streamed text as partial recovery output.
	const outputText = completed
		? (outcome.finalText ?? "")
		: (outcome.deltas ?? "");
	const message = [...notes, outcome.message].filter(Boolean).join("\n");
	const artifacts: ArtifactRef[] = [];
	if (meta.ref !== undefined)
		artifacts.push(await store.appendTextArtifact("exec-events", ""));
	return {
		status: outcome.status,
		failureKind: outcome.failureKind,
		message,
		outputText,
		outputPartial: !completed && outputText.length > 0,
		...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
		...(outcome.sessionId !== undefined
			? { sessionId: outcome.sessionId }
			: outcome.ownedSession !== undefined
				? { sessionId: outcome.ownedSession.locator }
				: {}),
		executor: meta,
		artifacts,
	};
}

async function cancelSafely(
	executor: WorkflowExecutor,
	ref: ExecRef,
): Promise<CancelResult | "error"> {
	try {
		return await executor.cancel(ref, "owned");
	} catch {
		return "error";
	}
}

/** `executor.reconcile` with errors folded into `unknown` (cannot prove either way). */
export async function reconcileSafely(
	executor: WorkflowExecutor,
	attemptKey: string,
): Promise<{
	outcome: "found" | "absent" | "unknown" | "error";
	ref?: ExecRef;
	reason?: string;
}> {
	let result: ReconcileResult;
	try {
		result = await executor.reconcile(attemptKey);
	} catch (error) {
		return { outcome: "error", reason: errorMessage(error) };
	}
	if ("found" in result) return { outcome: "found", ref: result.found };
	if ("absent" in result && result.absent === true)
		return { outcome: "absent" };
	return {
		outcome: "unknown",
		...("reason" in result && typeof result.reason === "string"
			? { reason: result.reason }
			: {}),
	};
}

export { SdkError };
