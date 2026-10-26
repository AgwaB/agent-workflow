/**
 * Fake executor for SDK tests and the conformance kit skeleton (plan WP3/WP9a; pattern from pi-ai
 * `fauxProvider` and vibe-kanban `qa_mock`). Scripted events, fault injection, and a shared
 * in-memory store that stands in for durable state across "process restarts".
 */
import { awaitApprovalAnswer, type ApprovalDecision, defaultApprovalPolicy } from "../approval.js";
import { type AuthorityGate, type AuthorityTraceEntry, createAuthorityGate, requireReleased } from "../authority.js";
import { type ExecutorCapabilities, level, noneCapabilities } from "../capabilities.js";
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
} from "../contract.js";
import type { ExecutorModule } from "../descriptor.js";
import { SdkError } from "../errors.js";
import { type ApprovalRequestEvent, assertExecEvent, type ExecEvent, isTerminalEvent } from "../events.js";
import type { JsonValue } from "../json.js";

/** Pauses the script on an approval request and branches on the engine's answer. */
export interface FakeApprovalStep {
	readonly approval: ApprovalRequestEvent;
	readonly ifAllowed: readonly ExecEvent[];
	readonly ifDenied: readonly ExecEvent[];
}
export type FakeStep = ExecEvent | FakeApprovalStep;

export type FenceTraceEntry = AuthorityTraceEntry | { readonly type: "effect"; readonly attemptKey: string; readonly executorId: string };

interface FakeRun {
	ref: ExecRef;
	log: ExecEvent[];
	done: boolean;
	cancelled: boolean;
	waiters: (() => void)[];
	pendingApprovals: Map<string, (decision: ApprovalDecision) => void>;
	answeredApprovals: Set<string>;
}

interface FakeAttempt {
	state: "revoked" | "consumed" | "spawned";
	run?: FakeRun;
}

/** Shared state standing in for durable records. Pass the same store to a new fake to simulate restart. */
export interface FakeExecutorStore {
	readonly attempts: Map<string, FakeAttempt>;
	readonly trace: FenceTraceEntry[];
}

export function createFakeStore(): FakeExecutorStore {
	return { attempts: new Map(), trace: [] };
}

/** Authority gate whose consume/revoke decisions are appended to the store trace. */
export function createTracedAuthorityGate(store: FakeExecutorStore, attemptKey: string): AuthorityGate {
	return createAuthorityGate({ attemptKey, onTrace: (entry) => store.trace.push(entry) });
}

export class FakeCrashError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FakeCrashError";
	}
}

export interface FakeExecutorOptions {
	readonly id?: string;
	readonly version?: string;
	readonly contractVersion?: string;
	readonly capabilities?: Partial<ExecutorCapabilities>;
	readonly probe?: ExecutorProbe;
	readonly script?: readonly FakeStep[];
	readonly store?: FakeExecutorStore;
	/** Delay between script steps so cancel/approval tests can interleave. */
	readonly stepDelayMs?: number;
	/** Forced cancel result (e.g. `too_late` for an executor that cannot interrupt). */
	readonly cancelResult?: CancelResult;
	readonly faults?: {
		/** Consume the authority, then "crash" before the effect (reconcile must say unknown). */
		readonly crashAfterConsume?: boolean;
		/** Buggy adapter: produce the effect without consuming authority (conformance must catch it). */
		readonly skipConsume?: boolean;
	};
}

export function fakeCapabilities(overrides: Partial<ExecutorCapabilities> = {}): ExecutorCapabilities {
	const native = level("native");
	return {
		...noneCapabilities(),
		mcpInjection: native,
		readOnly: native,
		toolAllowlist: { ...native, detail: "fine" },
		systemPrompt: { ...native, detail: "append" },
		modelSelect: native,
		effortLevels: ["low", "medium", "high"],
		resume: { ...native, detail: "native" },
		partialStream: native,
		usage: { ...native, detail: "cost" },
		toolTelemetry: native,
		cancel: { ...native, detail: "interrupt" },
		contextIsolation: native,
		...overrides,
	};
}

export const DEFAULT_FAKE_SCRIPT: readonly FakeStep[] = [
	{ type: "started", sessionId: null },
	{ type: "message_delta", text: "fake output" },
	{ type: "usage", input: 10, output: 5, cached: 0, cost: null, source: "unknown" },
	{ type: "completed", finalText: "fake output" },
];

function isApprovalStep(step: FakeStep): step is FakeApprovalStep {
	return "approval" in step;
}

