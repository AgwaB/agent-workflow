/**
 * Per-check execution context: session bookkeeping, traced authority, timeouts, stream draining.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultApprovalPolicy } from "../approval.js";
import {
	type AuthorityDecision,
	createAuthorityGate,
	type ExecutionAuthority,
} from "../authority.js";
import type { ExecRef, SubmitRequest, WorkflowExecutor } from "../contract.js";
import {
	type ApprovalRequestEvent,
	type ExecEvent,
	isTerminalEvent,
} from "../events.js";
import type {
	ConformanceHarness,
	ConformanceScenario,
	ConformanceTimeouts,
	HarnessSession,
} from "./types.js";

/** Thrown inside a check to mark it skipped with a reason. */
export class ConformanceSkip extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "ConformanceSkip";
	}
}

export class ConformanceTimeout extends Error {
	constructor(label: string, ms: number) {
		super(`${label} did not settle within ${ms}ms`);
		this.name = "ConformanceTimeout";
	}
}

/** One consume() call observed through a fence probe. */
export interface ConsumeRecord {
	readonly outcome: "released" | "revoked" | "rejected";
	/** Effects the harness had already observed for the attempt when consume() was called. */
	readonly effectsBefore: number;
}

/**
 * Kit-issued one-time authority. Wraps the reference gate and snapshots the harness effect count at
 * every consume() so "effect before consume" and "effect without consume" are both visible (R#1).
 */
export interface FenceProbe {
	readonly attemptKey: string;
	readonly authority: ExecutionAuthority;
	revoke(reason: string): "revoked" | "too_late";
	readonly consumes: readonly ConsumeRecord[];
	released(): number;
}

export function createFenceProbe(
	session: Pick<HarnessSession, "effectCount">,
	attemptKey: string,
): FenceProbe {
	const gate = createAuthorityGate({ attemptKey });
	const consumes: ConsumeRecord[] = [];
	const authority: ExecutionAuthority = {
		attemptKey,
		async consume(): Promise<AuthorityDecision> {
			const effectsBefore = await session.effectCount(attemptKey);
			try {
				const decision = await gate.authority.consume();
				consumes.push({ outcome: decision.kind, effectsBefore });
				return decision;
			} catch (error) {
				consumes.push({ outcome: "rejected", effectsBefore });
				throw error;
			}
		},
	};
	return {
		attemptKey,
		authority,
		revoke: (reason) => gate.revoke(reason),
		consumes,
		released: () =>
			consumes.filter((entry) => entry.outcome === "released").length,
	};
}

/** Race a promise against a timeout. The losing promise keeps running; callers must tolerate that. */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ConformanceTimeout(label, ms)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface DrainResult {
	readonly events: ExecEvent[];
	readonly timedOut: boolean;
	readonly error?: string;
	readonly terminal: ExecEvent | undefined;
}

export interface DrainOptions {
	readonly timeoutMs: number;
	/** Called on each approval request; the stream keeps flowing while it runs. */
	readonly onApproval?: (event: ApprovalRequestEvent) => Promise<void>;
	/** Stop (without timing out) once this returns true. */
	readonly until?: (event: ExecEvent, events: readonly ExecEvent[]) => boolean;
	/**
	 * After the terminal event, keep reading this long to catch events emitted after terminal.
	 * The fake observe ends at terminal; process adapters may not.
	 */
	readonly graceMs?: number;
}

