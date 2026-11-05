// Ported from @agwab/pi-subagent 0.7.2 (pi-subagent-engine ab91a74) src/workers/durable-worker-binding.mjs. MIT, same author. Changes: converted to TypeScript (compiled to dist/runtime/workers/durable-worker-binding.js); env name PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON -> AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON; default runs dir ".agent-workflow/runs". Binding schema ids unchanged.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DEFAULT_RUNS_DIR } from "../core/constants.js";

export const DURABLE_WORKER_BINDING_ENV =
	"AGENT_WORKFLOW_DURABLE_WORKER_BINDING_JSON";

const SHA256 = /^[a-f0-9]{64}$/u;

/** Barrier descriptor fields the binding reads (validated here, not trusted). */
export interface DurableWorkerBindingBarrier {
	schema?: unknown;
	identitySha256?: unknown;
	subjectSha256?: unknown;
	authorityBindingSha256?: unknown;
}

/** The subset of a durable worker launch payload (`worker.json`) the binding reads. */
export interface DurableWorkerBindingPayload {
	runId?: unknown;
	attemptId?: unknown;
	cwd?: unknown;
	input?: {
		durableLaunchBarrier?: DurableWorkerBindingBarrier | null;
		runsDir?: unknown;
		correlationId?: unknown;
		[key: string]: unknown;
	} | null;
}

export interface DurableWorkerBindingAck {
	schema?: unknown;
	readySha256?: unknown;
	decisionSha256?: unknown;
	ackSha256?: unknown;
}

interface DurableWorkerBindingPrepared {
	runId: string;
	attemptId: string;
	correlationId?: string;
	cwdSha256: string;
	runsDirSha256: string;
	workerPid: number;
	launchPayloadSha256: string;
	executionPlanSha256: string;
	barrierIdentitySha256: string;
	barrierSubjectSha256: string;
	authorityBindingSha256?: string;
}

export interface DurableWorkerBindingPreflight
	extends DurableWorkerBindingPrepared {
	schema: "agent-workflow-durable-worker-binding-preflight-v2";
}

export interface DurableWorkerBindingV2 extends DurableWorkerBindingPrepared {
	schema: "agent-workflow-durable-worker-binding-v2";
	readySha256: string;
	decisionSha256: string;
	ackSha256: string;
}

export type DurableWorkerBinding = DurableWorkerBindingV2;

export interface PrepareDurableWorkerBindingOptions {
	payload: DurableWorkerBindingPayload | null | undefined;
	launchPayloadSha256: unknown;
	executionPlanSha256: unknown;
	executionCwd?: unknown;
	workerPid?: number;
}

export interface BuildDurableWorkerBindingOptions
	extends PrepareDurableWorkerBindingOptions {
	ack: DurableWorkerBindingAck | null | undefined;
	preflight?: DurableWorkerBindingPreflight;
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function requireText(label: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0)
		throw new DurableWorkerGuardError(`${label} is required`);
	return value;
}

function optionalText(label: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return requireText(label, value);
}

function requireSha256(label: string, value: unknown): string {
	if (typeof value !== "string" || !SHA256.test(value))
		throw new DurableWorkerGuardError(`${label} must be lowercase SHA-256`);
	return value;
}

export class DurableWorkerGuardError extends Error {
	readonly failureKind: "guard_failure";

	constructor(message: string) {
		super(message);
		this.name = "DurableWorkerGuardError";
		this.failureKind = "guard_failure";
	}
}

export function isDurableWorkerGuardError(
	error: unknown,
): error is DurableWorkerGuardError {
	return error instanceof DurableWorkerGuardError;
}

