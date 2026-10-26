/**
 * Conformance harness over the SDK fake executor. Proves the offline catalog end to end and is the
 * template for adapter harnesses: map each scenario to a staged executor, count effects, restart.
 * `wrap` lets tests inject adapter bugs (the kit's negative tests use it).
 */
import {
	EXECUTOR_CONTRACT_VERSION,
	type WorkflowExecutor,
} from "../contract.js";
import { createExecutorRegistry } from "../descriptor.js";
import type { FailureClass } from "../errors.js";
import type { ExecEvent } from "../events.js";
import {
	createFakeExecutor,
	createFakeExecutorModule,
	createFakeStore,
	type FakeExecutor,
	type FakeExecutorOptions,
	type FakeExecutorStore,
	type FakeStep,
} from "../testing/fake-executor.js";
import {
	CONFORMANCE_SCENARIOS,
	type ConformanceHarness,
	type ConformanceScenario,
	type HarnessSession,
} from "./types.js";

export interface FakeHarnessContext {
	readonly scenario: ConformanceScenario;
	readonly store: FakeExecutorStore;
	/** 0 for the first instance of a session, then 1, 2, … per `restart()`. */
	readonly generation: number;
}

export interface FakeHarnessOptions {
	readonly name?: string;
	/** Base fake options (id, version, capabilities, probe, cancelResult). */
	readonly executor?: Omit<
		FakeExecutorOptions,
		"script" | "store" | "faults" | "stepDelayMs"
	>;
	/** Replace the script of individual scenarios. */
	readonly scripts?: Partial<Record<ConformanceScenario, readonly FakeStep[]>>;
	/** Extra fault flags per scenario (merged over the scenario defaults). */
	readonly faults?: Partial<
		Record<ConformanceScenario, FakeExecutorOptions["faults"]>
	>;
	/** Restrict the scenarios the harness claims to support. */
	readonly scenarios?: readonly ConformanceScenario[];
	/** Wrap every executor instance (bug injection, extra behaviour). */
	readonly wrap?: (
		executor: FakeExecutor,
		context: FakeHarnessContext,
	) => WorkflowExecutor;
	/** Expose a registry-backed descriptor for `descriptor.reload`. Default true. */
	readonly descriptor?: boolean;
}

const usage = (cost: number | null): ExecEvent =>
	cost === null
		? {
				type: "usage",
				input: 12,
				output: 4,
				cached: 0,
				cost: null,
				source: "unknown",
			}
		: {
				type: "usage",
				input: 12,
				output: 4,
				cached: 0,
				cost,
				source: "reported",
			};

const COMPLETE: readonly FakeStep[] = [
	{ type: "started", sessionId: null },
	{ type: "message_delta", text: "conformance " },
	{ type: "message_delta", text: "ok" },
	usage(0.0001),
	{ type: "completed", finalText: "conformance ok" },
];

const failing = (failureClass: FailureClass, message: string): FakeStep[] => [
	{ type: "started", sessionId: null },
	{
		type: "failed",
		class: failureClass,
		message,
		raw: { stderr: message },
	},
];

/** Default fake script for each scenario (see docs/conformance.md for scenario contracts). */
export const FAKE_SCENARIO_SCRIPTS: Readonly<
	Record<ConformanceScenario, readonly FakeStep[]>
