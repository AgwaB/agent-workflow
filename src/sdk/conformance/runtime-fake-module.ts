/**
 * Executor module for the runtime-tier conformance checks over the SDK fake (WP2b). The durable
 * runtime reloads executors from their descriptor in a fresh process (R#15), so the fake harness's
 * runtime stage points its descriptor at this module (absolute path of the compiled file). Effects,
 * consumes, cancels and reconciles are appended to a JSONL effect log so the checking process can
 * count effects that happened in the worker process.
 *
 * Config: `{ effectLog, scenario, id?, version?, stepDelayMs?, faults? }` where faults are injected
 * adapter bugs for the kit's negative tests: `skipConsume` (launch without consuming),
 * `reconcileAbsent` (claim `absent` although an effect was logged), `ignoreDeny` (answer every
 * approval `allow`).
 */
import { appendFileSync, readFileSync } from "node:fs";
import type {
	ExecRef,
	ReconcileResult,
	SubmitRequest,
	WorkflowExecutor,
} from "../contract.js";
import type { JsonValue } from "../json.js";
import { createFakeExecutor } from "../testing/fake-executor.js";
import { FAKE_SCENARIO_SCRIPTS } from "./harness-fake.js";
import { CONFORMANCE_SCENARIOS, type ConformanceScenario } from "./types.js";

export interface RuntimeFakeFaults {
	readonly skipConsume?: boolean;
	readonly reconcileAbsent?: boolean;
	readonly ignoreDeny?: boolean;
}

export interface RuntimeFakeConfig {
	readonly effectLog: string;
	readonly scenario: ConformanceScenario;
	readonly id?: string;
	readonly version?: string;
	readonly stepDelayMs?: number;
	readonly faults?: RuntimeFakeFaults;
}

export interface RuntimeFakeLogEntry {
	readonly type: "submit" | "consume" | "effect" | "cancel" | "reconcile";
	readonly attemptKey: string;
	readonly pid: number;
	readonly [key: string]: unknown;
}

/** Slow enough that cancel and kill interleave with a running attempt in another process. */
const RUNTIME_STEP_DELAY_MS: Partial<Record<ConformanceScenario, number>> = {
	slow: 100,
};

export function readRuntimeFakeLog(effectLog: string): RuntimeFakeLogEntry[] {
	let text: string;
	try {
		text = readFileSync(effectLog, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as RuntimeFakeLogEntry];
			} catch {
				return [];
			}
		});
}

function parseConfig(config: JsonValue): RuntimeFakeConfig {
	const record =
		config !== null && typeof config === "object" && !Array.isArray(config)
			? config
			: {};
	if (typeof record.effectLog !== "string")
		throw new Error("runtime fake module needs config.effectLog");
	const scenario = record.scenario;
	if (
		typeof scenario !== "string" ||
		!(CONFORMANCE_SCENARIOS as readonly string[]).includes(scenario)
	)
		throw new Error("runtime fake module needs a conformance config.scenario");
	const faults =
		record.faults !== null &&
		typeof record.faults === "object" &&
		!Array.isArray(record.faults)
			? record.faults
			: {};
	return {
		effectLog: record.effectLog,
		scenario: scenario as ConformanceScenario,
		...(typeof record.id === "string" ? { id: record.id } : {}),
		...(typeof record.version === "string" ? { version: record.version } : {}),
		...(typeof record.stepDelayMs === "number"
			? { stepDelayMs: record.stepDelayMs }
			: {}),
		faults: {
			skipConsume: faults.skipConsume === true,
			reconcileAbsent: faults.reconcileAbsent === true,
			ignoreDeny: faults.ignoreDeny === true,
		},
	};
}

export function createExecutor(config: JsonValue): WorkflowExecutor {
	const parsed = parseConfig(config);
	const log = (entry: Omit<RuntimeFakeLogEntry, "pid">) =>
		appendFileSync(
			parsed.effectLog,
			`${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
		);
	const stepDelayMs =
		parsed.stepDelayMs ?? RUNTIME_STEP_DELAY_MS[parsed.scenario];
	const inner = createFakeExecutor({
		...(parsed.id === undefined ? {} : { id: parsed.id }),
		...(parsed.version === undefined ? {} : { version: parsed.version }),
		script: FAKE_SCENARIO_SCRIPTS[parsed.scenario],
		...(stepDelayMs === undefined ? {} : { stepDelayMs }),
		faults: { skipConsume: parsed.faults?.skipConsume === true },
	});
	return {
		id: inner.id,
		version: inner.version,
		contractVersion: inner.contractVersion,
		probe: () => inner.probe(),
		capabilities: () => inner.capabilities(),
		async submit(req: SubmitRequest): Promise<ExecRef> {
			const attemptKey = req.attemptKey;
			log({ type: "submit", attemptKey });
			const authority = {
				attemptKey: req.authority.attemptKey,
				async consume() {
					const decision = await req.authority.consume();
					log({ type: "consume", attemptKey, outcome: decision.kind });
					return decision;
				},
			};
			const before = inner.effectCount(attemptKey);
			try {
				return await inner.submit({ ...req, authority });
			} finally {
				if (inner.effectCount(attemptKey) > before)
					log({ type: "effect", attemptKey });
			}
		},
		observe: (ref) => inner.observe(ref),
		async cancel(ref, scope) {
			const result = await inner.cancel(ref, scope);
			log({ type: "cancel", attemptKey: ref.attemptKey, scope, result });
			return result;
		},
		async reconcile(attemptKey): Promise<ReconcileResult> {
			let result: ReconcileResult;
			if (inner.store.attempts.has(attemptKey))
				result = await inner.reconcile(attemptKey);
			else {
				// The attempt ran in a process that is gone: decide from the durable log (B3).
				const entries = readRuntimeFakeLog(parsed.effectLog).filter(
					(entry) => entry.attemptKey === attemptKey,
				);
				const effect = entries.some((entry) => entry.type === "effect");
				const consumed = entries.some(
					(entry) => entry.type === "consume" && entry.outcome === "released",
				);
				result =
					(effect || consumed) && parsed.faults?.reconcileAbsent !== true
						? {
								unknown: true,
								reason: "effect logged by a process that is gone",
							}
						: { absent: true };
			}
			log({ type: "reconcile", attemptKey, result });
			return result;
		},
		respond: (ref, requestId, decision) =>
			inner.respond(
				ref,
				requestId,
				parsed.faults?.ignoreDeny === true ? "allow" : decision,
			),
	};
}