export function prepareDurableWorkerBinding({
	payload,
	launchPayloadSha256,
	executionPlanSha256,
	executionCwd = payload?.cwd,
	workerPid = process.pid,
}: PrepareDurableWorkerBindingOptions): Readonly<DurableWorkerBindingPreflight> {
	const descriptor = payload?.input?.durableLaunchBarrier;
	if (!descriptor)
		throw new DurableWorkerGuardError("durable launch barrier is required");
	if (!Number.isInteger(workerPid) || workerPid <= 0)
		throw new DurableWorkerGuardError("durable worker pid is invalid");
	const cwd = requireText("worker cwd", payload.cwd);
	const resolvedExecutionCwd = resolve(
		requireText("execution cwd", executionCwd),
	);
	const runsDir = resolve(
		cwd,
		(payload.input?.runsDir as string | undefined) ?? DEFAULT_RUNS_DIR,
	);
	const correlationId = optionalText(
		"subagent correlation id",
		payload.input?.correlationId,
	);
	const authorityBindingSha256 = descriptor.authorityBindingSha256;
	if (authorityBindingSha256 !== undefined)
		requireSha256("authority binding", authorityBindingSha256);
	if (descriptor.schema !== "agent-workflow-durable-launch-barrier-v2")
		throw new DurableWorkerGuardError("durable launch barrier v2 is required");
	return Object.freeze({
		schema: "agent-workflow-durable-worker-binding-preflight-v2",
		runId: requireText("subagent run id", payload.runId),
		attemptId: requireText("subagent attempt id", payload.attemptId),
		...(correlationId === undefined ? {} : { correlationId }),
		cwdSha256: sha256Text(resolvedExecutionCwd),
		runsDirSha256: sha256Text(runsDir),
		workerPid,
		launchPayloadSha256: requireSha256(
			"launch payload digest",
			launchPayloadSha256,
		),
		executionPlanSha256: requireSha256(
			"execution plan digest",
			executionPlanSha256,
		),
		barrierIdentitySha256: requireSha256(
			"barrier identity",
			descriptor.identitySha256,
		),
		barrierSubjectSha256: requireSha256(
			"barrier subject",
			descriptor.subjectSha256,
		),
		...(authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: authorityBindingSha256 as string }),
	});
}

export function buildDurableWorkerBinding(
	options: BuildDurableWorkerBindingOptions,
): Readonly<DurableWorkerBinding> {
	const {
		payload,
		launchPayloadSha256,
		executionPlanSha256,
		ack,
		workerPid = process.pid,
	} = options;
	const preflight =
		options.preflight ??
		prepareDurableWorkerBinding({
			payload,
			launchPayloadSha256,
			executionPlanSha256,
			workerPid,
		});
	if (preflight.schema !== "agent-workflow-durable-worker-binding-preflight-v2")
		throw new DurableWorkerGuardError(
			"durable worker binding v2 preflight is required",
		);
	const { schema: _schema, ...prepared } = preflight;
	if (ack?.schema !== "agent-workflow-durable-launch-barrier-ack-v2")
		throw new DurableWorkerGuardError(
			"durable launch barrier v2 acknowledgement is required",
		);
	return Object.freeze({
		schema: "agent-workflow-durable-worker-binding-v2",
		...prepared,
		readySha256: requireSha256("ready digest", ack.readySha256),
		decisionSha256: requireSha256(
			"release decision digest",
			ack.decisionSha256,
		),
		ackSha256: requireSha256("ack digest", ack.ackSha256),
	});
}

export function executionInputAfterDurableLaunch<
	T extends { durableLaunchBarrier?: unknown },
>(
	input: T | null | undefined,
): Readonly<
	Omit<T, "async" | "onComplete" | "durableLaunchBarrier"> & {
		async: false;
		onComplete: undefined;
		durableLaunchBarrier: undefined;
	}
> {
	if (!input?.durableLaunchBarrier)
		throw new DurableWorkerGuardError(
			"durable launch barrier is required before execution",
		);
	return Object.freeze({
		...input,
		async: false as const,
		onComplete: undefined,
		durableLaunchBarrier: undefined,
	});
}

export function installDurableWorkerBinding(
	options: BuildDurableWorkerBindingOptions,
): Readonly<DurableWorkerBinding> {
	// Build a run-scoped value for explicit runner handoff. Never mutate the
	// parent process environment: nested/barrierless inline runs share it.
	return buildDurableWorkerBinding(options);
}