/** Drain `observe(ref)` with a hard timeout; never hangs the kit. */
export async function drain(
	executor: WorkflowExecutor,
	ref: ExecRef,
	options: DrainOptions,
): Promise<DrainResult> {
	const events: ExecEvent[] = [];
	const deadline = Date.now() + options.timeoutMs;
	let iterator: AsyncIterator<ExecEvent> | undefined;
	let terminal: ExecEvent | undefined;
	let graceDeadline: number | undefined;
	const approvals: Promise<void>[] = [];
	try {
		iterator = executor.observe(ref)[Symbol.asyncIterator]();
		for (;;) {
			const limit = graceDeadline ?? deadline;
			const remaining = limit - Date.now();
			if (remaining <= 0) {
				if (graceDeadline !== undefined) break;
				return { events, timedOut: true, terminal };
			}
			let step: IteratorResult<ExecEvent>;
			try {
				step = await withTimeout(iterator.next(), remaining, "observe");
			} catch (error) {
				if (error instanceof ConformanceTimeout) {
					if (graceDeadline !== undefined) break;
					return { events, timedOut: true, terminal };
				}
				throw error;
			}
			if (step.done) break;
			events.push(step.value);
			if (step.value.type === "approval_request" && options.onApproval)
				approvals.push(options.onApproval(step.value));
			if (terminal === undefined && isTerminalEvent(step.value)) {
				terminal = step.value;
				if (!options.graceMs) break;
				graceDeadline = Date.now() + options.graceMs;
			}
			if (options.until?.(step.value, events)) break;
		}
		await Promise.all(approvals);
		return { events, timedOut: false, terminal };
	} catch (error) {
		return {
			events,
			timedOut: false,
			terminal,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		// Do not await: a stuck iterator must not hang the kit.
		void iterator?.return?.()?.catch?.(() => {});
	}
}

let keyCounter = 0;

export class CheckContext {
	readonly harness: ConformanceHarness;
	readonly timeouts: ConformanceTimeouts;
	readonly checkId: string;
	readonly workDir: string;
	private readonly sessions: HarnessSession[] = [];
	private readonly nonce = randomBytes(4).toString("hex");

	constructor(options: {
		harness: ConformanceHarness;
		timeouts: ConformanceTimeouts;
		checkId: string;
		workDir: string;
	}) {
		this.harness = options.harness;
		this.timeouts = options.timeouts;
		this.checkId = options.checkId;
		this.workDir = options.workDir;
	}

	skip(reason: string): never {
		throw new ConformanceSkip(reason);
	}

	supports(scenario: ConformanceScenario): boolean {
		return this.harness.scenarios.includes(scenario);
	}

	/** Open a session; skips the check when the harness cannot stage the scenario. */
	async open(scenario: ConformanceScenario): Promise<HarnessSession> {
		if (!this.supports(scenario))
			this.skip(`harness does not support scenario ${scenario}`);
		const session = await withTimeout(
			this.harness.open(scenario),
			this.timeouts.callMs,
			`open(${scenario})`,
		);
		this.sessions.push(session);
		return session;
	}

	/** Unique attempt key for this check run. */
	key(label: string): string {
		keyCounter += 1;
		return `cf-${this.checkId.replace(/[^a-z0-9]+/gi, "-")}-${label}-${this.nonce}-${keyCounter}`;
	}

	fence(session: HarnessSession, attemptKey: string): FenceProbe {
		return createFenceProbe(session, attemptKey);
	}

	/** Fresh directory under the run's work dir (cwd for requests, stub files, live probes). */
	async dir(label: string): Promise<string> {
		keyCounter += 1;
		const path = join(this.workDir, `${label}-${keyCounter}`);
		await mkdir(path, { recursive: true });
		return path;
	}

	async request(
		probe: Pick<FenceProbe, "attemptKey" | "authority">,
		scenario: ConformanceScenario,
		overrides: Partial<Omit<SubmitRequest, "attemptKey" | "authority">> = {},
	): Promise<SubmitRequest> {
		const base: SubmitRequest = {
			attemptKey: probe.attemptKey,
			authority: probe.authority,
			cwd: overrides.cwd ?? (await this.dir("cwd")),
			prompt: `conformance scenario ${scenario}`,
			tools: [],
			readOnly: true,
			mcpServers: [],
			deadlineMs: Date.now() + this.timeouts.checkMs,
			env: {},
			isolation: { inherit: false },
			approvalPolicy: defaultApprovalPolicy({
				interactive: true,
				timeoutMs: this.timeouts.streamMs,
			}),
			...overrides,
		};
		return this.harness.request?.(base, scenario) ?? base;
	}

	call<T>(promise: Promise<T>, label: string): Promise<T> {
		return withTimeout(promise, this.timeouts.callMs, label);
	}

	drain(
		executor: WorkflowExecutor,
		ref: ExecRef,
		options: Partial<DrainOptions> = {},
	): Promise<DrainResult> {
		return drain(executor, ref, {
			timeoutMs: this.timeouts.streamMs,
			...options,
		});
	}

	async dispose(): Promise<void> {
		for (const session of this.sessions.splice(0))
			await session.dispose?.().catch(() => {});
	}
}