> = {
	complete: COMPLETE,
	usage_unknown: [
		{ type: "started", sessionId: null },
		{ type: "message_delta", text: "no cost reported" },
		usage(null),
		{ type: "completed", finalText: "no cost reported" },
	],
	slow: [
		{ type: "started", sessionId: null },
		...Array.from(
			{ length: 150 },
			(): FakeStep => ({ type: "message_delta", text: "." }),
		),
		{ type: "completed", finalText: "slow done" },
	],
	approval: [
		{ type: "started", sessionId: null },
		{
			approval: {
				type: "approval_request",
				requestId: "conformance-approval-1",
				kind: "execute",
				detail: "run: echo conformance",
			},
			ifAllowed: [
				{
					type: "tool_call",
					name: "bash",
					kind: "execute",
					status: "completed",
					callId: "call-1",
					output: "conformance",
				},
				{ type: "completed", finalText: "approval:allow" },
			],
			ifDenied: [
				{
					type: "tool_call",
					name: "bash",
					kind: "execute",
					status: "denied",
					callId: "call-1",
				},
				{ type: "completed", finalText: "approval:deny" },
			],
		},
	],
	crash_after_consume: COMPLETE,
	mcp_tool: COMPLETE,
	fail_transient: failing("transient", "upstream connection reset (502)"),
	fail_rate_limit: failing("rate_limit", "429 Too Many Requests"),
	fail_auth: failing("auth", "not logged in: run login first"),
	fail_config: failing("config", "unknown model: conformance-x"),
	fail_permanent: failing("permanent", "request rejected: context too long"),
	fail_unknown: failing("unknown", "the flux capacitor overheated"),
};

const STEP_DELAY_MS: Partial<Record<ConformanceScenario, number>> = {
	slow: 20,
};

const DEFAULT_FAULTS: Partial<
	Record<ConformanceScenario, FakeExecutorOptions["faults"]>
> = {
	crash_after_consume: { crashAfterConsume: true },
};

export const FAKE_DESCRIPTOR_MODULE = "agent-workflow:conformance-fake";

/** Stop any still-running fake runs so their timers do not outlive the check. */
function stopRuns(store: FakeExecutorStore): void {
	for (const attempt of store.attempts.values()) {
		const run = (attempt as { run?: { cancelled: boolean } }).run;
		if (run !== undefined) run.cancelled = true;
	}
}

export function createFakeHarness(
	options: FakeHarnessOptions = {},
): ConformanceHarness {
	const base = options.executor ?? {};
	const build = (
		scenario: ConformanceScenario,
		store: FakeExecutorStore,
		generation: number,
	): WorkflowExecutor => {
		const faults = {
			...DEFAULT_FAULTS[scenario],
			...options.faults?.[scenario],
		};
		const stepDelayMs = STEP_DELAY_MS[scenario];
		const fake = createFakeExecutor({
			...base,
			script: options.scripts?.[scenario] ?? FAKE_SCENARIO_SCRIPTS[scenario],
			store,
			faults,
			...(stepDelayMs === undefined ? {} : { stepDelayMs }),
		});
		return options.wrap?.(fake, { scenario, store, generation }) ?? fake;
	};
	const effects = (store: FakeExecutorStore, attemptKey?: string) =>
		store.trace.filter(
			(entry) =>
				entry.type === "effect" &&
				(attemptKey === undefined || entry.attemptKey === attemptKey),
		).length;

	const harness: ConformanceHarness = {
		name: options.name ?? "fake",
		scenarios: options.scenarios ?? CONFORMANCE_SCENARIOS,
		async open(scenario): Promise<HarnessSession> {
			const store = createFakeStore();
			let generation = 0;
			return {
				executor: build(scenario, store, generation),
				effectCount: async (attemptKey) => effects(store, attemptKey),
				restart: async () => {
					generation += 1;
					return build(scenario, store, generation);
				},
				dispose: async () => stopRuns(store),
			};
		},
	};
	if (options.descriptor === false) return harness;
	return {
		...harness,
		async descriptor() {
			const registry = createExecutorRegistry();
			registry.register(FAKE_DESCRIPTOR_MODULE, createFakeExecutorModule(base));
			return {
				descriptor: {
					id: base.id ?? "fake",
					version: base.version ?? "0.1.0",
					contractVersion: base.contractVersion ?? EXECUTOR_CONTRACT_VERSION,
					module: FAKE_DESCRIPTOR_MODULE,
					config: null,
				},
				registry,
			};
		},
	};
}