function validateScript(steps: readonly FakeStep[]): void {
	for (const step of steps) {
		if (isApprovalStep(step)) {
			assertExecEvent(step.approval);
			validateScript(step.ifAllowed);
			validateScript(step.ifDenied);
		} else assertExecEvent(step);
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FakeExecutor extends WorkflowExecutor {
	readonly store: FakeExecutorStore;
	/** Number of effects (process spawns) this store has seen for the attempt. */
	effectCount(attemptKey: string): number;
}

export function createFakeExecutor(options: FakeExecutorOptions = {}): FakeExecutor {
	const id = options.id ?? "fake";
	const version = options.version ?? "0.1.0";
	const store = options.store ?? createFakeStore();
	const script = options.script ?? DEFAULT_FAKE_SCRIPT;
	validateScript(script);
	const caps = fakeCapabilities(options.capabilities);
	const stepDelay = options.stepDelayMs ?? 0;
	let handleCounter = 0;
	const inflight = new Map<string, Promise<ExecRef>>();

	const notify = (run: FakeRun) => {
		const waiters = run.waiters.splice(0);
		for (const wake of waiters) wake();
	};
	const emit = (run: FakeRun, event: ExecEvent) => {
		if (run.done) return;
		run.log.push(event);
		if (isTerminalEvent(event)) run.done = true;
		notify(run);
	};

	async function drive(run: FakeRun, steps: readonly FakeStep[], req: SubmitRequest): Promise<void> {
		for (const step of steps) {
			if (stepDelay > 0) await sleep(stepDelay);
			else await Promise.resolve();
			if (run.done) return;
			if (run.cancelled) {
				emit(run, { type: "failed", class: "permanent", message: "cancelled by request", raw: null });
				return;
			}
			if (!isApprovalStep(step)) {
				emit(run, step);
				continue;
			}
			const answer = new Promise<ApprovalDecision>((resolve) => run.pendingApprovals.set(step.approval.requestId, resolve));
			emit(run, step.approval);
			const decision = await awaitApprovalAnswer(answer, req.approvalPolicy ?? defaultApprovalPolicy());
			run.pendingApprovals.delete(step.approval.requestId);
			run.answeredApprovals.add(step.approval.requestId);
			await drive(run, decision === "allow" ? step.ifAllowed : step.ifDenied, req);
		}
	}

	async function launchAttempt(req: SubmitRequest): Promise<ExecRef> {
		const existing = store.attempts.get(req.attemptKey);
		if (existing?.run !== undefined) return existing.run.ref; // idempotent (B3)
		if (existing?.state === "revoked")
			throw new SdkError("AUTHORITY_REVOKED", `attempt ${req.attemptKey} was revoked`, { subject: req.attemptKey });
		// Consumed in an earlier round without launch evidence: never launch again (design §8.6).
		if (existing?.state === "consumed")
			throw new SdkError("AUTHORITY_ALREADY_CONSUMED", `attempt ${req.attemptKey} already consumed its authority`, {
				subject: req.attemptKey,
			});
		if (!options.faults?.skipConsume) {
			const decision = await req.authority.consume(); // AUTHORITY_ALREADY_CONSUMED blocks duplicates
			if (decision.kind === "revoked") store.attempts.set(req.attemptKey, { state: "revoked" });
			requireReleased(decision); // throws AUTHORITY_REVOKED: exit without any effect
			store.attempts.set(req.attemptKey, { state: "consumed" });
			if (options.faults?.crashAfterConsume) throw new FakeCrashError(`fake crash after consume for ${req.attemptKey}`);
		}
		handleCounter += 1;
		const ref: ExecRef = { executorId: id, attemptKey: req.attemptKey, handle: `${id}-${handleCounter}-${req.attemptKey}` };
		const run: FakeRun = {
			ref,
			log: [],
			done: false,
			cancelled: false,
			waiters: [],
			pendingApprovals: new Map(),
			answeredApprovals: new Set(),
		};
		// The effect: recorded only after a released consume (unless the skipConsume fault is on).
		store.trace.push({ type: "effect", attemptKey: req.attemptKey, executorId: id });
		store.attempts.set(req.attemptKey, { state: "spawned", run });
		void drive(run, script, req).then(() => {
			if (!run.done) emit(run, { type: "failed", class: "unknown", message: "script ended without terminal event", raw: null });
		});
		return ref;
	}

	const findRun = (ref: ExecRef): FakeRun => {
		const run = store.attempts.get(ref.attemptKey)?.run;
		if (run === undefined || run.ref.handle !== ref.handle)
			throw new SdkError("UNKNOWN_EXEC_REF", `unknown exec ref ${ref.attemptKey}/${ref.handle}`, { subject: ref.attemptKey });
		return run;
	};

	const executor: FakeExecutor = {
		id,
		version,
		contractVersion: options.contractVersion ?? EXECUTOR_CONTRACT_VERSION,
		store,
		effectCount: (attemptKey) => store.trace.filter((entry) => entry.type === "effect" && entry.attemptKey === attemptKey).length,
		async probe() {
			return options.probe ?? { installed: true, cliVersion: "fake-cli 1.0.0", auth: "ok" };
		},
		capabilities: () => caps,
		async submit(req) {
			const problems = validateSubmitRequest(req);
			if (problems.length > 0) throw new SdkError("INVALID_REQUEST", `invalid submit request: ${problems.join("; ")}`);
			// Concurrent submits with the same key share one launch (B3 idempotency).
			const pending = inflight.get(req.attemptKey);
			if (pending !== undefined) return pending;
			const launch = launchAttempt(req);
			inflight.set(req.attemptKey, launch);
			try {
				return await launch;
			} finally {
				inflight.delete(req.attemptKey);
			}
		},
		async *observe(ref) {
			const run = findRun(ref);
			let index = 0;
			for (;;) {
				while (index < run.log.length) {
					const event = run.log[index];
					index += 1;
					if (event !== undefined) yield event;
				}
				if (run.done) return;
				await new Promise<void>((resolve) => run.waiters.push(resolve));
			}
		},
		async cancel(ref, _scope: CancelScope) {
			const run = store.attempts.get(ref.attemptKey)?.run;
			if (run === undefined) return "no_active";
			if (options.cancelResult !== undefined) return options.cancelResult;
			if (caps.cancel.level === "none") return "unsupported";
			if (run.done) return "too_late";
			run.cancelled = true;
			for (const resolve of run.pendingApprovals.values()) resolve("deny");
			return "cancelled";
		},
		async reconcile(attemptKey): Promise<ReconcileResult> {
			const attempt = store.attempts.get(attemptKey);
			if (attempt === undefined || attempt.state === "revoked") return { absent: true };
			if (attempt.run !== undefined) return { found: attempt.run.ref };
			return { unknown: true, reason: "authority consumed but no launch evidence" };
		},
		async respond(ref, requestId, decision): Promise<ApprovalResponseResult> {
			const run = findRun(ref);
			const resolve = run.pendingApprovals.get(requestId);
			if (resolve !== undefined) {
				resolve(decision);
				return "accepted";
			}
			return run.answeredApprovals.has(requestId) ? "too_late" : "unknown_request";
		},
	};
	return executor;
}

/**
 * Fencing check over a store trace: every effect must follow a `released` consume for the same
 * attempt, and no attempt may have more than one effect. Returns violations (empty = fenced).
 */
export function verifyFencing(trace: readonly FenceTraceEntry[]): string[] {
	const released = new Set<string>();
	const effects = new Map<string, number>();
	const violations: string[] = [];
	for (const entry of trace) {
		if (entry.type === "consume" && entry.outcome === "released") released.add(entry.attemptKey);
		if (entry.type !== "effect") continue;
		if (!released.has(entry.attemptKey)) violations.push(`effect for ${entry.attemptKey} without released authority`);
		const count = (effects.get(entry.attemptKey) ?? 0) + 1;
		effects.set(entry.attemptKey, count);
		if (count > 1) violations.push(`duplicate effect for ${entry.attemptKey}`);
	}
	return violations;
}

/** Drain an event stream (with a safety cap). */
export async function collectEvents(events: AsyncIterable<ExecEvent>, limit = 10_000): Promise<ExecEvent[]> {
	const collected: ExecEvent[] = [];
	for await (const event of events) {
		collected.push(event);
		if (collected.length >= limit) break;
	}
	return collected;
}

/** Minimal valid submit request for tests. */
export function fakeSubmitRequest(
	gate: AuthorityGate,
	overrides: Partial<Omit<SubmitRequest, "attemptKey" | "authority">> = {},
): SubmitRequest {
	return {
		attemptKey: gate.authority.attemptKey,
		authority: gate.authority,
		cwd: process.cwd(),
		prompt: "fake prompt",
		tools: [],
		readOnly: true,
		mcpServers: [],
		deadlineMs: Date.now() + 60_000,
		env: {},
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		...overrides,
	};
}

/** `ExecutorModule` wrapper so descriptor tests can register or export a fake. Config: `{ id?, version? }`. */
export function createFakeExecutorModule(base: FakeExecutorOptions = {}): ExecutorModule {
	return {
		createExecutor(config: JsonValue) {
			const record = config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
			const id = typeof record.id === "string" ? record.id : base.id;
			const version = typeof record.version === "string" ? record.version : base.version;
			return createFakeExecutor({ ...base, ...(id === undefined ? {} : { id }), ...(version === undefined ? {} : { version }) });
		},
	};
}
