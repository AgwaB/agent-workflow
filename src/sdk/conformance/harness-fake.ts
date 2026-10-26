/**
 * Conformance harness over the SDK fake executor. Proves the offline catalog end to end and is the
 * template for adapter harnesses: map each scenario to a staged executor, count effects, restart.
 * `wrap` lets tests inject adapter bugs (the kit's negative tests use it).
 * WP2b: `runtime(scenario)` stages the same scripts for the runtime tier through
 * `runtime-fake-module.js` (reloadable in a fresh process, effects in a JSONL log).
 */
import {
	EXECUTOR_CONTRACT_VERSION,
	type ExecRef,
	type SubmitRequest,
	type WorkflowExecutor,
} from "../contract.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { MCP_NONCE_PATTERN } from "./checks-mcp.js";
import {
	readRuntimeFakeLog,
	type RuntimeFakeFaults,
} from "./runtime-fake-module.js";
import { callMcpTool } from "./mcp-client.js";
import { STUB_MCP_SERVER_NAME } from "./stub-mcp.js";
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
	/**
	 * MCP output limit the fake "CLI" enforces and reports from probe(). Default 4096; null = unknown.
	 * Ignored when `executor.probe` is given (its value is used instead).
	 */
	readonly mcpOutputLimitChars?: number | null;
	/**
	 * Runtime tier (WP2b): stage scenarios in `runtime-fake-module.js`, which a durable worker
	 * reloads in a fresh process; effects are counted from its JSONL effect log. `false` disables
	 * the runtime stage. `faults` inject adapter bugs per scenario (negative tests).
	 */
	readonly runtime?:
		| false
		| {
				readonly faults?: Partial<
					Record<ConformanceScenario, RuntimeFakeFaults>
				>;
		  };
}

/** Absolute path of the compiled runtime fake module (what runtime-tier descriptors name). */
export const RUNTIME_FAKE_MODULE = fileURLToPath(
	new URL("./runtime-fake-module.js", import.meta.url),
);

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

interface McpCalls {
	readonly requests: Map<string, SubmitRequest>;
	readonly results: Map<string, Promise<ExecEvent[]>>;
}

async function fakeMcpCall(
	req: SubmitRequest | undefined,
	limit: number | null,
): Promise<ExecEvent[]> {
	const spec =
		req?.mcpServers.find((server) => server.name === STUB_MCP_SERVER_NAME) ??
		req?.mcpServers[0];
	const nonce = MCP_NONCE_PATTERN.exec(req?.prompt ?? "")?.[1];
	if (req === undefined || spec === undefined || nonce === undefined) return [];
	const name = `mcp__${spec.name}__echo`;
	try {
		const result = await callMcpTool(
			spec,
			"echo",
			{ text: nonce },
			{ cwd: req.cwd },
		);
		const output = limit === null ? result.text : result.text.slice(0, limit);
		return [
			{
				type: "tool_call",
				name,
				kind: "other",
				status: result.isError ? "failed" : "completed",
				callId: "mcp-1",
				input: { text: nonce },
				output,
			},
		];
	} catch (error) {
		return [
			{
				type: "tool_call",
				name,
				kind: "other",
				status: "failed",
				callId: "mcp-1",
				output: error instanceof Error ? error.message : String(error),
			},
		];
	}
}

/**
 * `mcp_tool` stand-in for a CLI that calls injected MCP tools: after `started`, the fake acts as the
 * MCP client for the request's `conformance` server (only after a released submit, i.e. after the
 * effect) and reports the echo result, truncated to the fake CLI's output limit.
 */
function withFakeMcpCalls(
	fake: FakeExecutor,
	calls: McpCalls,
	limit: number | null,
): WorkflowExecutor {
	const resultFor = (ref: ExecRef) => {
		let result = calls.results.get(ref.attemptKey);
		if (result === undefined) {
			result = fakeMcpCall(calls.requests.get(ref.attemptKey), limit);
			calls.results.set(ref.attemptKey, result);
		}
		return result;
	};
	return {
		...fake,
		async submit(req) {
			const ref = await fake.submit(req);
			if (!calls.requests.has(req.attemptKey))
				calls.requests.set(req.attemptKey, req);
			return ref;
		},
		async *observe(ref) {
			for await (const event of fake.observe(ref)) {
				yield event;
				if (event.type === "started") yield* await resultFor(ref);
			}
		},
	};
}

export function createFakeHarness(
	options: FakeHarnessOptions = {},
): ConformanceHarness {
	const limit =
		options.mcpOutputLimitChars === undefined
			? 4096
			: options.mcpOutputLimitChars;
	const base = {
		...options.executor,
		probe: options.executor?.probe ?? {
			installed: true,
			cliVersion: "fake-cli 1.0.0",
			auth: "ok" as const,
			mcpOutputLimitChars: limit,
		},
	};
	const effectiveLimit = base.probe.mcpOutputLimitChars ?? null;
	const build = (
		scenario: ConformanceScenario,
		store: FakeExecutorStore,
		generation: number,
		calls: McpCalls,
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
		const staged =
			scenario === "mcp_tool"
				? (withFakeMcpCalls(fake, calls, effectiveLimit) as FakeExecutor)
				: fake;
		return options.wrap?.(staged, { scenario, store, generation }) ?? staged;
	};
	const effects = (store: FakeExecutorStore, attemptKey?: string) =>
		store.trace.filter(
			(entry) =>
				entry.type === "effect" &&
				(attemptKey === undefined || entry.attemptKey === attemptKey),
		).length;

	// Not readonly: the runtime stage is attached below unless disabled.
	const harness: {
		-readonly [K in keyof ConformanceHarness]: ConformanceHarness[K];
	} = {
		name: options.name ?? "fake",
		scenarios: options.scenarios ?? CONFORMANCE_SCENARIOS,
		async open(scenario): Promise<HarnessSession> {
			const store = createFakeStore();
			const calls: McpCalls = { requests: new Map(), results: new Map() };
			let generation = 0;
			return {
				executor: build(scenario, store, generation, calls),
				effectCount: async (attemptKey) => effects(store, attemptKey),
				restart: async () => {
					generation += 1;
					return build(scenario, store, generation, calls);
				},
				dispose: async () => stopRuns(store),
			};
		},
	};
	if (options.runtime !== false) {
		const runtimeFaults =
			options.runtime === undefined ? undefined : options.runtime.faults;
		harness.runtime = async (scenario, { workDir }) => {
			await mkdir(workDir, { recursive: true });
			const effectLog = join(workDir, "effects.jsonl");
			return {
				descriptor: {
					id: base.id ?? "fake",
					version: base.version ?? "0.1.0",
					contractVersion: base.contractVersion ?? EXECUTOR_CONTRACT_VERSION,
					module: RUNTIME_FAKE_MODULE,
					config: {
						effectLog,
						scenario,
						...(base.id === undefined ? {} : { id: base.id }),
						...(base.version === undefined ? {} : { version: base.version }),
						faults: { ...runtimeFaults?.[scenario] },
					},
				},
				effectCount: async (attemptKey) =>
					readRuntimeFakeLog(effectLog).filter(
						(entry) =>
							entry.type === "effect" &&
							(attemptKey === undefined || entry.attemptKey === attemptKey),
					).length,
			};
		};
	}
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
